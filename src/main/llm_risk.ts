import { generateText, type LanguageModelUsage } from 'ai'
import { fallbackRiskModel, riskModel } from './llm_model'
import { bskTabUrl } from './llm_shell'

export type Risk = { level: 'safe' | 'risk'; reason: string }

type Tokens = { inputTokens: number; outputTokens: number }

// One rule text for both checkers, so the decider and Jev judge alike.
const safeRule =
  'Any one of these: read-only or harmless, e.g. listing or reading files, printing, calculations, network diagnostics like ping. Creating or writing new files of any type except .exe, .sh or .bat. Changing or overwriting a file that one of earlier_commands_of_this_task created or copied, except .exe, .sh or .bat. The bsk browser CLI used to read, look or move around: bsk browsers, status, doctor, session start/stop/list, tab list/create/borrow/return, navigate to an http(s) URL, observe, snapshot, get-html, extract, screenshot, scroll-to, wheel, hover, click, focus, blur, wait-ms, wait-for-element, sleep, --help on any bsk command, and bsk evaluate whose JavaScript only reads the page (querySelector/querySelectorAll, innerText, textContent, getAttribute, href, map, filter, slice, JSON.stringify). On facebook.com only, also bsk fill (typing, e.g. into the search box) and bsk press of keys other than Enter. Commands chained with ; or && when every part is safe. A read-only GET request with curl to https://skills.sh/api/search (searching the skills directory), optionally piped into a command that only parses or prints the result.'
const riskRule =
  'Any one of these: creating or writing .exe, .sh or .bat files. Installing, upgrading or removing any package or program (pip, npm, npx, winget, choco, installers), always. bsk actions that type, send or change data: fill, press, select, upload, download (fill and press are safe on facebook.com only), and anything that submits a form, on facebook.com too: posting, commenting, sending a message, pressing Enter in a form. bsk evaluate whose JavaScript changes the page or acts: assigning to anything, .click(), .submit(), dispatchEvent, fetch or XMLHttpRequest, location, cookies or localStorage, filling form fields. A chain with ; or && when any part is risky. Anything else, e.g. changing, overwriting, moving or deleting existing files, changing settings, uploading or downloading data, running downloaded code, touching credentials or personal files, or anything hard to understand.'

// Deterministic pre-check: a Bash command made only of read-only bsk commands and sleep is SAFE without a
// model. Anything it does not recognise goes to the models as before.

// Words of each command of a chain joined by ; && or newlines; null when bash could do more than run them
// (pipes, redirects, $ or backtick expansion, globs, backslash escapes...).
function splitChain(line: string): string[][] | null {
  const cmds: string[][] = [[]]
  let word: string | null = null
  const endWord = (): void => {
    if (word !== null) cmds[cmds.length - 1].push(word)
    word = null
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const j = line.indexOf("'", i + 1)
      if (j < 0) return null
      word = (word ?? '') + line.slice(i + 1, j)
      i = j
    } else if (c === '"') {
      let s = ''
      for (i++; line[i] !== '"'; i++) {
        if (i >= line.length || line[i] === '$' || line[i] === '`') return null
        if (line[i] === '\\' && i + 1 < line.length && '"\\'.includes(line[i + 1])) i++
        s += line[i]
      }
      word = (word ?? '') + s
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === ';' || c === '\n' || (c === '&' && line[i + 1] === '&')) {
      endWord()
      if (c === '&') i++
      cmds.push([])
    } else if (/[\w@%+=:,./-]/.test(c)) word = (word ?? '') + c
    else return null
  }
  endWord()
  return cmds.filter((w) => w.length)
}

// The value of option `name` (`--name v` or `--name=v`).
function opt(w: string[], name: string): string | undefined {
  for (let i = 0; i < w.length; i++) {
    if (w[i] === name) return w[i + 1]
    if (w[i].startsWith(`${name}=`)) return w[i].slice(name.length + 1)
  }
  return undefined
}

