import { useMemo } from 'react'
import { IconLayer, TextLayer } from '@deck.gl/layers'
import { useSimulationStore } from '../../store/simulationStore'

// ---------------------------------------------------------------------------
// SVG circle icon atlas (single white circle, 64×64 px, encoded as base64)
// The IconLayer tints it at render time via getColor, so one atlas covers all
// signal states without needing separate image assets.
// ---------------------------------------------------------------------------
const ICON_SIZE = 64
// Two icons in one atlas:
//   "dot"  — filled circle (the coloured signal lamp)
//   "ring" — outlined ring (white glow halo rendered behind dot)
const SVG_ATLAS = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE * 2}" height="${ICON_SIZE}">`,
  // dot — slot 0..63
  `<circle cx="32" cy="32" r="28" fill="white"/>`,
  // ring — slot 64..127 (stroke only, transparent fill)
  `<circle cx="${ICON_SIZE + 32}" cy="32" r="26" fill="none" stroke="white" stroke-width="5"/>`,
  `</svg>`,
].join('')

const ICON_ATLAS   = `data:image/svg+xml;base64,${btoa(SVG_ATLAS)}`
const ICON_MAPPING = {
  dot:  { x: 0,           y: 0, width: ICON_SIZE, height: ICON_SIZE, mask: true },
  ring: { x: ICON_SIZE,   y: 0, width: ICON_SIZE, height: ICON_SIZE, mask: true },
}

// ---------------------------------------------------------------------------
// State string → RGBA colour
// SUMO state strings contain per-signal chars: 'r'=red, 'y'=yellow, 'g'/'G'=green
// We inspect the dominant character across the whole state string.
// ---------------------------------------------------------------------------
function stateToColor(state = '') {
  const s = state.toLowerCase()
  const counts = { r: 0, y: 0, g: 0 }
  for (const ch of s) {
    if (ch === 'r') counts.r++
    else if (ch === 'y') counts.y++
    else if (ch === 'g') counts.g++
  }
  const dominant = Object.keys(counts).reduce((a, b) => counts[a] >= counts[b] ? a : b)
  if (dominant === 'g') return [0,   204, 68,  240]  // #00CC44
  if (dominant === 'y') return [255, 165, 0,   240]  // #FFA500
  return                       [255, 0,   0,   240]  // #FF0000 (red / default)
}

/**
 * useTrafficLightLayer – custom hook returning [IconLayer, TextLayer].
 *
 * IconLayer  : SVG circle tinted by dominant signal state colour (r/y/g).
 * TextLayer  : floating countdown in seconds above each icon.
 *
 * Both layers render empty data until the backend adds lat/lng to TL objects.
 * Enable by adding traci.junction.getPosition(tl_id) + convertGeo() inside
 * SUMORunner._collect_traffic_lights().
 */
export default function useTrafficLightLayer() {
  const trafficLights = useSimulationStore((state) => state.trafficLights)

  const data = useMemo(
    () =>
      trafficLights
        .filter((tl) => tl.lng != null && tl.lat != null)
        .map((tl) => ({
          position:      [tl.lng, tl.lat],
          textPosition:  [tl.lng, tl.lat],  // same coord; TextLayer offset via pixelOffset
          id:            tl.id,
          state:         tl.state ?? '',
          remaining:     Math.round(tl.phase_duration_remaining ?? 0),
        })),
    [trafficLights],
  )

  // Halo ring layer — rendered first (below) so the coloured dot sits on top
  const ringLayer = new IconLayer({
    id: 'tl-ring-layer',
    data,
    iconAtlas:   ICON_ATLAS,
    iconMapping: ICON_MAPPING,
    getIcon:     () => 'ring',
    getPosition: (d) => d.position,
    getSize:     28,
    sizeUnits:   'pixels',
    getColor:    (d) => { const c = stateToColor(d.state); return [c[0], c[1], c[2], 100] },
    billboard:   true,
    updateTriggers: { getColor: trafficLights },
  })

  const iconLayer = new IconLayer({
    id: 'tl-icon-layer',
    data,
    iconAtlas:   ICON_ATLAS,
    iconMapping: ICON_MAPPING,
    getIcon:     () => 'dot',
    getPosition: (d) => d.position,
    getSize:     20,
    sizeUnits:   'pixels',
    getColor:    (d) => stateToColor(d.state),
    billboard:   true,
    pickable:    true,
    updateTriggers: { getColor: trafficLights },
  })

  const textLayer = new TextLayer({
    id: 'tl-text-layer',
    data,
    getPosition:          (d) => d.position,
    getText:              (d) => String(d.remaining),
    getSize:              12,
    sizeUnits:            'pixels',
    getColor:             [255, 255, 255, 255],
    getTextAnchor:        'middle',
    getAlignmentBaseline: 'center',
    fontFamily:           '"Inter", "Helvetica Neue", sans-serif',
    fontWeight:           700,
    pixelOffset:          [0, -22],   // float above the icon
    billboard:            true,
    updateTriggers: { getText: trafficLights },
  })

  return [ringLayer, iconLayer, textLayer]
}
