import { createContext, useContext } from 'react'
import type { ExtraProps } from 'react-markdown'

// Prefix of a link's href that FileLink opens as a local file.
export const OPEN = '#open:'

// Shows a .docx file in App's DocxViewer.
export const ViewDocx = createContext<(path: string) => void>(() => {})

// ponytail: regex path detection; a path followed by more text with another ".ext" can over-match.
const pathRe = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n`]+[\\/])*[^\\/:*?"<>|\r\n`]+\.[A-Za-z0-9]{1,8}/g

const toLink = (path: string): string => `[\`${path}\`](${OPEN}${encodeURIComponent(path)})`

// Turns Windows file paths in markdown into links, leaving fenced code blocks and images (![alt](path) or
// ![alt](<path>)) alone.
export function linkifyPaths(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|!\[[^\]\n]*\]\((?:<[^>\n]*>|[^)\n]*)[^)\n]*\))/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(new RegExp('`(' + pathRe.source + ')`|' + pathRe.source, 'g'), (m, inCode?: string) =>
            toLink(inCode ?? m)
          )
    )
    .join('')
}

// A .docx file opens in the in-app viewer; any other file opens in its default app.
function FileLink({ node: _node, href, children, ...props }: React.ComponentProps<'a'> & ExtraProps): React.JSX.Element {
  const viewDocx = useContext(ViewDocx)
  if (!href?.startsWith(OPEN)) {
    // A bare URL autolinked by remark-gfm (text equals href) shows only its hostname.
    const bare = /^https?:\/\//.test(href ?? '') && children === href
    let label = children
    if (bare)
      try {
        label = new URL(href!).hostname.replace(/^www\./, '')
      } catch {}
    return (
      <a href={href} target="_blank" rel="noreferrer" {...props} title={bare ? href : props.title}>
        {label}
      </a>
    )
  }
  const path = decodeURIComponent(href.slice(OPEN.length))
  const open = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    if (/\.docx$/i.test(path)) return viewDocx(path)
    const error = await window.api.openPath(path)
    if (error) alert(error)
  }
  return (
    <a href={href} className="file-link" onClick={open} title={`เปิด ${path}`} {...props}>
      {children}
    </a>
  )
}

export default FileLink
