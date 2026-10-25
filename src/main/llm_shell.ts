import { app } from 'electron'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { closeSync, existsSync, openSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { generateText, tool, type LanguageModelUsage } from 'ai'
import { z } from 'zod'
import { summaryModel } from './llm_model'

// alwaysAsk skips Guard and shows the approval card every time.
export type Approve = (tool: string, detail: string, toolCallId: string, alwaysAsk?: boolean) => Promise<boolean>
export type OnOutput = (toolCallId: string, chunk: string) => void
export type OnUsage = (usage: LanguageModelUsage) => Promise<void>

const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
const maxOutput = 20000

// Python called from bash: UTF-8 so Thai text survives, unbuffered so output streams line by line.
// bsk clients use the daemon this file starts (ensureBskDaemon) instead of starting their own.
const shellEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', BSK_AUTO_START: '0' }

const tail = (s: string): string =>
  s.length > maxOutput ? `...(cut ${s.length - maxOutput} chars)\n${s.slice(-maxOutput)}` : s

// bsk (browser-skill) cannot start its own background daemon when the app runs inside a Windows Job Object
// that forbids breakaway (one set by whatever launched it, e.g. a terminal or IDE). The app owns one
// `bsk daemon start --foreground` instead, started on the first command that uses bsk.
let bskDaemon: ChildProcess | null = null
let bskStarting: Promise<void> | null = null

const findBsk = (): string | undefined =>
  [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')]
    .map((dir) => join(dir, 'bsk.exe'))
    .find((p) => existsSync(p))

const bskUp = (bsk: string): Promise<boolean> =>
  new Promise((resolve) =>
    execFile(bsk, ['status', '--json'], { env: { ...process.env, BSK_AUTO_START: '0' }, windowsHide: true, timeout: 5000 }, (e) =>
      resolve(!e)
    )
  )

// Starts the daemon unless bsk is missing or a daemon already answers, and waits up to 10s for it.
async function startBskDaemon(): Promise<void> {
  const bsk = findBsk()
  if (!bsk || (await bskUp(bsk))) return
  const log = openSync(join(app.getPath('userData'), 'bsk-daemon.log'), 'a')
  // Not detached: it needs no breakaway, and the app's job ends it if the app dies without will-quit.
  const daemon = spawn(bsk, ['daemon', 'start', '--foreground'], { stdio: ['ignore', log, log], windowsHide: true })
  closeSync(log)
  bskDaemon = daemon
  const gone = (): void => {
    if (bskDaemon === daemon) bskDaemon = null
  }
  daemon.on('exit', gone)
  daemon.on('error', gone)
  for (let i = 0; i < 50 && bskDaemon === daemon && !(await bskUp(bsk)); i++)
    await new Promise((r) => setTimeout(r, 200))
}

function ensureBskDaemon(): Promise<void> {
  if (!bskStarting && !bskDaemon) bskStarting = startBskDaemon().finally(() => (bskStarting = null))
  return bskStarting ?? Promise.resolve()
}

app.on('will-quit', () => bskDaemon?.kill())

type RunResult = { status: string; stdout: string; stderr: string }

// Streams every chunk to onOutput as it arrives, and resolves with the full result.
function run(command: string, cwd: string, timeoutSeconds: number, onOutput: (chunk: string) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let done = false
    const finish = (status: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    }
    const child = spawn(bashPath, ['-c', command], { cwd, env: { ...process.env, ...shellEnv }, windowsHide: true })
    // child.kill() would leave grandchildren (e.g. ping under bash) running on Windows.
    const timer = setTimeout(() => {
      timedOut = true
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    }, timeoutSeconds * 1000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout += d
      onOutput(d)
    })
    child.stderr.on('data', (d: string) => {
      stderr += d
      onOutput(d)
    })
    child.on('error', (e) => finish(`failed to start: ${e.message}`))
    child.on('close', (code) => finish(timedOut ? `killed after ${timeoutSeconds}s timeout` : `exit code ${code}`))
  })
}

