import { generateText, type LanguageModelUsage } from 'ai'
import { riskModel } from './llm_model'

export type Risk = { level: 'safe' | 'risk'; reason: string }

const system = `You review a command or script that an AI agent wants to run on the user's Windows computer (Git Bash, Python or Node.js). Decide whether it can run without asking the user.
SAFE: read-only or harmless, e.g. listing or reading files, printing, calculations, network diagnostics like ping.
SAFE: creating or writing new files of any type, except the types listed under RISK.
SAFE: changing or overwriting a file that one of the earlier commands of this task created or copied, except the types listed under RISK.
RISK: creating or writing .exe, .sh or .bat files.
RISK: installing, upgrading or removing any package or program (pip, npm, npx, winget, choco, installers), always.
SAFE: the bsk browser CLI used to read or move around: bsk browsers, bsk status, bsk doctor, bsk session start, bsk session stop, navigate, observe, snapshot, get-html, screenshot, scroll-to, wheel, hover, focus, blur, and --help on any bsk command.
RISK: bsk actions that change a website or send data: click, fill, select, press, upload, evaluate, or anything that submits a form.
RISK: anything else, e.g. changes, overwrites, moves or deletes existing files, changes settings, installs packages, uploads or downloads data, runs downloaded code, touches credentials or personal files, or is hard to understand.
Answer with exactly one line that starts with SAFE or RISK, a colon, then the reason in Thai (at most 20 words), for example:
SAFE: อ่านไฟล์อย่างเดียว ไม่แก้ไขอะไร`

// Text instead of a JSON schema: the router may pick a model without structured output support.
// Anything other than a clear SAFE counts as RISK, so the user is asked.
// `earlier` holds the commands already run for the same user message, so Jev can see which files the task made.
// usage is missing when the call failed.
export async function assessRisk(
  tool: string,
  detail: string,
  earlier: string[]
): Promise<{ risk: Risk; usage?: LanguageModelUsage }> {
  const history = earlier.length
    ? `Earlier commands of this task (already run):\n${earlier
        .slice(-10)
        .map((c, i) => `#${i + 1}\n${c.slice(0, 2000)}`)
        .join('\n')}\n\n`
    : ''
  try {
    const { text, usage } = await generateText({
      model: riskModel,
      system,
      prompt: `${history}Command to judge (tool ${tool}):\n${detail}`,
      abortSignal: AbortSignal.timeout(60_000)
    })
    // The first SAFE/RISK word decides; models sometimes write "LEVEL: SAFE …" or drop the colon.
    const m = text.match(/\b(SAFE|RISK)\b\s*[:：\-–]?\s*(.*)/i)
    if (!m) return { risk: { level: 'risk', reason: `ประเมินไม่สำเร็จ: คำตอบไม่ตรงรูปแบบ (${text.slice(0, 80)})` }, usage }
    return { risk: { level: m[1].toUpperCase() === 'SAFE' ? 'safe' : 'risk', reason: m[2].trim() || text.trim() }, usage }
  } catch (e) {
    return { risk: { level: 'risk', reason: `ประเมินไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}` } }
  }
}