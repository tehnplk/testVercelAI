import { useEffect, useRef, useState } from 'react'
import { Trash } from 'lucide-react'

// The agent's saved notes in a modal <dialog>, in ModelPicker's frame: Esc, a backdrop click or × close it.
// Each note can be deleted; the agent no longer sees it from the next message on.
function MemoryList({ onClose }: { onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  // null until loaded.
  const [notes, setNotes] = useState<Memory[] | null>(null)

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
    window.api.memories().then(setNotes)
  }, [])

  const remove = async (n: Memory): Promise<void> => {
    if (!confirm(`ลบความจำ "${n.content}"?`)) return
    await window.api.deleteMemory(n.id)
    setNotes((all) => all && all.filter((x) => x.id !== n.id))
  }

  return (
    <dialog
      ref={dialog}
      className="model-picker"
      aria-label="ความจำ"
      onClose={onClose}
      // The header and list fill the dialog, so a click on the dialog itself is on its backdrop.
      onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
    >
      <header className="model-picker-header">
        <span>ความจำ</span>
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
        {notes?.length === 0 && (
          <div className="sessions-empty">ยังไม่มีความจำ บอก agent ว่า &quot;จำไว้ว่า…&quot; เพื่อให้จำข้ามแชต</div>
        )}
        {notes?.map((n) => (
          <div key={n.id} className="memory-item">
            <div className="memory-text">
              {n.content}
              <time dateTime={new Date(n.createdAt).toISOString()}>
                {new Date(n.createdAt).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })}
              </time>
            </div>
            <button
              type="button"
              className="memory-delete"
              onClick={() => remove(n)}
              aria-label={`ลบความจำ ${n.content}`}
              title="ลบ"
            >
              <Trash size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </dialog>
  )
}

export default MemoryList
