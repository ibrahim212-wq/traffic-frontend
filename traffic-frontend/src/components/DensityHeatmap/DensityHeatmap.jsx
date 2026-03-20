import { useEffect, useMemo, useState } from 'react'
import { PathLayer } from '@deck.gl/layers'
import { HeatmapLayer } from '@deck.gl/aggregation-layers'
import { useSimulationStore } from '../../store/simulationStore'

// ── Constants ────────────────────────────────────────────────────────────────

// Road width per congestion level (metres)
const LEVEL_WIDTH = { heavy: 8, medium: 6 }

// Base RGB per congestion level
const LEVEL_RGB = {
  heavy:  [255, 59,  48 ],   // #FF3B30
  medium: [255, 149, 0  ],   // #FF9500
}

// Ambient heatmap colour ramp — very low-opacity density glow
const AMBIENT_COLOR_RANGE = [
  [0,   0,   0,   0  ],
  [180, 0,   0,   20 ],
  [200, 60,  0,   40 ],
  [220, 80,  0,   55 ],
  [240, 100, 0,   65 ],
]

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * useDensityHeatmap – returns [ambientHeatmapLayer, roadCongestionLayer].
 *
 * Layer 1 (HeatmapLayer): subtle ambient density glow from vehicle positions.
 *
 * Layer 2 (PathLayer): Google Maps-style road congestion overlay using the
 *   actual edge geometry sent by the backend (traci.edge.getShape).
 *   Heavy  → red  (#FF3B30), 8 m wide, pulsing opacity via sin(Date.now()/500)
 *   Medium → orange (#FF9500), 6 m wide, static opacity
 *   Free-flow edges are excluded — base map tiles show through.
 *
 * Pulse animation: a setInterval at 50 ms fires a state update; the
 *   PathLayer's getColor accessor reads Date.now() inline so every render
 *   cycle computes the current opacity without stale closure issues.
 */
export default function useDensityHeatmap() {
  const vehicles      = useSimulationStore((s) => s.vehicles)
  const roadCongestion = useSimulationStore((s) => s.roadCongestion)

  // ── Pulse tick – drives opacity animation on heavy-congestion roads ──────
  const [pulseTick, setPulseTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setPulseTick(Date.now()), 50)
    return () => clearInterval(id)
  }, [])

  // ── Ambient heatmap: vehicle density glow ────────────────────────────────
  const heatPoints = useMemo(
    () =>
      vehicles
        .filter((v) => v.lng != null && v.lat != null)
        .map((v) => ({
          position: [v.lng, v.lat],
          weight:   Math.max(0.05, 1 / (1 + (v.speed ?? 0) * 0.15)),
        })),
    [vehicles],
  )

  // ── PathLayer data: only edges that have real shape geometry ─────────────
  const congestionData = useMemo(
    () => roadCongestion.filter((e) => Array.isArray(e.shape) && e.shape.length >= 2),
    [roadCongestion],
  )

  // ── Layer instances ──────────────────────────────────────────────────────
  const ambientHeatmap = new HeatmapLayer({
    id:           'density-heatmap-ambient',
    data:         heatPoints,
    getPosition:  (d) => d.position,
    getWeight:    (d) => d.weight,
    radiusPixels: 50,
    intensity:    0.5,
    threshold:    0.05,
    colorRange:   AMBIENT_COLOR_RANGE,
  })

  // Compute current pulse opacity (range 204–255 → 80%–100% opaque)
  const sinVal      = Math.sin(pulseTick / 500)          // –1 to +1
  const heavyAlpha  = Math.round((0.9 + 0.1 * sinVal) * 255)   // 230–255

  const roadLayer = new PathLayer({
    id:              'road-congestion-path',
    data:            congestionData,
    getPath:         (d) => d.shape,
    getWidth:        (d) => LEVEL_WIDTH[d.level] ?? 6,
    widthUnits:      'meters',
    widthMinPixels:  2,
    widthMaxPixels:  20,
    getColor:        (d) => {
      const [r, g, b] = LEVEL_RGB[d.level] ?? [255, 149, 0]
      return [r, g, b, d.level === 'heavy' ? heavyAlpha : 210]
    },
    capRounded:      true,
    jointRounded:    true,
    updateTriggers: {
      getColor: pulseTick,
    },
  })

  return [ambientHeatmap, roadLayer]
}
