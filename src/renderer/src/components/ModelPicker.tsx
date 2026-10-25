import { useEffect, useRef } from 'react'

const price = (n: number): string => `$${n.toFixed(2)}`

// The agent models in a modal <dialog>, like DocxViewer: Esc, a backdrop click or × close it.
// Picking a model calls onPick, then closes.
function ModelPicker({
  models,
  current,
  onPick,
  onClose
}: {
  models: AgentModel[]
  current: string
  onPick: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="model-picker"
      aria-label="เลือกโมเดล"
      onClose={onClose}
      // The header and list fill the dialog, so a click on the dialog itself is on its backdrop.
      onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
    >
      <header className="model-picker-header">
        <span>เลือกโมเดล</span>
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
      <div className="model-picker-list">
        {models.map((m) => (
          <button
            key={m.id}
            type="button"
            className={m.id === current ? 'model-option current' : 'model-option'}
            aria-current={m.id === current}
            onClick={() => {
              onPick(m.id)
              dialog.current?.close()
            }}
          >
            <span className="model-option-name">
              {m.label}
              <small>{m.id}</small>
            </span>
            <span className="model-option-price" title="ราคาต่อ 1M tokens: input / output">
              {price(m.input)} / {price(m.output)}
            </span>
            <span className="model-option-check" aria-hidden>
              {m.id === current ? '✓' : ''}
            </span>
          </button>
        ))}
      </div>
    </dialog>
  )
}

export default ModelPicker
