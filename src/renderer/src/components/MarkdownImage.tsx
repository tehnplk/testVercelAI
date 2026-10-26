import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExtraProps } from 'react-markdown'
import FileLink, { OPEN, video } from './FileLink'

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

// A local video file, streamed by the main process's app-media: scheme (serveVideo), which checks the path.
function MarkdownVideo({ src, alt }: { src: string; alt: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  let path = ''
  try {
    path = decodeURIComponent(src.replace(/^file:\/\/\//i, ''))
  } catch {
    /* app-media refuses the empty path */
  }
  const name = path.split(/[\\/]/).pop() || path
  return (
    <span className="md-video">
      {failed ? (
        <span className="md-image-status error">
          {alt && `${alt}: `}เล่นวิดีโอไม่ได้
        </span>
      ) : (
        <video
          controls
          preload="metadata"
          src={'app-media://video/' + encodeURIComponent(path)}
          aria-label={alt || name}
          onError={() => setFailed(true)}
        />
      )}
      <span className="md-video-caption">
        {name} · <FileLink href={OPEN + encodeURIComponent(path)}>เปิด</FileLink>
      </span>
    </span>
  )
}

// An answer's ![alt](src): a local video file plays in a <video> (a web URL ending in .mp4 still goes to
// image:load, which refuses it); an image is loaded by the main process (image:load)
// as a data: URL, so the raw src never reaches the DOM.
function MarkdownImage({ src, alt = '' }: React.ComponentProps<'img'> & ExtraProps): React.JSX.Element {
  if (src && video.test(src) && !/^https?:\/\//i.test(src)) return <MarkdownVideo key={src} src={src} alt={alt} />
  return <LoadedImage src={src} alt={alt} />
}

function LoadedImage({ src, alt }: { src?: string; alt: string }): React.JSX.Element {
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
