import { generateText, type LanguageModelUsage } from 'ai'
import { fallbackRiskModel, riskModel } from './llm_model'

export type Risk = { level: 'safe' | 'risk'; reason: string }

type Tokens = { inputTokens: number; outputTokens: number }

// One rule text for both checkers, so the decider and Jev judge alike.
const safeRule =
  'Any one of these: read-only or harmless, e.g. listing or reading files, printing, calculations, network diagnostics like ping. Creating or writing new files of any type except .exe, .sh or .bat. Changing or overwriting a file that one of earlier_commands_of_this_task created or copied, except .exe, .sh or .bat. The bsk browser CLI used to read or move around: bsk browsers, bsk status, bsk doctor, bsk session start, bsk session stop, navigate, observe, snapshot, get-html, screenshot, scroll-to, wheel, hover, focus, blur, and --help on any bsk command. A read-only GET request with curl to https://skills.sh/api/search (searching the skills directory), optionally piped into a command that only parses or prints the result.'
const riskRule =
  'Any one of these: creating or writing .exe, .sh or .bat files. Installing, upgrading or removing any package or program (pip, npm, npx, winget, choco, installers), always. bsk actions that change a website or send data: click, fill, select, press, upload, evaluate, or anything that submits a form. Anything else, e.g. changing, overwriting, moving or deleting existing files, changing settings, uploading or downloading data, running downloaded code, touching credentials or personal files, or anything hard to understand.'

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
