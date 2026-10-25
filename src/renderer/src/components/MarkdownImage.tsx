import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExtraProps } from 'react-markdown'

// The full image in a modal <dialog>: Esc, the close button or a click anywhere closes it.
function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])
  return (
    <dialog ref={dialog} className="image-viewer" aria-label={alt || 'รูป'} onClose={onClose} onClick={() => dialog.current?.close()}>
      <button type="button" className="image-viewer-close" aria-label="ปิด" title="ปิด">
        ×
      </button>
      <img src={src} alt={alt} />
    </dialog>
  )
}

// An answer's ![alt](src), loaded by the main process (image:load) as a data: URL; the raw src never reaches the DOM.
function MarkdownImage({ src, alt = '' }: React.ComponentProps<'img'> & ExtraProps): React.JSX.Element {
  // The result with the src it is for, so a changed src shows the placeholder until its own result arrives.
  const [loaded, setLoaded] = useState<{ for: string; result: { src: string } | { error: string } } | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!src) return
    let stale = false
    window.api
      .loadImage(src)
      .catch(() => ({ error: 'โหลดรูปไม่ได้' }))
      .then((result) => !stale && setLoaded({ for: src, result }))
    return () => {
      stale = true
    }
  }, [src])

  const image = !src ? { error: 'ไม่มีที่อยู่รูป' } : loaded?.for === src ? loaded.result : null
  if (!image) return <span className="md-image-status">กำลังโหลดรูป…</span>
  if ('error' in image)
    return (
      <span className="md-image-status error">
        {alt && `${alt}: `}
        {image.error}
      </span>
    )
  return (
    <>
      <button type="button" className="md-image" title="คลิกเพื่อขยาย" onClick={() => setOpen(true)}>
        <img src={image.src} alt={alt} />
      </button>
      {/* In <body>, since a <dialog> may not sit inside the answer's <p>. */}
      {open && createPortal(<ImageViewer src={image.src} alt={alt} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

export default MarkdownImage
