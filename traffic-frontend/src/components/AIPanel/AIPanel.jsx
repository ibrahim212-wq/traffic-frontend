import { useEffect, useRef, useState } from 'react'
import { useSimulationStore } from '../../store/simulationStore'
import ConfidenceChart from '../ConfidenceChart/ConfidenceChart'

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(ts) {
  if (!ts) return null
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/** Section wrapper with an ALL-CAPS muted label above content. */
function Section({ label, children }) {
  return (
    <div>
      <p style={{
        fontSize: 10, fontWeight: 700, color: '#475569',
        letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 7,
      }}>
        {label}
      </p>
      {children}
    </div>
  )
}

/** Parses a model_used string like "GCN+LSTM (mock)" into coloured badges. */
function ModelBadges({ model = '' }) {
  const isMock = /mock/i.test(model)
  const names = model
    .replace(/\s*\(mock\)/i, '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {names.map((name) => (
        <span key={name} style={{
          fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
          padding: '2px 9px', borderRadius: 4,
          background: isMock ? '#172033' : '#0c2a52',
          color: isMock ? '#64748b' : '#93c5fd',
          border: `1px solid ${isMock ? '#1e293b' : '#1e40af'}`,
        }}>
          {name}
        </span>
      ))}
      {isMock && (
        <span style={{
          fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
          background: '#271c00', color: '#f59e0b', border: '1px solid #78350f',
        }}>
          mock
        </span>
      )}
    </div>
  )
}

/** Small model status bar row (live / mock). */
function ModelStatusRow({ label, active }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
      <span style={{ width: 50, color: '#64748b', flexShrink: 0 }}>{label}</span>
      <div style={{
        flex: 1, height: 3, borderRadius: 2,
        background: '#1e293b', overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', borderRadius: 2,
          width: active ? '100%' : '22%',
          background: active ? '#22c55e' : '#374151',
          transition: 'width 0.5s ease',
        }} />
      </div>
      <span style={{ width: 28, fontSize: 10, color: active ? '#22c55e' : '#374151' }}>
        {active ? 'live' : 'mock'}
      </span>
    </div>
  )
}

// ── AIPanel ──────────────────────────────────────────────────────────────────

/**
 * AIPanel – fixed right-side panel (320 px wide, full height) showing the
 * latest AI Decision Engine output from the Zustand store.
 *
 * Features:
 *  - Pulsing green dot when connected
 *  - Flash border animation (blue) on each new decision
 *  - ConfidenceChart (RadialBar) at the top
 *  - WHAT HAPPENED, WHY, MODEL, FORECAST, REROUTED, MODEL STATUS sections
 *  - Timestamp of last update
 */
