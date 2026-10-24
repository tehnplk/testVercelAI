import type { ExtraProps } from 'react-markdown'

// Prefix of a link's href that FileLink opens as a local file.
export const OPEN = '#open:'

// ponytail: regex path detection; a path followed by more text with another ".ext" can over-match.
const pathRe = /[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n`]+[\\/])*[^\\/:*?"<>|\r\n`]+\.[A-Za-z0-9]{1,8}/g

const toLink = (path: string): string => `[\`${path}\`](${OPEN}${encodeURIComponent(path)})`

// Turns Windows file paths in markdown into links, leaving fenced code blocks alone.
export function linkifyPaths(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(new RegExp('`(' + pathRe.source + ')`|' + pathRe.source, 'g'), (m, inCode?: string) =>
            toLink(inCode ?? m)
          )
    )
    .join('')
}

function FileLink({ node: _node, href, children, ...props }: React.ComponentProps<'a'> & ExtraProps): React.JSX.Element {
  if (!href?.startsWith(OPEN))
    return (
      <a href={href} target="_blank" rel="noreferrer" {...props}>
        {children}
      </a>
    )
  const path = decodeURIComponent(href.slice(OPEN.length))
  const open = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
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
