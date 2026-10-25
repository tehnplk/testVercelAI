import { isValidElement, useMemo, useRef, useState } from 'react'
import type { ExtraProps } from 'react-markdown'
import { Check, Copy } from 'lucide-react'
import { Chart, type ChartConfiguration } from 'chart.js/auto'
import ChartView from './ChartView'

const copyIcon = <Copy size={14} strokeWidth={2} aria-hidden="true" />

const checkIcon = <Check size={14} strokeWidth={2} aria-hidden="true" />


// The text of a ```chart block (the <code> react-markdown puts in the <pre>), or null for any other block.
function chartSource(children: React.ReactNode): string | null {
  if (!isValidElement<{ className?: string; children?: React.ReactNode }>(children)) return null
  const { className, children: text } = children.props
  return className === 'language-chart' && typeof text === 'string' ? text : null
}

// A ```chart block's Chart.js config. JSON.parse only, so the model's text can never hold code that runs.
function parseChart(source: string): { config: ChartConfiguration } | { error: string } {
  let config: unknown
  try {
    config = JSON.parse(source)
  } catch {
    return { error: 'JSON ไม่ถูกต้อง' }
  }
  const c = config as Partial<ChartConfiguration> | null
  if (typeof c?.type !== 'string' || typeof c.data !== 'object' || !c.data)
    return { error: 'ต้องมี "type" และ "data"' }
  if (!Chart.registry.controllers.get(c.type)) return { error: `ไม่รู้จักกราฟชนิด "${c.type}"` }
  return { config: c as ChartConfiguration }
}

// `node` comes from react-markdown and must not reach the DOM. A ```chart block shows as a chart; live is set
// while the answer streams, when a chart's JSON is still incomplete, so it shows as code without an error.
function CodeBlock({
  node: _node,
  live,
  children,
  ...props
}: React.ComponentProps<'pre'> & ExtraProps & { live?: boolean }): React.JSX.Element {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const source = chartSource(children)
  // Parsed once per text, so the chart is not redrawn on every streamed delta.
  const chart = useMemo(() => (source === null ? null : parseChart(source)), [source])

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(pre.current?.innerText ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (chart && 'config' in chart) return <ChartView config={chart.config} />
  return (
    <div className="code-block">
      <pre ref={pre} {...props}>
        {children}
      </pre>
      <button className="copy" onClick={copy} title={copied ? 'คัดลอกแล้ว' : 'คัดลอก'} aria-label="คัดลอก">
        {copied ? checkIcon : copyIcon}
      </button>
      {chart && !live && <div className="chart-error">แสดงกราฟไม่ได้: {chart.error}</div>}
    </div>
  )
}

export default CodeBlock
