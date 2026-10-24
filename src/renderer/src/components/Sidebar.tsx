import { useEffect, useState } from 'react'

const MIN_WIDTH = 180
const MAX_WIDTH = 480
const COLLAPSE_BELOW = 120
const DEFAULT_WIDTH = 240

type Layout = { width: number; collapsed: boolean }

function loadLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem('sidebar') ?? '')
    if (typeof saved.width === 'number' && typeof saved.collapsed === 'boolean') return saved
  } catch {
    // no saved layout
  }
  return { width: DEFAULT_WIDTH, collapsed: false }
}

// ponytail: folder names may contain spaces, so a later "/" in the same title can be swallowed into a Windows path.
const winPath = /(?<![\w])[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]*[\\/])*[^\\/:*?"<>|\s]*/g
const bashPath = /(^|[\s"'(`])([~.]*\/[^\s/"'`]+\/[^\s"'`]*)/g
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

// Paths shown as just their file or folder name, so titles that start with a long path stay distinguishable.
export const displayTitle = (title: string): string =>
  title.replace(winPath, (p) => baseName(p)).replace(bashPath, (_, lead: string, p: string) => lead + baseName(p))

const DAY = 86_400_000
const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

const groupOf = (days: number): string =>
  days <= 0 ? 'วันนี้' : days === 1 ? 'เมื่อวาน' : days <= 7 ? '7 วันที่ผ่านมา' : days <= 30 ? '30 วันที่ผ่านมา' : 'เก่ากว่า'

const timeOf = (d: Date, days: number): string =>
  days <= 0
    ? d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('th-TH', {
        day: 'numeric',
        month: 'short',
        year: d.getFullYear() === new Date().getFullYear() ? undefined : '2-digit'
      })

const trashIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </svg>
)

type Props = {
  sessions: Session[]
  sessionId: number | null
  disabled: boolean
  onOpen: (id: number | null) => void
  onDelete: (id: number) => void
}

function Sidebar({ sessions, sessionId, disabled, onOpen, onDelete }: Props): React.JSX.Element {
  const [layout, setLayout] = useState(loadLayout)
  const [dragging, setDragging] = useState(false)
  const [query, setQuery] = useState('')

  // Sessions arrive newest first, so groups fill in display order and empty ones never appear.
  const today = dayStart(new Date())
  const q = query.trim().toLowerCase()
  const groups = new Map<string, React.JSX.Element[]>()
  for (const s of sessions) {
    const title = displayTitle(s.title)
    if (q && !`${s.title}\n${title}`.toLowerCase().includes(q)) continue
    const updated = new Date(s.updatedAt)
    const days = Math.round((today - dayStart(updated)) / DAY)
    const group = groupOf(days)
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(
      <div key={s.id} className={s.id === sessionId ? 'session active' : 'session'}>
        <button
          className="session-open"
          onClick={() => onOpen(s.id)}
          disabled={disabled}
          title={s.title}
          aria-current={s.id === sessionId ? 'page' : undefined}
        >
          <span className="session-title">{title}</span>
          <time className="session-time" dateTime={updated.toISOString()}>
            {timeOf(updated, days)}
          </time>
        </button>
        <button
          className="session-delete"
          onClick={() => {
            if (confirm(`ลบแชต "${title}" และข้อความทั้งหมด?`)) onDelete(s.id)
          }}
          disabled={disabled}
          aria-label={`ลบแชต ${title}`}
          title="ลบแชต"
        >
          {trashIcon}
        </button>
      </div>
    )
  }

  useEffect(() => {
    try {
      localStorage.setItem('sidebar', JSON.stringify(layout))
    } catch {
      // storage unavailable; layout just isn't remembered
    }
  }, [layout])

  const toggle = (): void => setLayout((l) => ({ ...l, collapsed: !l.collapsed }))

  // The sidebar starts at x = 0, so the pointer's x is the new width.
  // Dragging below the threshold collapses it and keeps the last width for when it expands again.
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragging) return
    const x = e.clientX
    setLayout((l) =>
      x < COLLAPSE_BELOW
        ? { ...l, collapsed: true }
        : { width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, x)), collapsed: false }
    )
  }

  return (
    <>
      <aside
        className={dragging ? 'sidebar dragging' : 'sidebar'}
        style={{ width: layout.collapsed ? 0 : layout.width }}
        aria-hidden={layout.collapsed}
      >
        <div className="sidebar-inner" style={{ width: layout.width }}>
          <button className="new-session" onClick={() => onOpen(null)} disabled={disabled}>
            + แชตใหม่
          </button>
          <input
            className="session-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาแชต"
            aria-label="ค้นหาแชต"
          />
          <nav className="sessions">
            {[...groups].map(([label, items]) => (
              <section key={label}>
                <h3 className="session-group">{label}</h3>
                {items}
              </section>
            ))}
            {q && groups.size === 0 && <div className="sessions-empty">ไม่พบแชต</div>}
          </nav>
        </div>
      </aside>
      <div
        className={dragging ? 'resizer dragging' : 'resizer'}
        role="separator"
        aria-orientation="vertical"
        title="ลากเพื่อปรับขนาด ลากไปซ้ายสุดเพื่อยุบ ดับเบิลคลิกเพื่อยุบ/กาง"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={toggle}
      >
        <button
          className="sidebar-toggle"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggle}
          aria-label={layout.collapsed ? 'กางเมนู' : 'ยุบเมนู'}
          title={layout.collapsed ? 'กางเมนู' : 'ยุบเมนู'}
        >
          {layout.collapsed ? '»' : '«'}
        </button>
      </div>
    </>
  )
}

export default Sidebar