const summarySystem = `You read the output of one command that an AI agent ran on the user's Windows computer, and state what it produced toward the user's request.
If the command created or changed files, answer only with one line per file: "Saved: <full Windows path>" (write bash paths like /c/Users/x as C:\\Users\\x).
Otherwise answer with exactly one line in Thai, at most 15 words: the key value or finding the output gives toward the request, e.g. "เงินเดือนรวม 105,000 บาท". No explanation, no prefix, no quotes.`

// One "Result: <line>" or "Saved: <path>" lines for a run that printed neither; '' when the summary fails.
async function summarize(
  request: string,
  purpose: string,
  command: string,
  dir: string,
  { status, stdout, stderr }: RunResult,
  onUsage: OnUsage
): Promise<string> {
  try {
    const { text, usage } = await generateText({
      model: summaryModel,
      system: summarySystem,
      prompt:
        `User's request:\n${request.slice(0, 2000)}\n\nPurpose of this run: ${purpose}\n` +
        `Working directory: ${dir}\nCommand:\n${command.slice(0, 2000)}\n\n${status}\n` +
        `--- stdout (end) ---\n${stdout.slice(-4500)}\n--- stderr (end) ---\n${stderr.slice(-1500)}`,
      abortSignal: AbortSignal.timeout(20_000)
    })
    await onUsage(usage)
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    // Only files that exist, so a made-up path never becomes a link.
    const saved = lines
      .map((l) => l.match(/^Saved:\s*(.+)$/)?.[1].trim())
      .filter((p): p is string => !!p && existsSync(p))
    if (saved.length) return saved.map((p) => `Saved: ${p}`).join('\n')
    const line = lines.find((l) => !l.startsWith('Saved:'))?.replace(/^Result:\s*/, '')
    return line ? `Result: ${line}` : ''
  } catch {
    return ''
  }
}

// Runs judged SAFE start right away; any other run waits for the user to press "Run" in the chat.
// request: the user's message this run serves; onUsage counts the summary model's tokens.
export function shellTools(approve: Approve, onOutput: OnOutput, request: string, onUsage: OnUsage) {
  return {
    Bash: tool({
      description:
        "Run a command in Git Bash on the user's Windows computer and return its exit code, stdout and stderr. " +
        'Risky runs need the user\'s approval. Windows paths look like /c/Users/... in bash. ' +
        'Python is available as "py" (with python-docx), Node.js as "node". ' +
        'End the command\'s output with "Saved: <full Windows path>" for each file created or changed, ' +
        'or "Result: <value>" with the key result of a read or calculation.',
      inputSchema: z.object({
        // Shown to the user as the call's input in the chat, instead of the command.
        purpose: z.string().describe('In Thai, one short sentence: what this run is for, as briefed by the user; not the command'),
        command: z.string(),
        cwd: z.string().optional().describe(`Working directory, default ${app.getPath('home')}`),
        timeoutSeconds: z.number().int().min(1).max(600).optional().describe('Seconds before the process is killed, default 120')
      }),
      execute: async (
        { purpose, command, cwd, timeoutSeconds }: { purpose: string; command: string; cwd?: string; timeoutSeconds?: number },
        { toolCallId }: { toolCallId: string }
      ) => {
        const dir = cwd ?? app.getPath('home')
        if (!(await approve('Bash', `${dir}\n$ ${command}`, toolCallId)))
          return 'The user denied this run. Do not retry it unless the user asks.'
        if (/\bbsk\b/.test(command)) await ensureBskDaemon()
        const result = await run(command, dir, timeoutSeconds ?? 120, (chunk) => onOutput(toolCallId, chunk))
        // The chat shows a run's "Saved:"/"Result:" lines as its output; a run that printed none gets one
        // from the summary model, at the end of stdout where llm_memory.ts reads them.
        let stdout = tail(result.stdout)
        if (!/^(Saved|Result): *\S/m.test(result.stdout)) {
          const note = await summarize(request, purpose, command, dir, result, onUsage)
          if (note) stdout += `${stdout && !stdout.endsWith('\n') ? '\n' : ''}${note}`
        }
        return `${result.status}\n--- stdout ---\n${stdout}\n--- stderr ---\n${tail(result.stderr)}`
      }
    })
  }
}
