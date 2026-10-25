import { useEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'

// The installed skills in a modal <dialog>, in MemoryList's frame: Esc, a backdrop click or × close it. Read-only.
function SkillList({ onClose }: { onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  // null until loaded.
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
    window.api.skills().then(setSkills)
  }, [])

  return (
    <dialog
      ref={dialog}
      className="model-picker"
      aria-label="Skills"
      onClose={onClose}
      // The header and list fill the dialog, so a click on the dialog itself is on its backdrop.
      onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
    >
      <header className="model-picker-header">
        <span>{skills ? `Skills (${skills.length})` : 'Skills'}</span>
        <button
          type="button"
          className="model-picker-close"
          aria-label="ปิด"
          title="ปิด"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
      </header>
      <div className="memory-list">
        {skills?.length === 0 && (
          <div className="sessions-empty">ยังไม่มี skill ที่ติดตั้ง บอก agent ให้ติดตั้งจาก GitHub ได้</div>
        )}
        {skills?.map((s) => (
          <div key={s.dir} className="memory-item">
            <div className="memory-text">
              <strong className="skill-name">{s.name}</strong>
              <span className="skill-description" title={s.description}>
                {s.description}
              </span>
              <button
                type="button"
                className="skill-open"
                onClick={() => window.api.openPath(s.dir).then((err) => err && alert(err))}
              >
                <FolderOpen size={13} aria-hidden="true" />
                เปิดโฟลเดอร์
              </button>
            </div>
          </div>
        ))}
      </div>
    </dialog>
  )
}

export default SkillList
