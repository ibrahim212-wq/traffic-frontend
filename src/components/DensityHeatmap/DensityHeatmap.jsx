import { useMemo } from 'react'
import { LineLayer } from '@deck.gl/layers'
import { HeatmapLayer } from '@deck.gl/aggregation-layers'
import { useSimulationStore } from '../../store/simulationStore'

// ── Constants ────────────────────────────────────────────────────────────────

// Grid cell size in degrees (~100 m at Riyadh lat 24.7°)
const CELL_DEG = 0.001

// Half-length of each drawn road segment in degrees (~110 m total at equator).
// Slightly longer than CELL_DEG so adjacent cells overlap and produce a
// continuous colored stripe rather than gapped dashes.
const HALF_LEN = 0.0007

// Only draw congestion segments when average speed is below this threshold.
// Above it, roads are free-flow and we leave the map base-tile uncoloured.
const FREE_FLOW_MS = 4.17  // 15 km/h in m/s

// ── Colour helpers ────────────────────────────────────────────────────────────

/**
 * avgSpeed (m/s) → RGBA for the road stripe.
 * Mirrors Google Maps traffic colours:
 *   Heavy   < 5 km/h  → #FF3B30  (iOS red)
 *   Medium  5–15 km/h → #FF9500  (iOS orange)
 *   Free    > 15 km/h → null (skip — don't draw)
 */
function congestionColor(avgSpeedMs) {
  const kmh = avgSpeedMs * 3.6
  if (kmh < 5)  return [255, 59,  48,  230]   // #FF3B30 – heavy jam
  if (kmh < 15) return [255, 149, 0,   210]   // #FF9500 – moderate
  return null
}

// Subtle ambient heatmap colour ramp — kept very low-opacity so it acts
// as a background density glow without competing with the LineLayer.
const AMBIENT_COLOR_RANGE = [
  [0,   0,   0,   0  ],
  [180, 0,   0,   20 ],
  [200, 60,  0,   40 ],
  [220, 80,  0,   55 ],
  [240, 100, 0,   65 ],
]

// ── Grid aggregation ──────────────────────────────────────────────────────────

/**
 * Circular mean of an array of angles in degrees.
 * Correctly handles the 359°/1° wrap-around.
 */
function circularMean(angles) {
  let s = 0, c = 0
  for (const a of angles) {
    const r = a * Math.PI / 180
    s += Math.sin(r)
    c += Math.cos(r)
  }
  return Math.atan2(s, c) * 180 / Math.PI
}

/**
 * buildRoadSegments – aggregates vehicle positions into a ~100 m grid,
 * then emits one LineLayer data entry per congested cell.
 *
 * For each occupied cell:
 *   1. Compute average speed → skip if free-flow
 *   2. Compute circular-mean heading from vehicle angles
 *   3. Project a HALF_LEN segment in that direction, centred on the cell
 *
 * Because vehicles drive ON roads, their positions naturally cluster along
 * road geometry — the resulting segments visually follow actual road paths.
 */
function buildRoadSegments(vehicles) {
  if (!vehicles.length) return []

  // ── Build grid ────────────────────────────────────────────────────────
  const grid = new Map()
  for (const v of vehicles) {
    if (v.lng == null || v.lat == null) continue
    const cx = Math.floor(v.lng / CELL_DEG)
    const cy = Math.floor(v.lat / CELL_DEG)
    const key = `${cx},${cy}`
    if (!grid.has(key)) grid.set(key, { cx, cy, speeds: [], angles: [] })
    const cell = grid.get(key)
    cell.speeds.push(v.speed ?? 0)
    // Use backend angle when available; fall back to 0 (handled gracefully)
    cell.angles.push(v.angle ?? 0)
  }

  // ── Emit segments ─────────────────────────────────────────────────────
  const segments = []
  for (const { cx, cy, speeds, angles } of grid.values()) {
    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length
    if (avgSpeed >= FREE_FLOW_MS) continue           // free-flow → skip

    const color = congestionColor(avgSpeed)
    if (!color) continue

    // Centre of this cell
    const centerLng = (cx + 0.5) * CELL_DEG
    const centerLat = (cy + 0.5) * CELL_DEG

    // Mean heading → unit vector along road
    const avgAngle = circularMean(angles)
    const rad  = avgAngle * Math.PI / 180
    const dLng = Math.sin(rad) * HALF_LEN
    const dLat = Math.cos(rad) * HALF_LEN

    segments.push({
      sourcePosition: [centerLng - dLng, centerLat - dLat],
      targetPosition: [centerLng + dLng, centerLat + dLat],
      color,
    })
  }

  return segments
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * useDensityHeatmap – returns [ambientHeatmapLayer, roadCongestionLayer].
 *
 * Layer 1 (HeatmapLayer): very subtle ambient density glow — shows broad
 *   traffic density without competing with road-coloured lines.
 *
 * Layer 2 (LineLayer): Google Maps-style road congestion overlay.
 *   Heavy congestion → red (#FF3B30), medium → orange (#FF9500).
 *   Free-flow roads are not coloured (base map tiles show through).
 *   12 px wide so segments visually cover a road lane at zoom 14.
 *
 * Both layers update with every WebSocket packet (vehicles change triggers
 * useMemo recomputation). The road layer recolours smoothly because React
 * reconciles the LineLayer data diff on each render.
 */
export default function useDensityHeatmap() {
  const vehicles = useSimulationStore((s) => s.vehicles)

  // ── Ambient heatmap data ─────────────────────────────────────────────
  const heatPoints = useMemo(
    () =>
      vehicles
        .filter((v) => v.lng != null && v.lat != null)
        .map((v) => ({
          position: [v.lng, v.lat],
          weight: Math.max(0.05, 1 / (1 + (v.speed ?? 0) * 0.15)),
        })),
    [vehicles],
  )

  // ── Road congestion segments ─────────────────────────────────────────
  const segments = useMemo(() => buildRoadSegments(vehicles), [vehicles])

  // ── Layer instances ──────────────────────────────────────────────────
  const ambientHeatmap = new HeatmapLayer({
    id: 'density-heatmap-ambient',
    data: heatPoints,
    getPosition: (d) => d.position,
    getWeight:   (d) => d.weight,
    radiusPixels: 50,
    intensity:    0.5,    // low — ambient glow only
    threshold:    0.05,
    colorRange:   AMBIENT_COLOR_RANGE,
  })

  const roadCongestion = new LineLayer({
    id: 'road-congestion-layer',
    data: segments,
    getSourcePosition: (d) => d.sourcePosition,
    getTargetPosition: (d) => d.targetPosition,
    getColor:          (d) => d.color,
    getWidth:          12,
    widthUnits:        'pixels',
    widthMinPixels:    4,
    widthMaxPixels:    18,
    capRounded:        true,
    updateTriggers: {
      getColor: segments,
    },
  })

  return [ambientHeatmap, roadCongestion]
}