// Positional words from w[2] on; null on an option that is neither in `valued` (takes a value) nor a plain flag.
function positionals(w: string[], valued: string[]): string[] | null {
  const out: string[] = []
  for (let i = 2; i < w.length; i++) {
    if (!w[i].startsWith('-')) out.push(w[i])
    else if (valued.includes(w[i])) i++
    else if (!/^(--json|--quiet|--verbose|--no-clear|-v+)$/.test(w[i]) && !valued.includes(w[i].split('=')[0]))
      return null
  }
  return out
}

// Names a read-only evaluate may use: functions it may call, properties it may read, and bare globals/keywords.
const jsCalls = new Set(
  'querySelector querySelectorAll getElementById getElementsByTagName getElementsByClassName getElementsByName closest matches contains getAttribute hasAttribute getAttributeNames getBoundingClientRect getComputedStyle item from isArray keys values entries fromEntries stringify parse map filter find findIndex some every forEach flatMap flat reduce slice concat join includes indexOf lastIndexOf at trim trimStart trimEnd split startsWith endsWith toLowerCase toUpperCase substring padStart padEnd charAt toString toFixed max min round floor ceil abs String Number Boolean parseInt parseFloat isNaN'.split(
    ' '
  )
)
const jsProps = new Set(
  'innerText textContent innerHTML outerHTML href src currentSrc alt title value id className tagName nodeName nodeType children childNodes parentElement parentNode firstElementChild lastElementChild nextElementSibling previousElementSibling length checked disabled selected selectedIndex options rows cells name type placeholder label body head documentElement forms links images URL readyState rel target dateTime ariaLabel hidden isConnected offsetWidth offsetHeight offsetTop offsetLeft clientWidth clientHeight scrollHeight scrollWidth scrollTop scrollLeft width height top left right bottom x y naturalWidth naturalHeight'.split(
    ' '
  )
)
const jsNames = new Set(
  'document JSON Array Object Math Number String Boolean parseInt parseFloat isNaN getComputedStyle undefined null true false NaN Infinity return typeof instanceof in of await async'.split(
    ' '
  )
)

