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

type Props = {
  sessions: Session[]
  sessionId: number | null
  disabled: boolean
  onOpen: (id: number | null) => void
}

function Sidebar({ sessions, sessionId, disabled, onOpen }: Props): React.JSX.Element {
  const [layout, setLayout] = useState(loadLayout)
  const [dragging, setDragging] = useState(false)

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
          <nav className="sessions">
            {sessions.map((s) => (
              <button
                key={s.id}
                className={s.id === sessionId ? 'session active' : 'session'}
                onClick={() => onOpen(s.id)}
                disabled={disabled}
                title={s.title}
              >
                {s.title}
              </button>
            ))}
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
