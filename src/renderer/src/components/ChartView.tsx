import { useEffect, useRef, useState } from 'react'
import { Chart, type ChartConfiguration } from 'chart.js/auto'

// A Chart.js chart at a fixed height, as wide as the answer allows; destroyed on unmount.
function ChartView({ config }: { config: ChartConfiguration }): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  // The chart is redrawn when the theme switches, since its colors are read from CSS once per draw.
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)

  useEffect(() => {
    const html = document.documentElement
    const observer = new MutationObserver(() => setTheme(html.dataset.theme))
    observer.observe(html, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    // Labels and grid lines in the app's theme colors and font. Grid colors are set on the scales, not as
    // Chart.defaults.borderColor, which would stop Chart.js's Colors plugin from coloring the data.
    const css = getComputedStyle(document.documentElement)
    const grid = css.getPropertyValue('--ev-c-gray-2')
    Chart.defaults.color = css.getPropertyValue('--ev-c-text-2')
    Chart.defaults.set('scale', { grid: { color: grid }, border: { color: grid } })
    // Radar and polar area tick labels sit on a white box by default.
    Chart.defaults.set('scales.radialLinear', { angleLines: { color: grid }, ticks: { backdropColor: 'transparent' } })
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily
    let chart: Chart | undefined
    try {
      chart = new Chart(canvas.current!, {
        ...config,
        options: { ...config.options, responsive: true, maintainAspectRatio: false }
      })
    } catch (e) {
      // e.g. an unknown scale type in options: '"foo" is not a registered scale.'
      // eslint-disable-next-line react-hooks/set-state-in-effect -- only known once Chart.js has tried
      setError(e instanceof Error ? e.message : String(e))
    }
    return () => chart?.destroy()
  }, [config, theme])

  return (
    <div className="chart">
      {error && <div className="chart-error">แสดงกราฟไม่ได้: {error}</div>}
      <canvas ref={canvas} hidden={!!error} role="img" aria-label="กราฟ" />
    </div>
  )
}

export default ChartView
