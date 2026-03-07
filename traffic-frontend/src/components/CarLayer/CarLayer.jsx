import { useEffect, useMemo, useRef, useState } from 'react'
import { ScatterplotLayer } from '@deck.gl/layers'
import { useSimulationStore } from '../../store/simulationStore'

const ALPHA = 0.12          // lerp smoothing per rAF frame (~60fps → ~7 frames per 100ms update)
const SNAP_THRESHOLD = 1e-9 // stop lerping below this delta (degrees)

/**
 * speedToColor – maps m/s speed to an RGB colour.
 * green  > 10 m/s  (~36 km/h) – free flow
 * orange 3–10 m/s  (~11–36 km/h) – slow
 * red    < 3  m/s  (~11 km/h) – congested / stopped
 */
function speedToColor(speed) {
  if (speed > 10) return [34, 197, 94, 220]    // green-400
  if (speed >= 3) return [251, 146, 60, 220]   // orange-400
  return [239, 68, 68, 220]                     // red-500
}

/**
 * useCarLayer – custom hook that returns a Deck.gl ScatterplotLayer.
 *
 * Animation strategy:
 *   SUMO pushes new vehicle positions every 100 ms.
 *   We store those as "targets" and run a requestAnimationFrame loop (~60 fps)
 *   that lerps each vehicle's displayed position toward its target by ALPHA
 *   each frame, producing smooth movement between discrete updates.
 */
export default function useCarLayer() {
  const vehicles = useSimulationStore((state) => state.vehicles)

  // Mutable maps – mutated in rAF without triggering React renders
  const displayMap = useRef({})  // { id → { lng, lat, speed } } — what's currently shown
  const targetMap  = useRef({})  // { id → { lng, lat, speed } } — latest from store

  // Incremented each rAF frame when any vehicle moved — drives useMemo below
  const [tick, setTick] = useState(0)

  // ── Sync store → targetMap on every vehicles update ─────────────────────
  useEffect(() => {
    const next = {}
    for (const v of vehicles) {
      if (v.lng == null || v.lat == null) continue
      next[v.id] = { lng: v.lng, lat: v.lat, speed: v.speed ?? 0 }
      // First appearance: teleport display position to target immediately
      if (!displayMap.current[v.id]) {
        displayMap.current[v.id] = { ...next[v.id] }
      }
    }
    // Prune vehicles that have left the simulation
    for (const id of Object.keys(displayMap.current)) {
      if (!next[id]) delete displayMap.current[id]
    }
    targetMap.current = next
  }, [vehicles])

  // ── rAF lerp loop ────────────────────────────────────────────────────────
  useEffect(() => {
    let rafId

    const frame = () => {
      let moved = false
      for (const id of Object.keys(displayMap.current)) {
        const tgt = targetMap.current[id]
        if (!tgt) continue
        const pos = displayMap.current[id]
        const dLng = tgt.lng - pos.lng
        const dLat = tgt.lat - pos.lat
        if (Math.abs(dLng) > SNAP_THRESHOLD || Math.abs(dLat) > SNAP_THRESHOLD) {
          pos.lng   += dLng * ALPHA
          pos.lat   += dLat * ALPHA
          pos.speed  = tgt.speed
          moved = true
        }
      }
      if (moved) setTick((t) => t + 1)
      rafId = requestAnimationFrame(frame)
    }

    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
  }, [])

  // ── Build flat array for ScatterplotLayer (recomputed only when tick changes) ──
  const data = useMemo(
    () =>
      Object.values(displayMap.current).map((d) => ({
        position: [d.lng, d.lat],
        speed: d.speed,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick],
  )

  return new ScatterplotLayer({
    id: 'car-layer',
    data,
    getPosition: (d) => d.position,
    getFillColor: (d) => speedToColor(d.speed),
    getRadius: 6,
    radiusUnits: 'pixels',
    pickable: true,
    stroked: false,
    updateTriggers: {
      getFillColor: tick,
    },
  })
}
