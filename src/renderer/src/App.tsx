import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeBlock from './components/CodeBlock'
import FileLink, { linkifyPaths, OPEN } from './components/FileLink'
import Sidebar, { displayTitle } from './components/Sidebar'

const count = (n: number | null): string => (n ?? 0).toLocaleString('th-TH')

const JEV_TEXT: Record<JevStatus, string> = {
  inspecting: 'กำลังวิเคราะห์',
  safe: 'ปลอดภัย',
  risk: 'มีความเสี่ยง'
}

const ATTACH_HEAD = 'ไฟล์แนบ:\n'

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

// Splits a sent message into its text and the attached file paths (see send).
function splitAttachments(content: string): { text: string; files: string[] } {
  const at = content.indexOf('\n\n' + ATTACH_HEAD)
  if (at < 0) return { text: content, files: [] }
  return { text: content.slice(0, at), files: content.slice(at + 2 + ATTACH_HEAD.length).split('\n').filter(Boolean) }
}

// A file shown by its name only; the full path is in the tooltip. Has a remove button when onRemove is given.
function FileChip({ path, onRemove, disabled }: { path: string; onRemove?: () => void; disabled?: boolean }): React.JSX.Element {
  const name = baseName(path)
  return (
    <span className="file-chip" title={path}>
      <span className="file-chip-name">{name}</span>
      {onRemove && (
        <button type="button" aria-label={`เอาไฟล์ ${name} ออก`} disabled={disabled} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  )
}

// A user message: its text, then the attached files as chips.
function UserMessage({ content }: { content: string }): React.JSX.Element {
  const { text, files } = splitAttachments(content)
  return (
    <>
      {text}
      {files.length > 0 && (
        <div className="file-chips">
          {files.map((f) => (
            <FileChip key={f} path={f} />
          ))}
        </div>
      )}
    </>
  )
}

// Skills and tool calls of a turn, shown above its final answer.
function TurnInfo({ turn }: { turn: NonNullable<ChatMessage['turn']> }): React.JSX.Element {
  return (
    <div className="turn">
      {turn.skills.length > 0 && <div>Skill Use : {turn.skills.join(', ')}</div>}
      {turn.tools.map((t, i) => (
        <details key={i} className="turn-tool">
          {/* One plain-text row with +/- at its right, so a click anywhere on it only toggles. */}
          <summary>
            <span className="turn-input" title={t.input}>
              {t.name} : {t.input}
            </span>
          </summary>
          <div>
            output : {t.output}
            {t.output && t.files.length > 0 && ' · '}
            {t.files.map((f) => f.split(/[\\/]/).pop()).join(', ')}
          </div>
          {t.files.length > 0 && (
            <div>
              ไฟล์ :{' '}
              {t.files.map((f, j) => (
                <span key={f}>
                  {j > 0 && ', '}
                  <FileLink href={OPEN + encodeURIComponent(f)}>
                    <code>{f.split(/[\\/]/).pop()}</code>
                  </FileLink>
                </span>
              ))}
            </div>
          )}
          <pre className="tool-output">{t.console}</pre>
        </details>
      ))}
    </div>
  )
}

// Title, start time and tokens of the open session; a chat not sent yet is just "แชตใหม่".
function ChatHeader({ session }: { session?: Session }): React.JSX.Element {
  if (!session)
    return (
      <header className="chat-header">
        <span className="chat-title">แชตใหม่</span>
      </header>
    )
  const created = new Date(session.createdAt)
  const tracked = session.agentInputTokens !== null
  const total =
    (session.agentInputTokens ?? 0) +
    (session.agentOutputTokens ?? 0) +
    (session.guardInputTokens ?? 0) +
    (session.guardOutputTokens ?? 0)
  return (
    <header className="chat-header">
      <span className="chat-title" title={session.title}>
        {displayTitle(session.title)}
      </span>
      <time className="chat-meta" dateTime={created.toISOString()}>
        เริ่ม{' '}
        {created.toLocaleString('th-TH', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23'
        })}
      </time>
      <span
        className="chat-meta"
        title={
          tracked
            ? `Agent: in ${count(session.agentInputTokens)} / out ${count(session.agentOutputTokens)}\n` +
              `Guard: in ${count(session.guardInputTokens)} / out ${count(session.guardOutputTokens)}`
            : 'เริ่มนับ token หลังแชตนี้ จึงไม่มีตัวเลข'
        }
      >
        รวม {tracked ? count(total) : '—'} tokens
      </span>
    </header>
  )
}

function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  // Full paths of the files attached to the next message; the composer shows only their names.
  const [attachments, setAttachments] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Tool calls of the turn in progress, kept until the reply arrives; most finish in milliseconds.
  const [toolLog, setToolLog] = useState<ToolEvent[]>([])
  // Live console output and Jev's verdict per tool call id.
  const [toolOutput, setToolOutput] = useState<Record<string, string>>({})
  const [jev, setJev] = useState<Record<string, JevStatus>>({})
  // Answer text streamed so far; the reload from history replaces it when the reply ends.
  const [streamed, setStreamed] = useState('')
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const opening = useRef<number | null>(null)

  // null opens an empty chat; the session is created when its first message is sent.
  const openSession = async (id: number | null): Promise<void> => {
    opening.current = id
    setSessionId(id)
    setError(null)
    const history = id === null ? [] : await window.api.history(id)
    if (opening.current === id) setMessages(history)
  }

  const deleteSession = async (id: number): Promise<void> => {
    await window.api.deleteSession(id)
    setSessions((list) => list.filter((s) => s.id !== id))
    if (id === sessionId) openSession(null)
  }

  const renameSession = async (id: number, title: string): Promise<void> => {
    await window.api.renameSession(id, title)
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, title } : s)))
  }

  const pinSession = async (id: number, pinned: boolean): Promise<void> => {
    await window.api.pinSession(id, pinned)
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, pinned } : s)))
  }

  useEffect(() => {
    window.api.sessions().then((list) => {
      setSessions(list)
      if (list[0]) openSession(list[0].id)
    })
    const offTool = window.api.onTool((t) =>
      setToolLog((log) => (log.some((x) => x.id === t.id) ? log.map((x) => (x.id === t.id ? t : x)) : [...log, t]))
    )
    const offApprove = window.api.onApprove(setApproval)
    const offOutput = window.api.onToolOutput(({ id, chunk }) =>
      setToolOutput((o) => ({ ...o, [id]: ((o[id] ?? '') + chunk).slice(-20000) }))
    )
    const offJev = window.api.onJev(({ id, status }) => setJev((j) => ({ ...j, [id]: status })))
    const offText = window.api.onText(({ delta }) => setStreamed((s) => s + delta))
    // Live token totals during a reply. On a new chat the first update names the session it created,
    // so the header shows it before the reply arrives.
    const offUsage = window.api.onUsage(({ sessionId: id, ...usage }) => {
      if (opening.current === null) {
        opening.current = id
        setSessionId(id)
        window.api.sessions().then(setSessions)
      } else setSessions((list) => list.map((s) => (s.id === id ? { ...s, ...usage } : s)))
    })
    return () => {
      offUsage()
      offTool()
      offApprove()
      offOutput()
      offJev()
      offText()
    }
  }, [])

  useEffect(() => {
    bottom.current?.scrollIntoView()
  }, [messages, pending, approval, toolLog, toolOutput, streamed])

  const answer = (ok: boolean): void => {
    if (!approval) return
    window.api.approve(approval.id, ok)
    setApproval(null)
  }

  // Adds the picked file paths to the attachments, skipping ones already there.
  const attach = async (): Promise<void> => {
    const paths = await window.api.pickFiles()
    if (paths.length) setAttachments((a) => [...a, ...paths.filter((p, i) => !a.includes(p) && paths.indexOf(p) === i)])
    textarea.current?.focus()
  }

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const text = input.trim()
    if (!text || pending) return
    // The model gets the full paths; the chat bubble turns them back into chips (splitAttachments).
    const content = attachments.length ? text + '\n\n' + ATTACH_HEAD + attachments.join('\n') : text
    setInput('')
    setAttachments([])
    setError(null)
    setPending(true)
    setToolLog([])
    setToolOutput({})
    setJev({})
    setStreamed('')
    setMessages((m) => [...m, { role: 'user', content }])
    try {
      const reply = await window.api.send(sessionId, content)
      opening.current = reply.sessionId
      setSessionId(reply.sessionId)
      // Reloaded from the store, so the reply shows its skills and tool calls as a reopened chat does.
      setMessages(await window.api.history(reply.sessionId))
      setSessions(await window.api.sessions())
    } catch (err) {
      setError(String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        sessionId={sessionId}
        disabled={pending}
        onOpen={openSession}
        onDelete={deleteSession}
        onRename={renameSession}
        onPin={pinSession}
      />
      <div className="chat">
        <ChatHeader session={sessions.find((s) => s.id === sessionId)} />
        <main className="messages">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === 'assistant' ? (
                <>
                  {m.turn && <TurnInfo turn={m.turn} />}
                  <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: FileLink }}>
                    {linkifyPaths(m.content)}
                  </Markdown>
                </>
              ) : (
                <UserMessage content={m.content} />
              )}
            </div>
          ))}
          {pending && (
            <div className="msg assistant pending">
              {toolLog.map((t) => (
                <div key={t.id}>
                  <div className={t.running ? 'tool-line running' : 'tool-line'}>
                    {t.running ? '⏳' : '✓'} {t.name === 'loadSkill' ? `Skill Use : ${t.skill ?? ''}` : `tool call : ${t.name}`}
                  </div>
                  {jev[t.id] && (
                    <div className={`jev-line jev-${jev[t.id]}`}>
                      Guard : {JEV_TEXT[jev[t.id]]}
                    </div>
                  )}
                  {toolOutput[t.id] && <pre className="tool-output">{toolOutput[t.id]}</pre>}
                </div>
              ))}
              {streamed && (
                <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: FileLink }}>
                  {linkifyPaths(streamed)}
                </Markdown>
              )}
              <div>
                {toolLog.some((t) => t.running)
                  ? `กำลังเรียก tool: ${toolLog.filter((t) => t.running).map((t) => t.name).join(', ')}…`
                  : 'กำลังคิด…'}
              </div>
            </div>
          )}
          {approval && (
            <div className="approval">
              <div className="approval-title">Agent ขออนุญาตรัน {approval.tool}</div>
              <div className="risk">🔴 Guard ประเมินว่า risk: {approval.risk.reason}</div>
              <pre>{approval.detail}</pre>
              <div className="approval-actions">
                <button className="run" onClick={() => answer(true)}>
                  รัน
                </button>
                <button onClick={() => answer(false)}>ยกเลิก</button>
              </div>
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <div ref={bottom} />
        </main>
        <form className="composer" onSubmit={send}>
          <div className="composer-box">
            {attachments.length > 0 && (
              <div className="file-chips">
                {attachments.map((p) => (
                  <FileChip
                    key={p}
                    path={p}
                    disabled={pending}
                    onRemove={() => setAttachments((a) => a.filter((x) => x !== p))}
                  />
                ))}
              </div>
            )}
            <div className="composer-row">
              <button
                type="button"
                className="attach"
                aria-label="แนบไฟล์"
                title="แนบไฟล์"
                disabled={pending}
                onClick={attach}
              >
                +
              </button>
              <textarea
                ref={textarea}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    e.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder="พิมพ์ข้อความ… (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)"
                rows={1}
                autoFocus
              />
            </div>
          </div>
          <button type="submit" disabled={pending || !input.trim()}>
            ส่ง
          </button>
        </form>
      </div>
    </div>
  )
}

export default App
