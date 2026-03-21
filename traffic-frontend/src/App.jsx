import { useMemo } from 'react'
import useWebSocket from './hooks/useWebSocket'
import { useSimulationStore } from './store/simulationStore'
import CesiumMap from './components/CesiumMap/CesiumMap'
import AIPanel from './components/AIPanel/AIPanel'

// ── Mock mode toggle ────────────────────────────────────────────────────────
const MOCK_MODE = true

// ── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:         '#0A1628',
  bar:        '#071020',
  border:     '#0f2040',
  accent:     '#2E75B6',
  accentText: '#60a5fa',
  muted:      '#3b5170',
  text:       '#e2e8f0',
  textDim:    '#64748b',
  green:      '#22c55e',
  red:        '#ef4444',
}

// ── Stat tile ────────────────────────────────────────────────────────────────
function StatTile({ label, value, unit, accent }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 1, minWidth: 120, padding: '0 20px',
      borderRight: `1px solid ${C.border}`,
    }}>
      <span style={{
        fontSize: 22, fontWeight: 800, lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
        color: accent ?? C.accentText,
        letterSpacing: '-0.01em',
      }}>
        {value}
        {unit && (
          <span style={{ fontSize: 11, fontWeight: 500, color: C.muted, marginLeft: 3 }}>
            {unit}
          </span>
        )}
      </span>
      <span style={{
        fontSize: 9, fontWeight: 600, color: C.textDim,
        letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 2,
      }}>
        {label}
      </span>
    </div>
  )
}

// ── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const { isConnected } = useWebSocket()

  // When mock mode, skip WebSocket connection check
  const displayConnected = MOCK_MODE ? true : isConnected

  const step          = useSimulationStore((s) => s.step)
  const vehicles      = useSimulationStore((s) => s.vehicles)
  const trafficLights = useSimulationStore((s) => s.trafficLights)
  const totalRerouted = useSimulationStore((s) => s.totalRerouted)

  // Average network speed in km/h (vehicles report m/s)
  const avgSpeedKmh = useMemo(() => {
    if (!vehicles.length) return 0
    const sum = vehicles.reduce((acc, v) => acc + (v.speed ?? 0), 0)
    return Math.round((sum / vehicles.length) * 3.6)
  }, [vehicles])

  return (
    <div style={{
      width: '100vw', height: '100vh',
      display: 'flex', flexDirection: 'column',
      background: C.bg, color: C.text,
      overflow: 'hidden', fontFamily: 'system-ui, sans-serif',
    }}>

      {/* ── Top status bar (40px) ───────────────────────────────────────── */}
      <header style={{
        height: 40, flexShrink: 0,
        background: C.bar,
        borderBottom: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center',
        padding: '0 18px', gap: 0,
      }}>
        {/* Left — title */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
          </svg>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text, letterSpacing: '0.02em' }}>
            Traffic Simulation Dashboard
          </span>
          <span style={{ fontSize: 12, color: C.muted }}>—</span>
          <span style={{ fontSize: 12, color: C.accentText, fontWeight: 500 }}>
            Riyadh, Saudi Arabia
          </span>
        </div>

        {/* Center — step counter */}
        <div style={{
          position: 'absolute', left: '50%', transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 7,
        }}>
          <span style={{ fontSize: 10, color: C.muted, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Step
          </span>
          <span style={{
            fontSize: 15, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
            color: C.accentText, minWidth: 52, textAlign: 'right', lineHeight: 1,
          }}>
            {step.toLocaleString()}
          </span>
        </div>

        {/* Right — connection */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: displayConnected ? C.green : C.red,
            boxShadow: displayConnected ? `0 0 6px ${C.green}` : 'none',
            display: 'inline-block',
            animation: displayConnected ? 'topPulse 2s ease-out infinite' : 'none',
          }} />
          {displayConnected ? (
            <span style={{
              fontSize: 10, fontWeight: 800, letterSpacing: '0.14em',
              padding: '2px 7px', borderRadius: 3,
              background: '#052e16', color: C.green,
              border: `1px solid #14532d`,
            }}>
              LIVE
            </span>
          ) : (
            <span style={{ fontSize: 11, color: C.red, fontWeight: 600 }}>OFFLINE</span>
          )}
        </div>
      </header>

      {/* ── Middle: map + AI panel ──────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {/* Map */}
        <div style={{ flex: 1, position: 'relative' }}>
          <CesiumMap />
        </div>

        {/* AI Panel */}
        <AIPanel />

        {/* Loading overlay — shown while disconnected (never in mock mode) */}
        {!displayConnected && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(10,22,40,0.82)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 16,
            backdropFilter: 'blur(3px)',
            zIndex: 100,
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: '50%',
              border: `3px solid ${C.border}`,
              borderTop: `3px solid ${C.accent}`,
              animation: 'spin 0.9s linear infinite',
            }} />
            <p style={{ fontSize: 14, color: C.accentText, fontWeight: 600, letterSpacing: '0.04em' }}>
              Connecting to simulation…
            </p>
            <p style={{ fontSize: 11, color: C.muted }}>
              {`${import.meta.env.VITE_WS_URL}/ws/simulation`}
            </p>
          </div>
        )}
      </div>

      {/* ── Bottom stats bar (60px) ─────────────────────────────────────── */}
      <footer style={{
        height: 60, flexShrink: 0,
        background: C.bar,
        borderTop: `1px solid ${C.border}`,
        display: 'flex', alignItems: 'center',
        paddingLeft: 18,
        overflow: 'hidden',
      }}>
        <StatTile
          label="Vehicles on road"
          value={vehicles.length.toLocaleString()}
        />
        <StatTile
          label="Avg network speed"
          value={avgSpeedKmh}
          unit="km/h"
          accent={avgSpeedKmh > 36 ? C.green : avgSpeedKmh > 11 ? '#f59e0b' : C.red}
        />
        <StatTile
          label="Active traffic lights"
          value={trafficLights.length}
          accent={C.accentText}
        />
        <StatTile
          label="Rerouted this session"
          value={totalRerouted.toLocaleString()}
          accent={totalRerouted > 0 ? '#f59e0b' : C.textDim}
        />

        {/* Spacer + branding */}
        <div style={{ flex: 1 }} />
        <div style={{
          paddingRight: 20,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.18em',
            textTransform: 'uppercase', color: C.muted,
          }}>
            Smart City Traffic · SUMO + AI
          </span>
        </div>
      </footer>

      {/* Global keyframes */}
      <style>{`
        @keyframes topPulse {
          0%   { box-shadow: 0 0 0 0   rgba(34,197,94,0.8); }
          70%  { box-shadow: 0 0 0 7px rgba(34,197,94,0);   }
          100% { box-shadow: 0 0 0 0   rgba(34,197,94,0);   }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #0f2040; border-radius: 3px; }
      `}</style>
    </div>
  )
}
