import { app } from 'electron'
import { join } from 'path'
import { PGlite } from '@electric-sql/pglite'
import type { ModelMessage } from 'ai'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }
// Token counts are null for sessions from before token counting.
export type Session = {
  id: number
  title: string
  createdAt: Date
  updatedAt: Date
  agentInputTokens: number | null
  agentOutputTokens: number | null
  jevInputTokens: number | null
  jevOutputTokens: number | null
}
export type TokenUsage = { agentInput: number; agentOutput: number; jevInput: number; jevOutput: number }
export type SessionUsage = Pick<Session, 'agentInputTokens' | 'agentOutputTokens' | 'jevInputTokens' | 'jevOutputTokens'>

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
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS jev_input_tokens int;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS jev_output_tokens int;
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

async function createSession(title: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('INSERT INTO sessions (title) VALUES ($1) RETURNING id', [title])
  return rows[0].id
}

export async function newSession(title: string): Promise<number> {
  await ready
  return createSession(title)
}

// Newest first by last message time; an empty session counts from its creation.
export async function listSessions(): Promise<Session[]> {
  await ready
  const { rows } = await db.query<Session>(`
    SELECT s.id, s.title, s.created_at AS "createdAt", coalesce(max(m.created_at), s.created_at) AS "updatedAt",
      s.agent_input_tokens AS "agentInputTokens", s.agent_output_tokens AS "agentOutputTokens",
      s.jev_input_tokens AS "jevInputTokens", s.jev_output_tokens AS "jevOutputTokens"
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
       jev_input_tokens = coalesce(jev_input_tokens, 0) + $4,
       jev_output_tokens = coalesce(jev_output_tokens, 0) + $5
     WHERE id = $1
     RETURNING agent_input_tokens AS "agentInputTokens", agent_output_tokens AS "agentOutputTokens",
       jev_input_tokens AS "jevInputTokens", jev_output_tokens AS "jevOutputTokens"`,
    [sessionId, u.agentInput ?? 0, u.agentOutput ?? 0, u.jevInput ?? 0, u.jevOutput ?? 0]
  )
  return rows[0]
}

export async function deleteSession(sessionId: number): Promise<void> {
  await ready
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM messages WHERE session_id = $1', [sessionId])
    await tx.query('DELETE FROM sessions WHERE id = $1', [sessionId])
  })
}

// Full messages, tool calls and results included, so the model sees what it did in earlier turns.
// ponytail: whole session history every turn, including tool results; trim old turns if context gets too long.
export async function loadModelMessages(sessionId: number): Promise<ModelMessage[]> {
  await ready
  const { rows } = await db.query<{ role: string; content: string; message: ModelMessage | null }>(
    'SELECT role, content, message FROM messages WHERE session_id = $1 ORDER BY id',
    [sessionId]
  )
  return rows.map((r) => r.message ?? ({ role: r.role, content: r.content } as ModelMessage))
}

export async function loadChat(sessionId: number): Promise<ChatMessage[]> {
  await ready
  const { rows } = await db.query<ChatMessage>(
    `SELECT role, content FROM messages
     WHERE session_id = $1 AND role IN ('user', 'assistant') AND content <> ''
     ORDER BY id`,
    [sessionId]
  )
  return rows
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
