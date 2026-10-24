import { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'

// A read-only .docx file as Word-like pages, in a modal <dialog>: it keeps focus inside, closes on Esc
// and gives focus back to the link that opened it.
function DocxViewer({ path, onClose }: { path: string; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const pages = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const name = path.split(/[\\/]/).pop() || path

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
    let stale = false
    window.api
      .readDocx(path)
      .then((data) => {
        if (stale) return
        if (typeof data === 'string') return setError(data)
        // Images as data: URLs, which the page's CSP allows; Word's own page breaks split the pages.
        return renderAsync(data, pages.current!, undefined, {
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          useBase64URL: true
        })
      })
      .catch(
        () => !stale && setError(`แสดงเอกสารนี้ไม่ได้ ไฟล์อาจเสียหรือไม่ใช่ไฟล์ Word: ${path}`)
      )
      .finally(() => !stale && setLoading(false))
    return () => {
      stale = true
    }
  }, [path])

  return (
    <dialog
      ref={dialog}
      className="docx-viewer"
      aria-label={name}
      onClose={onClose}
      // The header and body fill the dialog, so a click on the dialog itself is on its backdrop.
      onClick={(e) => e.target === e.currentTarget && dialog.current?.close()}
    >
      <header className="docx-viewer-header">
        <span className="docx-viewer-title" title={path}>
          {name}
        </span>
        <button
          type="button"
          onClick={() => window.api.openPath(path).then((err) => err && alert(err))}
        >
          เปิดใน Word
        </button>
        <button
          type="button"
          className="docx-viewer-close"
          aria-label="ปิด"
          title="ปิด"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
      </header>
      <div className="docx-viewer-body">
        {loading && <div className="docx-viewer-status">กำลังเปิดเอกสาร…</div>}
        {error && <div className="docx-viewer-status error">{error}</div>}
        <div ref={pages} hidden={loading || !!error} />
      </div>
    </dialog>
  )
}

export default DocxViewer