// True when a bsk evaluate expression only reads the page: no assignment, no ++/--, no computed property,
// no template/regex/comment, and every name is a listed read-only one or an arrow-function parameter.
// ponytail: a screen, not a JS parser. Parameter names are not scoped, so one reused outside its arrow could
// pass a page's own global function as a callback; that is no more than the bsk click this file allows.
function readOnlyJs(js: string): boolean {
  // Strings become '' so their text is not read as code.
  let code = ''
  for (let i = 0; i < js.length; i++) {
    const q = js[i]
    if (q !== "'" && q !== '"') {
      code += q
      continue
    }
    for (i++; js[i] !== q; i++) {
      if (i >= js.length) return false
      if (js[i] === '\\') i++
    }
    code += "''"
  }
  // Printable ASCII only outside strings, so no line breaks or non-ASCII names either.
  if (/[^ -~]|[`\\/]|\+\+|--|[<>]{2}=/.test(code)) return false
  if (code.replace(/[=!]==?|[<>]=|=>/g, '').includes('=')) return false
  // x[...] other than x[0], and calls of anything but a plain name: f()(), x[0](), x?.().
  if (/[\w$)\]'.]\s*\[(?!\d+\])|[)\]'.]\s*\(/.test(code)) return false
  const params = new Set<string>()
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) params.add(m[1])
  for (const m of code.matchAll(/\(([\w$\s,]*)\)\s*=>/g)) m[1].split(',').forEach((p) => params.add(p.trim()))
  for (const m of code.matchAll(/\d[\w.]*|[A-Za-z_$][\w$]*/g)) {
    const name = m[0]
    if (/^\d/.test(name)) continue
    const before = code.slice(0, m.index).trimEnd()
    const after = code.slice(m.index + name.length).trimStart()
    const call = after.startsWith('(')
    const ok =
      before.endsWith('.') && !before.endsWith('...')
        ? jsCalls.has(name) || (!call && jsProps.has(name))
        : call
          ? jsNames.has(name)
          : jsNames.has(name) || params.has(name) || (/[{,]$/.test(before) && after.startsWith(':'))
    if (!ok) return false
  }
  return true
}

const bskReads = new Set(
  'status browsers observe snapshot get-html extract screenshot wheel scroll-to hover click wait-ms wait-for-element wait-for-navigation console help'.split(
    ' '
  )
)
// Commands that leave the tab on its page, so a later fill/press still acts on the URL looked up for it.
const staysOnPage = new Set(
  'sleep status browsers observe snapshot get-html extract screenshot wheel scroll-to hover wait-ms wait-for-element console evaluate fill'.split(
    ' '
  )
)

// fill and press are SAFE on facebook.com (pressing Enter counts as submitting); the tab's URL comes from bsk.
async function onFacebook(w: string[]): Promise<boolean> {
  const session = opt(w, '--session')
  const tab = opt(w, '--tab-id')
  if (!session || !tab) return false
  try {
    const host = new URL((await bskTabUrl(session, tab)) ?? '').hostname
    return host === 'facebook.com' || host.endsWith('.facebook.com')
  } catch {
    return false
  }
}

async function partSafe(w: string[], samePage: boolean): Promise<boolean> {
  if (w[0] === 'sleep') return w.length === 2 && /^\d+(\.\d+)?[smh]?$/.test(w[1])
  if (w[0] !== 'bsk' || !w[1]) return false
  if (w.includes('--help') || w.includes('-h')) return true
  if (w.some((x) => x.startsWith('--out'))) return false
  // http(s) only: javascript: and data: URLs run code in the page.
  const urlsOk = w.every((x) => !x.includes(':') || /^https?:\/\//i.test(x))
  const sub = w[1]
  if (bskReads.has(sub)) return true
  if (sub === 'navigate') return urlsOk
  if (sub === 'session') return ['start', 'stop', 'list'].includes(w[2])
  if (sub === 'tab') return urlsOk && ['list', 'create', 'borrow', 'return'].includes(w[2])
  if (sub === 'evaluate') {
    const p = positionals(w, ['--session', '--tab-id', '--timeout', '--await-promise', '--return-by-value'])
    return p?.length === 1 && readOnlyJs(p[0])
  }
  if (sub === 'fill') {
    const p = positionals(w, ['--value', '--ref', '--selector', '--session', '--tab-id', '--timeout'])
    return !!p && p.length <= 1 && !/[\r\n]/.test(opt(w, '--value') ?? '') && samePage && onFacebook(w)
  }
  if (sub === 'press') {
    const p = positionals(w, ['--session', '--tab-id', '--modifiers', '--ref', '--selector', '--hold-ms', '--timeout'])
    return p?.length === 1 && !/enter|return/i.test(p[0]) && samePage && onFacebook(w)
  }
  return false
}

// SAFE when every command of the chain is; fill/press only before anything that may leave the page.
async function bskChainSafe(command: string): Promise<boolean> {
  const parts = splitChain(command)
  if (!parts?.length) return false
  let samePage = true
  for (const w of parts) {
    if (!(await partSafe(w, samePage))) return false
    samePage &&= staysOnPage.has(w[0] === 'sleep' ? 'sleep' : w[1])
  }
  return true
}

const question = {
  type: 'choice',
  instructions:
    "An AI agent wants to run `command` with the tool `tool` (Git Bash, Python or Node.js) on the user's Windows computer. `earlier_commands_of_this_task` are the commands already run for the same user request. Decide whether `command` can run without asking the user. Choose safe only when it clearly matches the safe criteria; otherwise choose risk.",
  criteria: { safe: safeRule, risk: riskRule }
}

const system = `You review a command or script that an AI agent wants to run on the user's Windows computer (Git Bash, Python or Node.js). Decide whether it can run without asking the user. Answer SAFE only when it clearly matches the SAFE rule; otherwise answer RISK. earlier_commands_of_this_task are the commands already run for the same user request.
SAFE: ${safeRule}
RISK: ${riskRule}
Answer with exactly one line that starts with SAFE or RISK, a colon, then the reason in Thai (at most 20 words), for example:
SAFE: อ่านไฟล์อย่างเดียว ไม่แก้ไขอะไร`

type Decision = {
  answers?: { risk?: { type?: string; choice?: string; probabilities?: { risk?: number } } }
  usage?: { input_tokens?: number; output_tokens?: number }
}

const addTokens = (t: Tokens, input?: number, output?: number): void => {
  t.inputTokens += input ?? 0
  t.outputTokens += output ?? 0
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Each checker throws when it cannot decide; the tokens it spent are still added to `used`.

// OpenRouter Decisions API: the decider model does not take chat/completions, so no generateText here.
async function askDecider(tool: string, detail: string, earlier: string[], used: Tokens): Promise<Risk> {
  const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: riskModel,
      state: {
        tool,
        command: detail,
        earlier_commands_of_this_task: earlier.slice(-10).map((c) => c.slice(0, 2000))
      },
      questions: { risk: question }
    }),
    signal: AbortSignal.timeout(60_000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as Decision
  addTokens(used, data.usage?.input_tokens, data.usage?.output_tokens)
  const a = data.answers?.risk
  if (a?.type !== 'choice' || (a.choice !== 'safe' && a.choice !== 'risk'))
    throw new Error(`คำตอบไม่ตรงรูปแบบ (${JSON.stringify(a).slice(0, 80)})`)
  const p = a.probabilities?.risk
  const reason = typeof p === 'number' ? `ความน่าจะเป็นที่เสี่ยง ${(p * 100).toFixed(1)}%` : `Guard เลือก ${a.choice}`
  return { level: a.choice, reason }
}

// Jev chat check. Text instead of a JSON schema: the router may pick a model without structured output support.
async function askJev(tool: string, detail: string, earlier: string[], used: Tokens): Promise<Risk> {
  const history = earlier.length
    ? `earlier_commands_of_this_task (already run):\n${earlier
        .slice(-10)
        .map((c, i) => `#${i + 1}\n${c.slice(0, 2000)}`)
        .join('\n')}\n\n`
    : ''
  const { text, usage } = await generateText({
    model: fallbackRiskModel,
    system,
    prompt: `${history}Command to judge (tool ${tool}):\n${detail}`,
    abortSignal: AbortSignal.timeout(60_000)
  })
  addTokens(used, usage.inputTokens, usage.outputTokens)
  // The first SAFE/RISK word decides; models sometimes write "LEVEL: SAFE …" or drop the colon.
  const m = text.match(/\b(SAFE|RISK)\b\s*[:：\-–]?\s*(.*)/i)
  if (!m) throw new Error(`คำตอบไม่ตรงรูปแบบ (${text.slice(0, 80)})`)
  return { level: m[1].toUpperCase() === 'SAFE' ? 'safe' : 'risk', reason: `(Jev) ${m[2].trim() || text.trim()}` }
}

// The decider first; Jev only when the decider fails. Anything other than a clear safe answer counts as RISK, so the user is asked.
// `earlier` holds the commands already run for the same user message, so the checker can see which files the task made.
// usage adds up the tokens of every call that ran.
export async function assessRisk(
  tool: string,
  detail: string,
  earlier: string[]
): Promise<{ risk: Risk; usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'> }> {
  const usage: Tokens = { inputTokens: 0, outputTokens: 0 }
  // A Bash detail is "<cwd>\n$ <command>".
  const at = detail.indexOf('\n$ ')
  if (tool === 'Bash' && at >= 0 && (await bskChainSafe(detail.slice(at + 3))))
    return { risk: { level: 'safe', reason: 'ผ่านกฎ bsk ในโค้ด: อ่าน ดู เลื่อนหรือคลิกหน้าเว็บ ไม่ส่งข้อมูล' }, usage }
  let deciderError: string
  try {
    return { risk: await askDecider(tool, detail, earlier, usage), usage }
  } catch (e) {
    deciderError = message(e)
  }
  try {
    return { risk: await askJev(tool, detail, earlier, usage), usage }
  } catch (e) {
    return { risk: { level: 'risk', reason: `ประเมินไม่สำเร็จ: Guard ${deciderError}; Jev ${message(e)}` }, usage }
  }
}
