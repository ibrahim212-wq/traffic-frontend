import { RadialBarChart, RadialBar, ResponsiveContainer } from 'recharts'
import { useSimulationStore } from '../../store/simulationStore'

/** Map a 0-100 confidence percentage to an RGBA colour string. */
function confidenceColor(pct) {
  if (pct > 80) return '#22c55e'   // green-500
  if (pct >= 50) return '#eab308'  // yellow-500
  return '#ef4444'                  // red-500
}

/**
 * ConfidenceChart – RadialBarChart displaying the current AI confidence score.
 * Reads `aiDecision.confidence` from the Zustand store; no props required.
 *
 * Visual:
 *   - Single arc ring, 0-100% scale
 *   - Arc colour: green >80%, yellow 50-80%, red <50%
 *   - Centre label: "{pct}% / confident"
 */
export default function ConfidenceChart() {
  const confidence = useSimulationStore((s) => s.aiDecision?.confidence ?? 0)
  const pct = Math.round(confidence * 100)
  const color = confidenceColor(pct)

  const data = [{ value: pct, fill: color }]

  return (
    <div style={{ position: 'relative', width: '100%', height: 150 }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          cx="50%"
          cy="50%"
          innerRadius="58%"
          outerRadius="82%"
          startAngle={90}
          endAngle={-270}
          data={data}
          domain={[0, 100]}
          barSize={14}
        >
          {/* Background track */}
          <RadialBar
            dataKey="value"
            cornerRadius={7}
            background={{ fill: '#1e293b' }}
            isAnimationActive
            animationDuration={500}
            animationEasing="ease-out"
          />
        </RadialBarChart>
      </ResponsiveContainer>

      {/* Centre label — absolutely positioned over the chart */}
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        gap: 2,
      }}>
        <span style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
          {pct}%
        </span>
        <span style={{ fontSize: 10, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          confident
        </span>
      </div>
    </div>
  )
}