export default function AIPanel() {
  const isConnected  = useSimulationStore((s) => s.isConnected)
  const aiDecision   = useSimulationStore((s) => s.aiDecision)

  const [flashing, setFlashing]       = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const prevRef = useRef(null)

  // Detect new decision → flash border, record timestamp
  useEffect(() => {
    if (!aiDecision || aiDecision === prevRef.current) return
    prevRef.current = aiDecision
    setLastUpdated(Date.now())
    setFlashing(true)
    const t = setTimeout(() => setFlashing(false), 650)
    return () => clearTimeout(t)
  }, [aiDecision])

  const forecast = aiDecision?.prophet?.forecast_30min
  const reroutes = aiDecision?.rerouted_vehicles ?? []
  const gcn      = aiDecision?.gcn
  const lstm     = aiDecision?.lstm
  const prophet  = aiDecision?.prophet

  return (
    <div style={{
      width: 320,
      height: '100%',
      flexShrink: 0,
      backgroundColor: '#0F1923',
      display: 'flex',
      flexDirection: 'column',
      borderLeft: `1px solid ${flashing ? '#3b82f6' : '#1a2535'}`,
      boxShadow: flashing ? 'inset 0 0 0 1px #3b82f688' : 'none',
      transition: 'border-color 0.4s ease, box-shadow 0.4s ease',
      overflow: 'hidden',
    }}>

      {/* ── Header ── */}
      <div style={{
        padding: '14px 18px',
        borderBottom: '1px solid #1a2535',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            backgroundColor: isConnected ? '#22c55e' : '#374151',
            animation: isConnected ? 'aiPulse 1.6s ease-out infinite' : 'none',
            display: 'inline-block',
          }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', letterSpacing: '0.03em' }}>
            AI Decision Engine
          </span>
        </div>
        {lastUpdated && (
          <span style={{ fontSize: 10, color: '#334155', fontFamily: 'monospace', flexShrink: 0 }}>
            {formatTime(lastUpdated)}
          </span>
        )}
      </div>

      {/* ── Scrollable body ── */}
      <div style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden',
        padding: '16px 18px',
        display: 'flex', flexDirection: 'column', gap: 20,
        scrollbarWidth: 'thin',
        scrollbarColor: '#1e293b transparent',
      }}>
        {!aiDecision ? (
          <p style={{ color: '#334155', fontSize: 13, textAlign: 'center', marginTop: 48 }}>
            {isConnected ? 'Awaiting first decision…' : 'Not connected'}
          </p>
        ) : (
          <>
            {/* Confidence gauge */}
            <ConfidenceChart />

            {/* WHAT HAPPENED */}
            <Section label="What happened">
              <p style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9', lineHeight: 1.45 }}>
                {aiDecision.action}
              </p>
            </Section>

            {/* WHY */}
            <Section label="Why">
              <p style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.75 }}>
                {aiDecision.why}
              </p>
            </Section>

            {/* MODEL */}
            <Section label="Model">
              <ModelBadges model={aiDecision.model_used ?? ''} />
            </Section>

            {/* FORECAST */}
            {forecast && (
              <Section label="Forecast · next 30 min">
                <div style={{
                  background: '#0a1525', borderRadius: 8,
                  border: '1px solid #1a2535', padding: '12px 14px',
                  display: 'flex', alignItems: 'center', gap: 16,
                }}>
                  <div style={{ textAlign: 'center', flexShrink: 0 }}>
                    <p style={{
                      fontSize: 28, fontWeight: 800, color: '#60a5fa',
                      lineHeight: 1, fontVariantNumeric: 'tabular-nums',
                    }}>
                      {Math.round(forecast.yhat)}
                    </p>
                    <p style={{ fontSize: 9, color: '#475569', marginTop: 3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      vehicles
                    </p>
                  </div>
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {[
                      { label: 'Low',  value: forecast.yhat_lower },
                      { label: 'High', value: forecast.yhat_upper },
                    ].map(({ label, value }) => (
                      <div key={label} style={{
                        display: 'flex', justifyContent: 'space-between',
                        fontSize: 11,
                      }}>
                        <span style={{ color: '#475569' }}>{label}</span>
                        <span style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                          {Math.round(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </Section>
            )}

            {/* REROUTED */}
            <Section label={`Rerouted junctions · ${reroutes.length}`}>
              {reroutes.length === 0 ? (
                <p style={{ fontSize: 12, color: '#1e3a5f' }}>None this cycle</p>
              ) : (
                <div style={{
                  maxHeight: 136, overflowY: 'auto',
                  display: 'flex', flexDirection: 'column', gap: 4,
                  scrollbarWidth: 'thin', scrollbarColor: '#1e293b transparent',
                }}>
                  {reroutes.map((r, i) => (
                    <div key={i} style={{
                      fontSize: 11, background: '#0a1525',
                      borderRadius: 5, padding: '5px 10px',
                      border: '1px solid #1a2535',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <span style={{ color: '#f87171', fontWeight: 600, fontFamily: 'monospace' }}>
                        {r.from_junction}
                      </span>
                      <span style={{ color: '#334155' }}>→</span>
                      <span style={{ color: '#4ade80', fontWeight: 600, fontFamily: 'monospace' }}>
                        {r.to_junction}
                      </span>
                      <span style={{
                        marginLeft: 'auto', fontSize: 10, fontWeight: 700,
                        color: '#f59e0b', fontVariantNumeric: 'tabular-nums',
                      }}>
                        {(r.congestion_score * 100).toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* MODEL STATUS */}
            {gcn && lstm && prophet && (
              <Section label="Model status">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <ModelStatusRow label="GCN"     active={gcn.used_real_model} />
                  <ModelStatusRow label="LSTM"    active={lstm.used_real_model} />
                  <ModelStatusRow label="Prophet" active={prophet.used_real_model} />
                </div>
              </Section>
            )}
          </>
        )}
      </div>

      {/* Keyframes injected once alongside the component */}
      <style>{`
        @keyframes aiPulse {
          0%   { box-shadow: 0 0 0 0   rgba(34, 197, 94, 0.75); }
          65%  { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0);    }
          100% { box-shadow: 0 0 0 0   rgba(34, 197, 94, 0);    }
        }
      `}</style>
    </div>
  )
}
