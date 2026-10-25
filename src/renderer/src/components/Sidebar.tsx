import { useEffect, useRef, useState } from 'react'
import { Bookmark, Check, Moon, Pencil, Pin, Puzzle, Shield, ShieldOff, Sun, SunMoon, Trash, Trash2 } from 'lucide-react'
import MemoryList from './MemoryList'
import SkillList from './SkillList'

const MIN_WIDTH = 180
const COLLAPSE_BELOW = 120
const STORAGE_KEY = 'sidebar.v2'

// Max is half the screen width; the default starts at a quarter of it.
const maxWidth = (): number => Math.max(MIN_WIDTH, Math.round(window.screen.width * 0.5))
const defaultWidth = (): number => Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(window.screen.width * 0.25)))

type Layout = { width: number; collapsed: boolean }

function loadLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
    if (typeof saved.width === 'number' && typeof saved.collapsed === 'boolean') return saved
  } catch {
    // no saved layout
  }
  return { width: defaultWidth(), collapsed: false }
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

const trashIcon = <Trash size={14} strokeWidth={2} aria-hidden="true" />

// Filled while the chat is pinned.
const pinIcon = (pinned: boolean): React.JSX.Element => (
  <Pin size={14} strokeWidth={2} fill={pinned ? 'currentColor' : 'none'} aria-hidden="true" />
)

const pencilIcon = <Pencil size={14} strokeWidth={2} aria-hidden="true" />

const checkIcon = <Check size={14} strokeWidth={2} aria-hidden="true" />

// Profile menu icons (16px).
const shieldIcon = (on: boolean): React.JSX.Element =>
  on ? (
    <Shield size={16} strokeWidth={1.75} aria-hidden="true" />
  ) : (
    <ShieldOff size={16} strokeWidth={1.75} aria-hidden="true" />
  )

const memoryIcon = <Bookmark size={16} strokeWidth={1.75} aria-hidden="true" />

const skillsIcon = <Puzzle size={16} strokeWidth={1.75} aria-hidden="true" />

const clearIcon = <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />

const themeIcon = <SunMoon size={16} strokeWidth={1.75} aria-hidden="true" />

// Read once in main.tsx, before the first render.
export const THEME_KEY = 'theme'

type Props = {
  sessions: Session[]
  sessionId: number | null
  disabled: boolean
  onOpen: (id: number | null) => void
  onDelete: (id: number) => void
  onClear: () => void
  onRename: (id: number, title: string) => void
  onPin: (id: number, pinned: boolean) => void
  guard: boolean
  onGuard: (on: boolean) => void
}

