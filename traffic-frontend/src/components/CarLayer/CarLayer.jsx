import { useEffect, useMemo, useRef, useState } from 'react'
import { PolygonLayer } from '@deck.gl/layers'
import { WebMercatorViewport } from '@deck.gl/core'
import { useSimulationStore } from '../../store/simulationStore'

// ── Constants ────────────────────────────────────────────────────────────────
const ALPHA        = 0.25   // lerp factor per rAF frame (position + rotation)
const SNAP_POS     = 1e-9   // stop lerping position below this delta (degrees)
const SNAP_ROT     = 0.05   // stop lerping rotation below this delta (degrees)
const MAX_VEHICLES = 500    // viewport cap – keeps GPU load bounded
const CAR_LENGTH_M = 6      // physical car length (metres)
const CAR_WIDTH_M  = 3      // physical car width  (metres)
const CAR_HEIGHT_M = 2      // extrusion height    (metres)
const LAT_M        = 111000 // metres per degree latitude (constant)

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Speed (m/s) → RGBA fill colour for the extruded box. */
function speedToColor(speed) {
  if (speed > 10) return [80,  220, 80,  240]   // green  – free flow
  if (speed >= 3) return [255, 165, 0,   240]   // orange – slow
  return                  [255, 60,  60,  240]   // red    – stopped / jammed
}

/**
 * Lerp between two angles (degrees) along the shortest arc.
 * Prevents the 359°→1° wrap from spinning the wrong way.
 */
function lerpAngle(a, b, t) {
  let diff = b - a
  while (diff >  180) diff -= 360
  while (diff < -180) diff += 360
  return a + diff * t
}

/**
 * Compute the 4 corners of a CAR_LENGTH×CAR_WIDTH rectangle in lon/lat space,
 * centred at (lng, lat) and rotated angleDeg degrees clockwise from north.
 *
 * Coordinate derivation:
 *   forward vector (CW from north):  [sin(a)/mPerLng, cos(a)/mPerLat]
 *   right    vector (90° CW):        [cos(a)/mPerLng, -sin(a)/mPerLat]
 *
 * Returns [[lng,lat], [lng,lat], [lng,lat], [lng,lat]] (ring, no closing point).
 */
function carPolygon(lng, lat, angleDeg) {
  const mPerLng = LAT_M * Math.cos(lat * Math.PI / 180)
  const mPerLat = LAT_M
  const rad  = angleDeg * Math.PI / 180
  const sinA = Math.sin(rad)
  const cosA = Math.cos(rad)

  const fLng =  sinA / mPerLng
  const fLat =  cosA / mPerLat
  const rLng =  cosA / mPerLng
  const rLat = -sinA / mPerLat

  const hl = CAR_LENGTH_M / 2
  const hw = CAR_WIDTH_M  / 2

  return [
    [lng + hl*fLng + hw*rLng, lat + hl*fLat + hw*rLat],  // front-right
    [lng + hl*fLng - hw*rLng, lat + hl*fLat - hw*rLat],  // front-left
    [lng - hl*fLng - hw*rLng, lat - hl*fLat - hw*rLat],  // back-left
    [lng - hl*fLng + hw*rLng, lat - hl*fLat + hw*rLat],  // back-right
  ]
}

/**
 * Filter the displayMap to only vehicles inside the current viewport,
 * then cap at MAX_VEHICLES keeping the ones closest to the viewport centre.
 */
function filterToViewport(displayMap, viewState) {
  const vp = new WebMercatorViewport({
    ...viewState,
    width:  typeof window !== 'undefined' ? window.innerWidth  : 1920,
    height: typeof window !== 'undefined' ? window.innerHeight : 1080,
  })
  const [west, south, east, north] = vp.getBounds()
  const { longitude: cx, latitude: cy } = viewState

  const inView = []
  for (const d of Object.values(displayMap)) {
    if (d.lng >= west && d.lng <= east && d.lat >= south && d.lat <= north) {
      inView.push(d)
    }
  }

  if (inView.length <= MAX_VEHICLES) return inView

  // Too many → keep the MAX_VEHICLES closest to the viewport centre
  inView.sort((a, b) =>
    ((a.lng - cx) ** 2 + (a.lat - cy) ** 2) -
    ((b.lng - cx) ** 2 + (b.lat - cy) ** 2),
  )
  return inView.slice(0, MAX_VEHICLES)
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useCarLayer(viewState) – returns a Deck.gl PolygonLayer that renders every
 * visible vehicle as a 3-D extruded box (6 m × 3 m × 2 m) with:
 *   • Smooth position + heading lerp at 0.25 per rAF frame
 *   • Heading derived from Math.atan2(dLng, dLat) → CW-from-north
 *   • Backend angle used as fallback when stationary
 *   • Speed-based fill colour: green (fast) / orange (slow) / red (stopped)
 *   • Viewport culling: only vehicles inside the current map view, max 500
 *
 * Internal ref shapes:
 *   displayMap  { id → { lng, lat, speed, angle } }  ← lerped, drawn each frame
 *   targetMap   { id → { lng, lat, speed, angle } }  ← latest WebSocket snapshot
 */
export default function useCarLayer(viewState) {
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
          // atan2(dLng, dLat) = CW-from-north heading (matches SUMO + Deck.gl convention)
          const heading = Math.atan2(dLng, dLat) * (180 / Math.PI)
          pos.angle = lerpAngle(pos.angle, heading, ALPHA)
          pos.lng   += dLng * ALPHA
          pos.lat   += dLat * ALPHA
          pos.speed  = tgt.speed
          moved = true
        } else {
          // Stationary – lerp angle toward backend (lane changes, corrections)
          const norm = ((tgt.angle - pos.angle + 180) % 360) - 180
          if (Math.abs(norm) > SNAP_ROT) {
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

  // ── Build PolygonLayer data (viewport-filtered, capped at 500) ──────────
  const data = useMemo(() => {
    const visible = filterToViewport(displayMap.current, viewState)
    return visible.map((d) => ({
      polygon: carPolygon(d.lng, d.lat, d.angle),
      speed:   d.speed,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, viewState])

  return new PolygonLayer({
    id:           'car-layer',
    data,
    getPolygon:   (d) => d.polygon,
    getFillColor: (d) => speedToColor(d.speed),
    getLineColor: [0, 0, 0, 0],   // no outline — clean solid box
    getElevation: CAR_HEIGHT_M,
    extruded:     true,
    wireframe:    false,
    pickable:     true,
    material: {
      ambient:  0.6,
      diffuse:  0.8,
      shininess: 32,
    },
    updateTriggers: {
      getFillColor: tick,
      getPolygon:   tick,
    },
  })
}
