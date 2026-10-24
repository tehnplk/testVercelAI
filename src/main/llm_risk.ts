import type { LanguageModelUsage } from 'ai'
import { riskModel } from './llm_model'

export type Risk = { level: 'safe' | 'risk'; reason: string }

const question = {
  type: 'choice',
  instructions:
    "An AI agent wants to run `command` with the tool `tool` (Git Bash, Python or Node.js) on the user's Windows computer. `earlier_commands_of_this_task` are the commands already run for the same user request. Decide whether `command` can run without asking the user. Choose safe only when it clearly matches the safe criteria; otherwise choose risk.",
  criteria: {
    safe: 'Any one of these: read-only or harmless, e.g. listing or reading files, printing, calculations, network diagnostics like ping. Creating or writing new files of any type except .exe, .sh or .bat. Changing or overwriting a file that one of earlier_commands_of_this_task created or copied, except .exe, .sh or .bat. The bsk browser CLI used to read or move around: bsk browsers, bsk status, bsk doctor, bsk session start, bsk session stop, navigate, observe, snapshot, get-html, screenshot, scroll-to, wheel, hover, focus, blur, and --help on any bsk command.',
    risk: 'Any one of these: creating or writing .exe, .sh or .bat files. Installing, upgrading or removing any package or program (pip, npm, npx, winget, choco, installers), always. bsk actions that change a website or send data: click, fill, select, press, upload, evaluate, or anything that submits a form. Anything else, e.g. changing, overwriting, moving or deleting existing files, changing settings, uploading or downloading data, running downloaded code, touching credentials or personal files, or anything hard to understand.'
  }
}

type Decision = {
  answers?: { risk?: { type?: string; choice?: string; probabilities?: { risk?: number } } }
  usage?: { input_tokens?: number; output_tokens?: number }
}

// OpenRouter Decisions API: the decider model does not take chat/completions, so no generateText here.
// Anything other than a clear safe choice counts as RISK, so the user is asked.
// `earlier` holds the commands already run for the same user message, so Jev can see which files the task made.
// usage is missing when the call failed.
export async function assessRisk(
  tool: string,
  detail: string,
  earlier: string[]
): Promise<{ risk: Risk; usage?: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'> }> {
  try {
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
    const usage = { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens }
    const a = data.answers?.risk
    if (a?.type !== 'choice' || (a.choice !== 'safe' && a.choice !== 'risk'))
      return { risk: { level: 'risk', reason: `ประเมินไม่สำเร็จ: คำตอบไม่ตรงรูปแบบ (${JSON.stringify(a).slice(0, 80)})` }, usage }
    const p = a.probabilities?.risk
    const reason = typeof p === 'number' ? `ความน่าจะเป็นที่เสี่ยง ${(p * 100).toFixed(1)}%` : `Guard เลือก ${a.choice}`
    return { risk: { level: a.choice, reason }, usage }
  } catch (e) {
    return { risk: { level: 'risk', reason: `ประเมินไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}` } }
  }
}