function Sidebar({
  sessions,
  sessionId,
  disabled,
  onOpen,
  onDelete,
  onClear,
  onRename,
  onPin,
  guard,
  onGuard
}: Props): React.JSX.Element {
  const [layout, setLayout] = useState(loadLayout)
  const [dragging, setDragging] = useState(false)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<number | null>(null)
  const [showMemory, setShowMemory] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [userName, setUserName] = useState('')
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light')
  const profile = useRef<HTMLDivElement>(null)

  const toggleTheme = (): void => {
    const theme = dark ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // storage unavailable; the theme just isn't remembered
    }
    setDark(!dark)
  }

  useEffect(() => {
    window.api.userName().then(setUserName)
  }, [])

  // Closes on a click outside the profile row or on Esc (focus goes back to the profile button).
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!profile.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setMenuOpen(false)
      profile.current?.querySelector<HTMLElement>('.profile-button')?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // Sessions arrive newest first and pinned ones go first, so groups fill in display order
  // (pinned, then by date) and empty ones never appear.
  const today = dayStart(new Date())
  const q = query.trim().toLowerCase()
  const groups = new Map<string, React.JSX.Element[]>()
  for (const s of [...sessions.filter((x) => x.pinned), ...sessions.filter((x) => !x.pinned)]) {
    const title = displayTitle(s.title)
    if (q && !`${s.title}\n${title}`.toLowerCase().includes(q)) continue
    const updated = new Date(s.updatedAt)
    const days = Math.round((today - dayStart(updated)) / DAY)
    const group = s.pinned ? 'ปักหมุด' : groupOf(days)
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(
      <div key={s.id} className={s.id === sessionId ? 'session active' : 'session'}>
        {renaming === s.id ? (
          // Enter or blur saves; Esc puts the old title back first, so the save is skipped. Empty cancels too.
          // The check button only blurs the input, so blur stays the single save point.
          <>
            <input
              className="session-rename"
              defaultValue={s.title}
              maxLength={200}
              autoFocus
              aria-label="ชื่อแชต"
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') e.currentTarget.value = s.title
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
              }}
              onBlur={(e) => {
                const t = e.currentTarget.value.trim()
                if (t && t !== s.title) onRename(s.id, t)
                setRenaming(null)
              }}
            />
            <button
              className="session-save"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => (e.currentTarget.previousElementSibling as HTMLInputElement).blur()}
              aria-label="บันทึกชื่อ"
              title="บันทึกชื่อ"
            >
              {checkIcon}
            </button>
          </>
        ) : (
          <>
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
            <div className="session-actions">
              <button
                onClick={() => onPin(s.id, !s.pinned)}
                disabled={disabled}
                aria-label={s.pinned ? 'เลิกปักหมุด' : 'ปักหมุด'}
                title={s.pinned ? 'เลิกปักหมุด' : 'ปักหมุด'}
              >
                {pinIcon(s.pinned)}
              </button>
              <button onClick={() => setRenaming(s.id)} disabled={disabled} aria-label="เปลี่ยนชื่อ" title="เปลี่ยนชื่อ">
                {pencilIcon}
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
          </>
        )}
      </div>
    )
  }

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
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
        : { width: Math.min(maxWidth(), Math.max(MIN_WIDTH, x)), collapsed: false }
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
          <div className="profile" ref={profile}>
            {menuOpen && (
              <div className="profile-menu" role="menu">
                {/* Like Guard: toggles at once and keeps the menu open. Checked = dark. */}
                <button role="menuitemcheckbox" aria-checked={dark} aria-label="ธีมมืด" onClick={toggleTheme}>
                  {themeIcon}
                  ธีม
                  <span className="theme-switch" aria-hidden="true">
                    <Sun className="theme-sun" size={12} strokeWidth={2} />
                    <Moon className="theme-moon" size={12} strokeWidth={2} />
                  </span>
                </button>
                {/* Open while a reply runs too, since that reply's prompt is already built. */}
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowMemory(true)
                  }}
                >
                  {memoryIcon}
                  ความจำ
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowSkills(true)
                  }}
                >
                  {skillsIcon}
                  Skills
                </button>
                {/* Toggles at once both ways and keeps the menu open so the switch visibly moves; the red "Guard ปิด" badge under the chat box is the reminder. */}
                <button role="menuitemcheckbox" aria-checked={guard} onClick={() => onGuard(!guard)}>
                  {shieldIcon(guard)}
                  Guard
                  <span className="switch" aria-hidden="true" />
                </button>
                <button
                  role="menuitem"
                  className="profile-clear"
                  disabled={disabled || sessions.length === 0}
                  onClick={() => {
                    setMenuOpen(false)
                    if (confirm(`ล้างประวัติแชตทั้งหมด ${sessions.length} แชต? การลบนี้ย้อนกลับไม่ได้`)) onClear()
                  }}
                >
                  {clearIcon}
                  ล้างประวัติแชต
                </button>
              </div>
            )}
            <button
              className="profile-button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className="profile-avatar" aria-hidden="true">
                {userName.charAt(0).toUpperCase()}
              </span>
              <span className="profile-name">{userName}</span>
            </button>
          </div>
        </div>
      </aside>
      {showMemory && <MemoryList onClose={() => setShowMemory(false)} />}
      {showSkills && <SkillList onClose={() => setShowSkills(false)} />}
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
