import { app } from 'electron'
import { join } from 'path'
import { PGlite } from '@electric-sql/pglite'
import type { ModelMessage } from 'ai'

// input: what the call was for (Bash's purpose); output: one line of what it produced, besides files
// (the paths it saved); console: its full result as shown in the console.
export type ToolCall = { name: string; input: string; output: string; files: string[]; console: string }
// turn: skills and tool calls of the turn, on its final answer only.
export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  turn?: { skills: string[]; tools: ToolCall[] }
}
// Token counts are null for sessions from before token counting.
export type Session = {
  id: number
  title: string
  pinned: boolean
  // Agent model id; null for the default.
  model: string | null
  createdAt: Date
  updatedAt: Date
  agentInputTokens: number | null
  agentOutputTokens: number | null
  guardInputTokens: number | null
  guardOutputTokens: number | null
}
export type TokenUsage = { agentInput: number; agentOutput: number; guardInput: number; guardOutput: number }
export type SessionUsage = Pick<
  Session,
  'agentInputTokens' | 'agentOutputTokens' | 'guardInputTokens' | 'guardOutputTokens'
>

const db = new PGlite(join(app.getPath('userData'), 'pgdata'))

async function migrate(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id serial PRIMARY KEY,
      role text NOT NULL,
      content text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_role_check;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS message jsonb;
    CREATE TABLE IF NOT EXISTS sessions (
      id serial PRIMARY KEY,
      title text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS session_id int REFERENCES sessions(id);
    -- NULL: the session is older than token counting.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_input_tokens int;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_output_tokens int;
    -- The risk checker's columns were named jev_*; rename them once, keeping their values.
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                   AND table_name = 'sessions' AND column_name = 'jev_input_tokens')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                   AND table_name = 'sessions' AND column_name = 'guard_input_tokens') THEN
        ALTER TABLE sessions RENAME COLUMN jev_input_tokens TO guard_input_tokens;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                   AND table_name = 'sessions' AND column_name = 'jev_output_tokens')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                   AND table_name = 'sessions' AND column_name = 'guard_output_tokens') THEN
        ALTER TABLE sessions RENAME COLUMN jev_output_tokens TO guard_output_tokens;
      END IF;
    END $$;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS guard_input_tokens int;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS guard_output_tokens int;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
    -- Agent model id (llm_model.ts agentModels); NULL: the default.
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS model text;
  `)
  // Messages from before sessions existed go into one session.
  const orphans = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM messages WHERE session_id IS NULL')
  if (orphans.rows[0].n > 0) {
    const id = await createSession('ประวัติเดิม')
    await db.query('UPDATE messages SET session_id = $1 WHERE session_id IS NULL', [id])
  }
}
const ready = migrate()

const textOf = (m: ModelMessage): string =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((part) => (part.type === 'text' ? part.text : '')).join('')

async function createSession(title: string, model: string | null = null): Promise<number> {
  const { rows } = await db.query<{ id: number }>('INSERT INTO sessions (title, model) VALUES ($1, $2) RETURNING id', [
    title,
    model
  ])
  return rows[0].id
}

export async function newSession(title: string, model: string): Promise<number> {
  await ready
  return createSession(title, model)
}

// Newest first by last message time; an empty session counts from its creation.
export async function listSessions(): Promise<Session[]> {
  await ready
  const { rows } = await db.query<Session>(`
    SELECT s.id, s.title, s.pinned, s.model, s.created_at AS "createdAt", coalesce(max(m.created_at), s.created_at) AS "updatedAt",
      s.agent_input_tokens AS "agentInputTokens", s.agent_output_tokens AS "agentOutputTokens",
      s.guard_input_tokens AS "guardInputTokens", s.guard_output_tokens AS "guardOutputTokens"
    FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id
    ORDER BY "updatedAt" DESC, s.id DESC
  `)
  return rows
}

// Adds to the stored totals and returns them; the first count turns NULL (not counted) into a number.
export async function addUsage(sessionId: number, u: Partial<TokenUsage>): Promise<SessionUsage> {
  await ready
  const { rows } = await db.query<SessionUsage>(
    `UPDATE sessions SET
       agent_input_tokens = coalesce(agent_input_tokens, 0) + $2,
       agent_output_tokens = coalesce(agent_output_tokens, 0) + $3,
       guard_input_tokens = coalesce(guard_input_tokens, 0) + $4,
       guard_output_tokens = coalesce(guard_output_tokens, 0) + $5
     WHERE id = $1
     RETURNING agent_input_tokens AS "agentInputTokens", agent_output_tokens AS "agentOutputTokens",
       guard_input_tokens AS "guardInputTokens", guard_output_tokens AS "guardOutputTokens"`,
    [sessionId, u.agentInput ?? 0, u.agentOutput ?? 0, u.guardInput ?? 0, u.guardOutput ?? 0]
  )
  return rows[0]
}

export async function renameSession(sessionId: number, title: string): Promise<void> {
  await ready
  await db.query('UPDATE sessions SET title = $2 WHERE id = $1', [sessionId, title])
}

export async function setPinned(sessionId: number, pinned: boolean): Promise<void> {
  await ready
  await db.query('UPDATE sessions SET pinned = $2 WHERE id = $1', [sessionId, pinned])
}

export async function setSessionModel(sessionId: number, model: string): Promise<void> {
  await ready
  await db.query('UPDATE sessions SET model = $2 WHERE id = $1', [sessionId, model])
}

// null for the default, or when there is no such session.
export async function sessionModel(sessionId: number): Promise<string | null> {
  await ready
  const { rows } = await db.query<{ model: string | null }>('SELECT model FROM sessions WHERE id = $1', [sessionId])
  return rows[0]?.model ?? null
}

export async function deleteSession(sessionId: number): Promise<void> {
  await ready
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM messages WHERE session_id = $1', [sessionId])
    await tx.query('DELETE FROM sessions WHERE id = $1', [sessionId])
  })
}

// Turns (a user message up to the next) sent in full, the current one included; older turns are cut down.
const fullTurns = 3
const noAnswer = '(turn นี้ใช้ tool แล้วไม่มีคำตอบเป็นข้อความ)'

// The last fullTurns turns as stored, tool calls and results included, so the model sees what it just did.
// Older turns send only the user message and the text of the turn's last message when it is an assistant's
// (a turn that ends on a tool result, e.g. at the step limit, has no final text).
// ponytail: fixed turn count, not tokens; a long last turn is still sent whole.
export async function loadModelMessages(sessionId: number): Promise<ModelMessage[]> {
  await ready
  const { rows } = await db.query<{ role: string; content: string; message: ModelMessage | null }>(
    'SELECT role, content, message FROM messages WHERE session_id = $1 ORDER BY id',
    [sessionId]
  )
  const all = rows.map((r) => withoutImages(r.message ?? ({ role: r.role, content: r.content } as ModelMessage)))
  const starts = all.flatMap((m, i) => (m.role === 'user' ? [i] : []))
  const cut = starts.length > fullTurns ? starts[starts.length - fullTurns] : 0
  const old: ModelMessage[] = []
  for (const m of all.slice(0, cut))
    if (m.role === 'user') old.push(m, { role: 'assistant', content: noAnswer })
    // A tool message has no text parts, so it resets the answer.
    else if (old.length) old[old.length - 1] = { role: 'assistant', content: textOf(m).trim() || noAnswer }
  return [...old, ...all.slice(cut)]
}

// An image a tool result showed (viewImage) is sent to the model only in the turn that viewed it;
// later turns get a note instead. The stored row keeps the image.
const withoutImages = (m: ModelMessage): ModelMessage =>
  m.role !== 'tool'
    ? m
    : {
        ...m,
        content: m.content.map((p) =>
          p.type !== 'tool-result' || p.output.type !== 'content'
            ? p
            : {
                ...p,
                output: {
                  ...p.output,
                  value: p.output.value.map((v) =>
                    v.type === 'text'
                      ? v
                      : {
                          type: 'text' as const,
                          text: `[ภาพ ${('filename' in v && v.filename) || ''} ถูกส่งให้ดูแล้วใน turn ก่อน หากต้องดูอีกให้เรียก viewImage ใหม่]`
                        }
                  )
                }
              }
        )
      }

// Tool-call and tool-result parts as stored in the message JSON.
type Part = {
  type: string
  toolCallId?: string
  toolName?: string
  input?: { name?: unknown; purpose?: unknown } | null
  output?: { type: string; value?: unknown; reason?: string }
}

// Keeps the end, where results and "Saved:" lines are.
const maxShown = 4000
const cap = (s: string): string =>
  s.length > maxShown ? `...(cut ${s.length - maxShown} chars)\n${s.slice(-maxShown)}` : s
const lastLine = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? ''
// Same as pathRe in the renderer's FileLink.tsx.
const pathRe = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n`]+[\\/])*[^\\/:*?"<>|\r\n`]+\.[A-Za-z0-9]{1,8}/g

// Values of "<label>: <value>" lines; the system prompt asks runs to print "Saved:" and "Result:" lines.
const labeled = (stdout: string, label: string): string[] => [
  ...new Set([...stdout.matchAll(new RegExp(`^${label}: *(.+?)\\s*$`, 'gm'))].map((m) => m[1]))
]

// The output line, files and console text of one tool call, from its stored result.
function shown(name: string, result: Part | undefined): Pick<ToolCall, 'output' | 'files' | 'console'> {
  const o = result?.output
  if (!o) return { output: '(no result)', files: [], console: '(no result)' }
  // Text and image parts (viewImage): the text is the console, the image's file name the output; never the image data.
  if (o.type === 'content' && Array.isArray(o.value)) {
    const parts = o.value as { text?: string; filename?: string }[]
    const text = parts.map((p) => p.text ?? '').filter(Boolean).join('\n')
    return { output: parts.find((p) => p.filename)?.filename ?? lastLine(text), files: [], console: cap(text) }
  }
  const text =
    typeof o.value === 'string'
      ? o.value
      : o.type === 'execution-denied'
        ? (o.reason ?? 'execution denied')
        : JSON.stringify(o.value ?? o)
  if (o.type === 'execution-denied' || (name === 'Bash' && text.startsWith('The user denied this run')))
    return { output: 'ถูกปฏิเสธ', files: [], console: cap(text) }
  // webSearch and webFetch (llm_web.ts): the first line (result count or page title) is the output, the console
  // keeps the start, and paths in a web page never become file links.
  if (name === 'webSearch' || name === 'webFetch')
    return {
      output: text.split('\n')[0].slice(0, 200),
      files: [],
      console: text.length > maxShown ? `${text.slice(0, maxShown)}\n...(cut ${text.length - maxShown} chars)` : text
    }
  // Bash's result: status line, then stdout and stderr under their headers (see llm_shell.ts).
  const run = name === 'Bash' ? text.match(/^(.*)\n--- stdout ---\n([\s\S]*)\n--- stderr ---\n([\s\S]*)$/) : null
  const [, status, stdout, stderr] = run ?? ['', 'exit code 0', text, '']
  const saved = labeled(stdout, 'Saved')
  const results = labeled(stdout, 'Result')
  // Without "Saved:" or "Result:" lines, any Windows file path the run printed counts as a file it made
  // (with only "Result:" lines, a printed path is most likely the file it read).
  const files = saved.length || results.length ? saved : [...new Set(stdout.match(pathRe) ?? [])]
  // Its "Result:" values; without them, files stand for the outcome, else its last line.
  const line = results.join(' · ') || (files.length ? '' : lastLine(stdout) || lastLine(stderr))
  const ok = status === 'exit code 0'
  const joined = ok
    ? line || (files.length ? '' : 'exit 0')
    : [status.replace(/^exit code /, 'exit '), line].filter(Boolean).join(' · ')
  const output = joined.length > 200 ? `${joined.slice(0, 200)}…` : joined
  if (!run) return { output, files, console: cap(text) }
  const full = [stdout.trimEnd(), stderr.trim() && `--- stderr ---\n${stderr.trimEnd()}`, status].filter(Boolean)
  return { output, files, console: cap(full.join('\n')) }
}

// Rows the chat shows: user messages and assistant text. The last assistant text of each turn
// (rows from a user message up to the next) gets the turn's skills and tool calls.
// Rows without message JSON (before full messages were stored) add nothing to a turn.
export async function loadChat(sessionId: number): Promise<ChatMessage[]> {
  await ready
  const { rows } = await db.query<{ role: string; content: string; message: { content?: unknown } | null }>(
    'SELECT role, content, message FROM messages WHERE session_id = $1 ORDER BY id',
    [sessionId]
  )
  const chat: ChatMessage[] = []
  let answer: ChatMessage | undefined
  let calls: Part[] = []
  let results = new Map<string, Part>()
  const endTurn = (): void => {
    const skills = [
      ...new Set(calls.filter((c) => c.toolName === 'loadSkill').map((c) => c.input?.name))
    ].filter((n): n is string => typeof n === 'string')
    const tools = calls
      .filter((c) => c.toolName !== 'loadSkill')
      .map((c) => {
        const name = c.toolName === 'runBash' ? 'Bash' : (c.toolName ?? '')
        return {
          name,
          // Calls stored before Bash had a purpose show a dash.
          input: typeof c.input?.purpose === 'string' && c.input.purpose ? c.input.purpose : '—',
          ...shown(name, results.get(c.toolCallId ?? ''))
        }
      })
    if (answer && (skills.length || tools.length)) answer.turn = { skills, tools }
    answer = undefined
    calls = []
    results = new Map()
  }
  for (const r of rows) {
    if (r.role === 'user') endTurn()
    const parts = Array.isArray(r.message?.content) ? (r.message.content as Part[]) : []
    for (const p of parts)
      if (p.type === 'tool-call') calls.push(p)
      else if (p.type === 'tool-result') results.set(p.toolCallId ?? '', p)
    if ((r.role === 'user' || r.role === 'assistant') && r.content.trim() !== '') {
      const m: ChatMessage = { role: r.role, content: r.content }
      chat.push(m)
      if (r.role === 'assistant') answer = m
    }
  }
  endTurn()
  return chat
}

export async function saveMessages(sessionId: number, messages: ModelMessage[]): Promise<void> {
  await ready
  for (const m of messages)
    await db.query('INSERT INTO messages (session_id, role, content, message) VALUES ($1, $2, $3, $4)', [
      sessionId,
      m.role,
      textOf(m),
      JSON.stringify(m)
    ])
}
