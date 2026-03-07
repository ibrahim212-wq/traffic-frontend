import { useEffect, useMemo, useRef, useState } from 'react'
import { IconLayer } from '@deck.gl/layers'
import { useSimulationStore } from '../../store/simulationStore'

// ── Constants ────────────────────────────────────────────────────────────────
const ALPHA       = 0.15   // position lerp factor per rAF frame (~60fps → smooth over 100ms tick)
const ALPHA_ROT   = 0.20   // rotation lerp factor (slightly faster than position)
const SNAP_POS    = 1e-9   // stop lerping position below this delta (degrees)
const SNAP_ROT    = 0.05   // stop lerping rotation below this delta (degrees)
const MIN_MOVE_FOR_ANGLE = 1e-7  // minimum movement before we recalculate heading

// ── Car SVG Icon Atlas ───────────────────────────────────────────────────────
// Top-down car, 20×36 viewBox, pointing NORTH (up) by default.
// NOTE: "currentColor" does NOT work in a data-URI SVG (no CSS context),
// so the body is explicitly "white". With mask:true, Deck.gl uses pixel
// brightness as opacity and applies getColor as the tint:
//   white body   → fully opaque, speed colour (green / orange / red)
//   #222 glass   → ~13% brightness → nearly transparent (dark shadow)
//   #555 wheels  → 33% brightness  → subtle grey corners
//   #87CEEB windshield → ~72% brightness → lighter tinted glass
const CAR_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 36" width="20" height="36">',
  // Body — white so mask:true tints it with getColor
  '<rect x="2" y="4" width="16" height="28" rx="4" fill="white"/>',
  // Rear glass
  '<rect x="4" y="2" width="12" height="8" rx="2" fill="#222" opacity="0.8"/>',
  // Front glass
  '<rect x="4" y="24" width="12" height="8" rx="2" fill="#222" opacity="0.8"/>',
  // Wheels — four corners
  '<rect x="1" y="6" width="3" height="5" rx="1" fill="#555"/>',
  '<rect x="16" y="6" width="3" height="5" rx="1" fill="#555"/>',
  '<rect x="1" y="24" width="3" height="5" rx="1" fill="#555"/>',
  '<rect x="16" y="24" width="3" height="5" rx="1" fill="#555"/>',
  // Windshield (front) — light blue tint
  '<rect x="5" y="6" width="10" height="6" rx="1" fill="#87CEEB" opacity="0.9"/>',
  '</svg>',
].join('')

const CAR_ATLAS   = `data:image/svg+xml;base64,${btoa(CAR_SVG)}`
const CAR_MAPPING = {
  // width/height must match the SVG pixel dimensions declared above
  car: { x: 0, y: 0, width: 20, height: 36, mask: true },
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Speed (m/s) → RGBA tint colour (applied via mask). */
function speedToColor(speed) {
  if (speed > 10) return [0,   204, 68,  245]   // #00CC44 – free flow
  if (speed >= 3) return [255, 149, 0,   245]   // #FF9500 – slow
  return                  [255, 59,  48,  245]   // #FF3B30 – congested
}

/**
 * Lerp between two angles (degrees) along the shortest arc.
 * Prevents the 359° → 1° jump from spinning 358° the wrong way.
 */
function lerpAngle(a, b, t) {
  let diff = b - a
  while (diff >  180) diff -= 360
  while (diff < -180) diff += 360
  return a + diff * t
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useCarLayer – returns a Deck.gl IconLayer that renders each vehicle as a
 * top-down car icon with:
 *   • Smooth position interpolation via requestAnimationFrame lerp
 *   • Heading/rotation that tracks actual movement direction
 *   • Speed-based colour tinting (green / orange / red)
 *
 * displayMap shape per entry:
 *   { lng, lat, speed, angle }   ← lerped values actually drawn
 * targetMap shape per entry:
 *   { lng, lat, speed, angle }   ← latest values from the Zustand store
 */
export default function useCarLayer() {
  const vehicles = useSimulationStore((state) => state.vehicles)

  const displayMap = useRef({})   // currently drawn state (mutated in rAF)
  const targetMap  = useRef({})   // latest store state (set in useEffect)

  const [tick, setTick] = useState(0)

  // ── Sync store → targetMap ──────────────────────────────────────────────
  useEffect(() => {
    const next = {}
    for (const v of vehicles) {
      if (v.lng == null || v.lat == null) continue
      // Backend provides `angle` (traci.vehicle.getAngle) – degrees CW from north
      const backendAngle = v.angle ?? 0
      next[v.id] = { lng: v.lng, lat: v.lat, speed: v.speed ?? 0, angle: backendAngle }

      if (!displayMap.current[v.id]) {
        // First appearance: teleport to exact target position + heading
        displayMap.current[v.id] = { ...next[v.id] }
      } else {
        // Update target angle from backend (authoritative source)
        displayMap.current[v.id]  // keep existing lerped pos; targetMap drives lerp
      }
    }
    // Prune departed vehicles
    for (const id of Object.keys(displayMap.current)) {
      if (!next[id]) delete displayMap.current[id]
    }
    targetMap.current = next
  }, [vehicles])

  // ── rAF lerp loop ───────────────────────────────────────────────────────
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

        if (Math.abs(dLng) > SNAP_POS || Math.abs(dLat) > SNAP_POS) {
          // ── Compute heading from movement direction ──────────────────
          // Math.atan2(dLng, dLat): angle CW from north (0=N, 90=E, 180=S, 270=W)
          // This matches both SUMO's getAngle convention and Deck.gl's getAngle.
          if (Math.abs(dLng) > MIN_MOVE_FOR_ANGLE || Math.abs(dLat) > MIN_MOVE_FOR_ANGLE) {
            const movementAngle = Math.atan2(dLng, dLat) * 180 / Math.PI
            // Lerp toward movement angle; backend angle is fallback when stopped
            pos.angle = lerpAngle(pos.angle, movementAngle, ALPHA_ROT)
          }

          pos.lng   += dLng * ALPHA
          pos.lat   += dLat * ALPHA
          pos.speed  = tgt.speed
          moved = true
        } else {
          // Stationary — still lerp angle toward backend value (e.g. lane changes)
          const dAngle = tgt.angle - pos.angle
          if (Math.abs(((dAngle + 180) % 360) - 180) > SNAP_ROT) {
            pos.angle = lerpAngle(pos.angle, tgt.angle, ALPHA_ROT)
            moved = true
          }
        }
      }
      if (moved) setTick((t) => t + 1)
      rafId = requestAnimationFrame(frame)
    }

    rafId = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(rafId)
  }, [])

  // ── Build data array (only when tick changes) ────────────────────────────
  const data = useMemo(
    () =>
      Object.values(displayMap.current).map((d) => ({
        position: [d.lng, d.lat],
        speed:    d.speed,
        angle:    d.angle,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick],
  )

  return new IconLayer({
    id: 'car-layer',
    data,
    iconAtlas:   CAR_ATLAS,
    iconMapping: CAR_MAPPING,
    getIcon:     () => 'car',
    getPosition: (d) => d.position,
    getAngle:    (d) => d.angle,
    getColor:    (d) => speedToColor(d.speed),
    // getSize applies to the HEIGHT of the icon (36px natural height).
    // At getSize:28 the car is 28px tall × (20/36) ≈ 15.6px wide — matches spec.
    getSize:       28,
    sizeUnits:     'pixels',
    sizeMinPixels: 12,
    sizeMaxPixels: 28,
    pickable:      true,
    billboard:     false,   // flat on map plane, rotates with heading
    updateTriggers: {
      getColor: tick,
      getAngle: tick,
    },
  })
}
