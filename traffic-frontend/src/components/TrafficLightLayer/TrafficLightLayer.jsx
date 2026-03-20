import { useMemo } from 'react'
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { useSimulationStore } from '../../store/simulationStore'

// ---------------------------------------------------------------------------
// State string → [r, g, b] (no alpha — each layer supplies its own)
// SUMO state strings: 'r'=red, 'y'=yellow, 'g'/'G'=green
// We pick the dominant character across the whole phase string.
// ---------------------------------------------------------------------------
function stateToRGB(state = '') {
  const s = state.toLowerCase()
  const counts = { r: 0, y: 0, g: 0 }
  for (const ch of s) {
    if      (ch === 'r') counts.r++
    else if (ch === 'y') counts.y++
    else if (ch === 'g') counts.g++
  }
  const dominant = Object.keys(counts).reduce((a, b) => counts[a] >= counts[b] ? a : b)
  if (dominant === 'g') return [0,   220, 70 ]   // green
  if (dominant === 'y') return [255, 165, 0  ]   // yellow
  return                       [255, 60,  60 ]   // red (default)
}

/**
 * useTrafficLightLayer – returns [outerGlow, midGlow, innerDot, text].
 *
 * Three concentric ScatterplotLayer circles per junction create a glow effect:
 *   outer  – 16 m radius, 20% opacity  (wide ambient glow)
 *   middle – 12 m radius, 50% opacity  (stronger halo)
 *   inner  – 8 m radius,  solid        (the actual signal lamp)
 *
 * All radii are in metres so they scale correctly with zoom level.
 * Positions come from traci.junction.getPosition() added in the backend.
 */
export default function useTrafficLightLayer() {
  const trafficLights = useSimulationStore((s) => s.trafficLights)

  const data = useMemo(
    () =>
      trafficLights
        .filter((tl) => tl.lng != null && tl.lat != null)
        .map((tl) => ({
          position:  [tl.lng, tl.lat],
          id:        tl.id,
          state:     tl.state ?? '',
          remaining: Math.round(tl.phase_duration_remaining ?? 0),
          rgb:       stateToRGB(tl.state ?? ''),
        })),
    [trafficLights],
  )

  // Outer glow — 16 m, 20% opacity
  const outerLayer = new ScatterplotLayer({
    id:             'tl-outer',
    data,
    getPosition:    (d) => d.position,
    getRadius:      16,
    radiusUnits:    'meters',
    getFillColor:   (d) => [...d.rgb, 50],
    stroked:        false,
    updateTriggers: { getFillColor: trafficLights },
  })

  // Middle glow — 12 m, 50% opacity
  const midLayer = new ScatterplotLayer({
    id:             'tl-middle',
    data,
    getPosition:    (d) => d.position,
    getRadius:      12,
    radiusUnits:    'meters',
    getFillColor:   (d) => [...d.rgb, 127],
    stroked:        false,
    updateTriggers: { getFillColor: trafficLights },
  })

  // Inner solid circle — 8 m, white outline
  const innerLayer = new ScatterplotLayer({
    id:              'tl-inner',
    data,
    getPosition:     (d) => d.position,
    getRadius:       8,
    radiusUnits:     'meters',
    getFillColor:    (d) => [...d.rgb, 240],
    stroked:         true,
    getLineColor:    [255, 255, 255, 200],
    getLineWidth:    1,
    lineWidthUnits:  'pixels',
    pickable:        true,
    updateTriggers:  { getFillColor: trafficLights },
  })

  // Countdown text floating above the inner circle
  const textLayer = new TextLayer({
    id:                   'tl-text',
    data,
    getPosition:          (d) => d.position,
    getText:              (d) => String(d.remaining),
    getSize:              13,
    sizeUnits:            'pixels',
    getColor:             [255, 255, 255, 255],
    getTextAnchor:        'middle',
    getAlignmentBaseline: 'center',
    fontFamily:           '"Inter", "Helvetica Neue", sans-serif',
    fontWeight:           700,
    pixelOffset:          [0, -26],
    billboard:            true,
    updateTriggers:       { getText: trafficLights },
  })

  return [outerLayer, midLayer, innerLayer, textLayer]
}
