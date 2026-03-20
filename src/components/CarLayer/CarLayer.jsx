import { useEffect, useMemo, useRef, useState } from 'react'
import { IconLayer } from '@deck.gl/layers'
import { useSimulationStore } from '../../store/simulationStore'

// ── Constants ────────────────────────────────────────────────────────────────
const ALPHA    = 0.25   // lerp factor per rAF frame (position + rotation)
const SNAP_POS = 1e-9   // stop lerping position below this delta (degrees)
const SNAP_ROT = 0.05   // stop lerping rotation below this delta (degrees)

// ── Car SVG Icon Atlas ───────────────────────────────────────────────────────
// Realistic top-down car, 14×28 viewport, pointing NORTH (up = front of car).
// mask:true → pixel brightness becomes alpha; getColor is the solid tint.
//   white body     → fully opaque tint (speed colour)
//   #aaddff glass  → ~84% brightness → slightly lighter tinted area (windshield)
//   #ffffaa lights → ~93% brightness → bright highlight (headlights)
//   #ff4444 lights → ~53% brightness → darker tinted area (tail lights)
//   #222 wheels    → ~13% brightness → nearly transparent corner bumps
const CAR_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 28" width="14" height="28">',
  // Body
  '<rect x="1" y="3" width="12" height="22" rx="3" fill="white"/>',
  // Front windshield
  '<rect x="2.5" y="4" width="9" height="6" rx="1.5" fill="#aaddff" opacity="0.9"/>',
  // Rear windshield
  '<rect x="2.5" y="18" width="9" height="5" rx="1.5" fill="#aaddff" opacity="0.6"/>',
  // Front wheels
  '<rect x="0" y="5" width="2.5" height="4" rx="1" fill="#222"/>',
  '<rect x="11.5" y="5" width="2.5" height="4" rx="1" fill="#222"/>',
  // Back wheels
  '<rect x="0" y="19" width="2.5" height="4" rx="1" fill="#222"/>',
  '<rect x="11.5" y="19" width="2.5" height="4" rx="1" fill="#222"/>',
  // Front headlights
  '<rect x="2" y="3" width="3" height="1.5" rx="0.5" fill="#ffffaa"/>',
  '<rect x="9" y="3" width="3" height="1.5" rx="0.5" fill="#ffffaa"/>',
  // Back lights
  '<rect x="2" y="24" width="3" height="1.5" rx="0.5" fill="#ff4444"/>',
  '<rect x="9" y="24" width="3" height="1.5" rx="0.5" fill="#ff4444"/>',
  '</svg>',
].join('')

const CAR_ATLAS   = `data:image/svg+xml;base64,${btoa(CAR_SVG)}`
const CAR_MAPPING = {
  car: { x: 0, y: 0, width: 14, height: 28, mask: true },
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Speed (m/s) → RGBA tint colour.
 * > 10 m/s  → white  (moving fast, like SUMO default)
 * 3–10 m/s  → orange (slow traffic)
 * < 3 m/s   → red    (stopped / jammed)
 */
function speedToColor(speed) {
  if (speed > 10) return [255, 255, 255, 245]
  if (speed >= 3) return [255, 165, 0,   245]
  return                  [255, 60,  60,  245]
}

/**
 * Lerp between two angles (degrees) along the shortest arc.
 * Prevents the 359°→1° wrap from spinning the wrong way (358° rotation).
 */
function lerpAngle(a, b, t) {
  let diff = b - a
  while (diff >  180) diff -= 360
  while (diff < -180) diff += 360
  return a + diff * t
}

/**
 * Map deck.gl zoom level → icon pixel size.
 * Keeps cars readable at all zoom levels without overwhelming the map.
 */
function sizeForZoom(zoom) {
  if (zoom < 13)  return 8
  if (zoom <= 15) return 12
  return 16
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useCarLayer(zoom) – returns a Deck.gl IconLayer that renders every active
 * vehicle as a top-down car icon with:
 *   • Zoom-responsive size (8 / 12 / 16 px)
 *   • Smooth position + heading lerp at 0.25 per rAF frame
 *   • Heading derived from Math.atan2(dLng, dLat) → CW-from-north (Deck.gl convention)
 *   • Backend angle used as fallback when vehicle is stationary
 *   • Speed-based colour tint: white (fast) / orange (slow) / red (stopped)
 *
 * Internal ref shapes:
 *   displayMap  { id → { lng, lat, speed, angle } }  ← lerped, what gets drawn
 *   targetMap   { id → { lng, lat, speed, angle } }  ← latest store snapshot
 */
export default function useCarLayer(zoom = 15) {
  const vehicles = useSimulationStore((s) => s.vehicles)

  const displayMap = useRef({})
  const targetMap  = useRef({})

  const [tick, setTick] = useState(0)

  // ── Sync store → targetMap ──────────────────────────────────────────────
  useEffect(() => {
    const next = {}
    for (const v of vehicles) {
      if (v.lng == null || v.lat == null) continue
      next[v.id] = {
        lng:   v.lng,
        lat:   v.lat,
        speed: v.speed ?? 0,
        angle: v.angle ?? 0,   // traci.vehicle.getAngle – CW from north
      }
      if (!displayMap.current[v.id]) {
        displayMap.current[v.id] = { ...next[v.id] }
      }
    }
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
          // Heading: Math.atan2(dLng, dLat) gives CW-from-north degrees,
          // which is the same convention as Deck.gl's getAngle and SUMO's getAngle.
          //   dLng=0, dLat>0  → atan2(0, +) = 0°  (north) ✓
          //   dLng>0, dLat=0  → atan2(+, 0) = 90° (east)  ✓
          const heading = Math.atan2(dLng, dLat) * (180 / Math.PI)
          pos.angle = lerpAngle(pos.angle, heading, ALPHA)
          pos.lng   += dLng * ALPHA
          pos.lat   += dLat * ALPHA
          pos.speed  = tgt.speed
          moved = true
        } else {
          // Stationary – lerp angle toward backend value (lane changes, corrections)
          const normalised = ((tgt.angle - pos.angle + 180) % 360) - 180
          if (Math.abs(normalised) > SNAP_ROT) {
            pos.angle = lerpAngle(pos.angle, tgt.angle, ALPHA)
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

  // ── Build render data (recomputed only when rAF tick fires) ──────────────
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

  const iconSize = sizeForZoom(zoom)

  return new IconLayer({
    id: 'car-layer',
    data,
    iconAtlas:     CAR_ATLAS,
    iconMapping:   CAR_MAPPING,
    getIcon:       () => 'car',
    getPosition:   (d) => d.position,
    getAngle:      (d) => d.angle,
    getColor:      (d) => speedToColor(d.speed),
    // sizeMin/Max both set to iconSize → exact pixel size, no stretching
    getSize:       iconSize,
    sizeUnits:     'pixels',
    sizeMinPixels: iconSize,
    sizeMaxPixels: iconSize,
    pickable:      true,
    billboard:     false,   // flat on the map plane; rotates with vehicle heading
    updateTriggers: {
      getColor: tick,
      getAngle: tick,
      getSize:  zoom,
    },
  })
}
