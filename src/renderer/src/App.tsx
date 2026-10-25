import { useEffect, useRef, useState } from 'react'
import Markdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import CodeBlock from './components/CodeBlock'
import DocxViewer from './components/DocxViewer'
import FileLink, { linkifyPaths, OPEN, ViewDocx } from './components/FileLink'
import MarkdownImage from './components/MarkdownImage'
import ModelPicker from './components/ModelPicker'
import Sidebar, { displayTitle } from './components/Sidebar'

const components = { pre: CodeBlock, a: FileLink, img: MarkdownImage }

// Markdown escapes raw HTML, so a <br> the model writes (e.g. in a table cell) would show as text: use a space instead.
const noBr = (s: string): string => s.replace(/<br\s*\/?>/gi, ' ')

// While an answer streams, a ```chart block whose JSON is not complete yet shows as code, without an error.
function LiveCodeBlock(props: React.ComponentProps<'pre'> & ExtraProps): React.JSX.Element {
  return <CodeBlock {...props} live />
}
const liveComponents = { ...components, pre: LiveCodeBlock }

// Image sources stay as written (local Windows paths too): MarkdownImage loads them only through image:load,
// or app-media: for videos.
const urlTransform = (url: string, key: string): string => (key === 'src' ? url : defaultUrlTransform(url))

const count = (n: number | null): string => (n ?? 0).toLocaleString('th-TH')

const JEV_TEXT: Record<JevStatus, string> = {
  inspecting: 'กำลังวิเคราะห์',
  safe: 'ปลอดภัย',
  risk: 'มีความเสี่ยง',
  off: 'ปิด รันโดยไม่ถาม'
}

const ATTACH_HEAD = 'ไฟล์แนบ:\n'

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

// Splits a sent message into its text and the attached file paths (see send). Lines in [ ] are notes for the
// model about an attached image (main llm_image.ts withAttachedImages), not files.
function splitAttachments(content: string): { text: string; files: string[] } {
  const at = content.indexOf('\n\n' + ATTACH_HEAD)
  if (at < 0) return { text: content, files: [] }
  const lines = content.slice(at + 2 + ATTACH_HEAD.length).split('\n')
  return { text: content.slice(0, at), files: lines.filter((l) => l && !l.startsWith('[')) }
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
    <>
      {turn.skills.length > 0 && (
        <details className="turn">
          <summary>
            <span className="turn-input">Skill: {turn.skills.join(', ')}</span>
          </summary>
          {turn.skills.map((s) => (
            <div key={s}>Skill Use : {s}</div>
          ))}
        </details>
      )}
      {turn.tools.length > 0 && (
        <details className="turn">
          <summary>
            <span className="turn-input">เครื่องมือ {turn.tools.length} รายการ</span>
          </summary>
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
        </details>
      )}
    </>
  )
}

