import { useMemo } from 'react'
import { HeatmapLayer } from '@deck.gl/aggregation-layers'
import { useSimulationStore } from '../../store/simulationStore'

/**
 * Colour ramp: transparent → orange → red
 * Matches Google Maps traffic density style:
 *   index 0 = lowest density  → fully transparent (no clutter on empty roads)
 *   index 2 = medium density  → orange
 *   index 4 = highest density → red
 */
const COLOR_RANGE = [
  [0,   0,   0,   0],    // transparent  (no vehicles)
  [255, 200, 50,  60],   // yellow-ish   (sparse)
  [255, 140, 0,   140],  // orange       (moderate)
  [220, 50,  0,   190],  // orange-red   (heavy)
  [180, 0,   0,   230],  // red          (congested)
]

/**
 * useDensityHeatmap – custom hook that returns a Deck.gl HeatmapLayer.
 *
 * Reads vehicle positions from the Zustand store and weights each vehicle
 * by the inverse of its speed (slower = more "hot"), so congested areas
 * glow red while free-flow traffic leaves only a faint orange trace.
 */
export default function useDensityHeatmap() {
  const vehicles = useSimulationStore((state) => state.vehicles)

  const points = useMemo(
    () =>
      vehicles
        .filter((v) => v.lng != null && v.lat != null)
        .map((v) => ({
          position: [v.lng, v.lat],
          // Weight inversely proportional to speed — stopped vehicles are hottest
          weight: Math.max(0.1, 1 / (1 + (v.speed ?? 0) * 0.1)),
        })),
    [vehicles],
  )

  return new HeatmapLayer({
    id: 'density-heatmap',
    data: points,
    getPosition: (d) => d.position,
    getWeight: (d) => d.weight,
    radiusPixels: 60,
    intensity: 1.2,
    threshold: 0.03,   // hide very low-density pixels (keeps map clean)
    colorRange: COLOR_RANGE,
  })
}
