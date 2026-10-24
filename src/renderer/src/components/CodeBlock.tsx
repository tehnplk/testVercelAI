import { useRef, useState } from 'react'
import type { ExtraProps } from 'react-markdown'

const copyIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

const checkIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

// `node` comes from react-markdown and must not reach the DOM.
function CodeBlock({ node: _node, children, ...props }: React.ComponentProps<'pre'> & ExtraProps): React.JSX.Element {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(pre.current?.innerText ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="code-block">
      <pre ref={pre} {...props}>
        {children}
      </pre>
      <button className="copy" onClick={copy} title={copied ? 'คัดลอกแล้ว' : 'คัดลอก'} aria-label="คัดลอก">
        {copied ? checkIcon : copyIcon}
      </button>
    </div>
  )
}

export default CodeBlock
