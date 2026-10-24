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
    (session.jevInputTokens ?? 0) +
    (session.jevOutputTokens ?? 0)
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
              `Jev: in ${count(session.jevInputTokens)} / out ${count(session.jevOutputTokens)}`
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
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Tool calls of the turn in progress, kept until the reply arrives; most finish in milliseconds.
  const [toolLog, setToolLog] = useState<ToolEvent[]>([])
  // Live console output and Jev's verdict per tool call id.
  const [toolOutput, setToolOutput] = useState<Record<string, string>>({})
  const [jev, setJev] = useState<Record<string, JevStatus>>({})
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
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
    }
  }, [])

  useEffect(() => {
    bottom.current?.scrollIntoView()
  }, [messages, pending, approval, toolLog, toolOutput])

  const answer = (ok: boolean): void => {
    if (!approval) return
    window.api.approve(approval.id, ok)
    setApproval(null)
  }

  const send = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const content = input.trim()
    if (!content || pending) return
    setInput('')
    setError(null)
    setPending(true)
    setToolLog([])
    setToolOutput({})
    setJev({})
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
                m.content
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
                      jev : {JEV_TEXT[jev[t.id]]}
                    </div>
                  )}
                  {toolOutput[t.id] && <pre className="tool-output">{toolOutput[t.id]}</pre>}
                </div>
              ))}
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
              <div className="risk">🔴 Jev ประเมินว่า risk: {approval.risk.reason}</div>
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
          <textarea
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
          <button type="submit" disabled={pending || !input.trim()}>
            ส่ง
          </button>
        </form>
      </div>
    </div>
  )
}

export default App
