import { app } from 'electron'
import { spawn } from 'child_process'
import { tool } from 'ai'
import { z } from 'zod'

export type Approve = (tool: string, detail: string, toolCallId: string) => Promise<boolean>
export type OnOutput = (toolCallId: string, chunk: string) => void

const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'
const maxOutput = 20000

// Python called from bash: UTF-8 so Thai text survives, unbuffered so output streams line by line.
const pythonEnv = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }

const tail = (s: string): string =>
  s.length > maxOutput ? `...(cut ${s.length - maxOutput} chars)\n${s.slice(-maxOutput)}` : s

// Streams every chunk to onOutput as it arrives, and resolves with the full result for the model.
function run(command: string, cwd: string, timeoutSeconds: number, onOutput: (chunk: string) => void): Promise<string> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let done = false
    const finish = (status: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(`${status}\n--- stdout ---\n${tail(stdout)}\n--- stderr ---\n${tail(stderr)}`)
    }
    const child = spawn(bashPath, ['-c', command], { cwd, env: { ...process.env, ...pythonEnv }, windowsHide: true })
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

// Runs judged SAFE start right away; any other run waits for the user to press "Run" in the chat.
export function shellTools(approve: Approve, onOutput: OnOutput) {
  return {
    runBash: tool({
      description:
        "Run a command in Git Bash on the user's Windows computer and return its exit code, stdout and stderr. " +
        'Risky runs need the user\'s approval. Windows paths look like /c/Users/... in bash. ' +
        'Python is available as "py" (with python-docx), Node.js as "node".',
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional().describe(`Working directory, default ${app.getPath('home')}`),
        timeoutSeconds: z.number().int().min(1).max(600).optional().describe('Seconds before the process is killed, default 120')
      }),
      execute: async (
        { command, cwd, timeoutSeconds }: { command: string; cwd?: string; timeoutSeconds?: number },
        { toolCallId }: { toolCallId: string }
      ) => {
        const dir = cwd ?? app.getPath('home')
        if (!(await approve('runBash', `${dir}\n$ ${command}`, toolCallId)))
          return 'The user denied this run. Do not retry it unless the user asks.'
        return run(command, dir, timeoutSeconds ?? 120, (chunk) => onOutput(toolCallId, chunk))
      }
    })
  }
}
