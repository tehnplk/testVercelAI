import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeBlock from './components/CodeBlock'
import FileLink, { linkifyPaths } from './components/FileLink'
import Sidebar from './components/Sidebar'

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
    return () => {
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
      setMessages((m) => [...m, { role: 'assistant', content: reply.text }])
      setSessions(await window.api.sessions())
    } catch (err) {
      setError(String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="app">
      <Sidebar sessions={sessions} sessionId={sessionId} disabled={pending} onOpen={openSession} />
      <div className="chat">
        <main className="messages">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === 'assistant' ? (
                <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: FileLink }}>
                  {linkifyPaths(m.content)}
                </Markdown>
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
                    {t.running ? '⏳' : '✓'} {t.name}
                  </div>
                  {jev[t.id] && (
                    <div className={`jev-line jev-${jev[t.id]}`}>
                      jev : {jev[t.id] === 'inspecting' ? 'inspecting risk' : jev[t.id]}
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