// Top line of the live tool group: the tool running now (else the last one).
function liveToolSummary(tools: ToolEvent[]): string {
  const cur = tools.filter((t) => t.running).pop() ?? tools[tools.length - 1]
  return `กำลังใช้: ${cur.running ? '' : '✓ '}${cur.name === 'runBash' ? 'Bash' : cur.name}${cur.input ? ` : ${cur.input}` : ''}`
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
  // Path of the .docx file open in the viewer. Kept here, so the viewer stays open when the reply
  // whose link opened it is replaced by its stored copy.
  const [docx, setDocx] = useState<string | null>(null)
  const [models, setModels] = useState<AgentModel[]>([])
  // Model picked for a chat not sent yet; null for the default. Stored on the session its first message creates.
  const [newModel, setNewModel] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  // Guard on/off; the main process keeps the setting and applies it.
  const [guard, setGuard] = useState(true)
  const bottom = useRef<HTMLDivElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const opening = useRef<number | null>(null)
  // Bumped when the user opens a chat, so message elements (and their native <details> open state) are not reused across chats.
  const [chatKey, setChatKey] = useState(0)

  // null opens an empty chat; the session is created when its first message is sent.
  const openSession = async (id: number | null): Promise<void> => {
    opening.current = id
    setChatKey((k) => k + 1)
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

  const clearSessions = async (): Promise<void> => {
    await window.api.clearSessions()
    setSessions([])
    openSession(null)
  }

  const renameSession = async (id: number, title: string): Promise<void> => {
    await window.api.renameSession(id, title)
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, title } : s)))
  }

  const pinSession = async (id: number, pinned: boolean): Promise<void> => {
    await window.api.pinSession(id, pinned)
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, pinned } : s)))
  }

  const session = sessions.find((s) => s.id === sessionId)
  const modelId = (sessionId === null ? newModel : session?.model) ?? models[0]?.id
  const modelLabel = models.find((m) => m.id === modelId)?.label ?? modelId

  // An open chat stores the model for its next message; a new chat keeps it until its first.
  const pickModel = async (id: string): Promise<void> => {
    if (sessionId === null) return setNewModel(id)
    await window.api.setSessionModel(sessionId, id)
    setSessions((list) => list.map((s) => (s.id === sessionId ? { ...s, model: id } : s)))
  }

  const toggleGuard = async (on: boolean): Promise<void> => {
    await window.api.setGuard(on)
    setGuard(on)
  }

  useEffect(() => {
    window.api.models().then(setModels)
    window.api.guard().then(setGuard)
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
    if (!text || pending || !modelId) return
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
      const reply = await window.api.send(sessionId, content, modelId)
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

  const liveSkills = toolLog.filter((t) => t.name === 'loadSkill')
  const liveTools = toolLog.filter((t) => t.name !== 'loadSkill')

  return (
    <ViewDocx.Provider value={setDocx}>
      <div className="app">
        <Sidebar
          sessions={sessions}
          sessionId={sessionId}
          disabled={pending}
          onOpen={openSession}
          onDelete={deleteSession}
          onClear={clearSessions}
          onRename={renameSession}
          onPin={pinSession}
          guard={guard}
          onGuard={toggleGuard}
        />
        <div className="chat">
          <ChatHeader session={session} />
          <main className="messages">
            {messages.map((m, i) => (
              <div key={`${chatKey}-${i}`} className={`msg ${m.role}`}>
                {m.role === 'assistant' ? (
                  <>
                    {m.turn && <TurnInfo turn={m.turn} />}
                    <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
                      {linkifyPaths(noBr(m.content))}
                    </Markdown>
                  </>
                ) : (
                  <UserMessage content={m.content} />
                )}
              </div>
            ))}
            {pending && (
              <div className="msg assistant pending">
                {liveSkills.length > 0 && (
                  <details className="turn">
                    <summary>
                      <span className="turn-input">Skill: {liveSkills.map((t) => t.skill).join(', ')}</span>
                    </summary>
                    {liveSkills.map((t) => (
                      <div key={t.id} className={t.running ? 'tool-line running' : 'tool-line'}>
                        {t.running ? '⏳' : '✓'} Skill Use : {t.skill ?? ''}
                      </div>
                    ))}
                  </details>
                )}
                {liveTools.length > 0 && (
                  <details className="turn">
                    <summary>
                      <span className="turn-input">{liveToolSummary(liveTools)}</span>
                    </summary>
                    {liveTools.map((t) => (
                      <div key={t.id}>
                        <div className={t.running ? 'tool-line running' : 'tool-line'}>
                          {t.running ? '⏳' : '✓'} tool call : {t.name}
                        </div>
                        {jev[t.id] && (
                          <div className={`jev-line jev-${jev[t.id]}`}>
                            Guard : {JEV_TEXT[jev[t.id]]}
                          </div>
                        )}
                        {toolOutput[t.id] && (
                          <details className="tool-result">
                            <summary>
                              <span className="turn-input">output</span>
                            </summary>
                            <pre className="tool-output">{toolOutput[t.id]}</pre>
                          </details>
                        )}
                      </div>
                    ))}
                  </details>
                )}
                {streamed && (
                  <Markdown remarkPlugins={[remarkGfm]} components={liveComponents} urlTransform={urlTransform}>
                    {linkifyPaths(noBr(streamed))}
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
                {approval.risk && <div className="risk">🔴 Guard ประเมินว่า risk: {approval.risk.reason}</div>}
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
            {modelId && (
              <div className="composer-footer">
                <button
                  type="button"
                  className="model-badge"
                  title="เปลี่ยนโมเดล"
                  disabled={pending}
                  onClick={() => setPicking(true)}
                >
                  {modelLabel}
                </button>
                <span
                  className={`guard-badge ${guard ? 'on' : 'off'}`}
                  role="status"
                  aria-label={guard ? 'Guard เปิด' : 'Guard ปิด'}
                  title={
                    guard
                      ? 'Guard เปิด: คำสั่งเสี่ยงต้องขออนุมัติก่อนรัน ปิดได้ที่เมนูโปรไฟล์'
                      : 'Guard ปิด: คำสั่งรันโดยไม่ถาม เปิดได้ที่เมนูโปรไฟล์'
                  }
                >
                  {guard ? 'Guard ✓' : 'Guard ✗'}
                </span>
              </div>
            )}
          </form>
        </div>
      </div>
      {docx && <DocxViewer path={docx} onClose={() => setDocx(null)} />}
      {picking && modelId && (
        <ModelPicker models={models} current={modelId} onPick={pickModel} onClose={() => setPicking(false)} />
      )}
    </ViewDocx.Provider>
  )
}

export default App
