import { useEffect, useRef, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import DeckGL from '@deck.gl/react'
import useCarLayer from '../CarLayer/CarLayer'
import useTrafficLightLayer from '../TrafficLightLayer/TrafficLightLayer'
import useDensityHeatmap from '../DensityHeatmap/DensityHeatmap'

/**
 * Initial camera centred on Riyadh, Saudi Arabia.
 * pitch=30 gives a 3-D tilt that makes extruded vehicle boxes visible
 * while keeping the map readable.
 */
const INITIAL_VIEW_STATE = {
  latitude: 24.7136,
  longitude: 46.6753,
  zoom: 15,
  pitch: 30,
  bearing: 0,
  minZoom: 8,
  maxZoom: 20,
}

/**
 * CARTO Dark Matter – free vector tile style, no API key required.
 * Dark background makes coloured vehicle dots and the heatmap pop.
 */
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

/**
 * MapView – full-screen map component.
 *
 * Architecture:
 *   A MapLibre GL map is mounted in a container div with interactive: false
 *   (MapLibre never handles pointer events).  A DeckGL canvas is overlaid on
 *   top as position:absolute and handles all user interactions (pan/zoom).
 *   On every viewState change, we call mapRef.jumpTo() to keep the two
 *   cameras in perfect sync.
 *
 * Layer order (bottom → top):
 *   1. HeatmapLayer        – subtle ambient density glow
 *   2. PathLayer           – road congestion (real edge shapes, red/orange pulse)
 *   3. CarLayer            – extruded 3-D boxes (6×3×2 m), lerp + heading
 *   4. TL outer/mid glow  – ScatterplotLayer rings (16 m / 12 m)
 *   5. TL inner dot        – ScatterplotLayer solid circle (8 m)
 *   6. TL TextLayer        – countdown seconds, billboard
 */
export default function MapView() {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)

  // ── Layer hooks ─────────────────────────────────────────────────────────
  // useDensityHeatmap  → [HeatmapLayer(ambient), LineLayer(road congestion)]
  // useCarLayer        → IconLayer (car icons with rotation + lerp)
  // useTrafficLightLayer → [IconLayer, TextLayer]
  const roadLayers = useDensityHeatmap()   // array: [ambientHeatmap, roadCongestion]
  const carLayer   = useCarLayer(viewState)
  const tlLayers   = useTrafficLightLayer()

  // ── Mount MapLibre GL ──────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current) return

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: [INITIAL_VIEW_STATE.longitude, INITIAL_VIEW_STATE.latitude],
      zoom: INITIAL_VIEW_STATE.zoom,
      pitch: INITIAL_VIEW_STATE.pitch,
      bearing: INITIAL_VIEW_STATE.bearing,
      interactive: false,  // DeckGL owns all pointer events
      attributionControl: false,
    })

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')
    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // ── Sync DeckGL viewState → MapLibre camera ────────────────────────────
  const onViewStateChange = useCallback(({ viewState: vs }) => {
    setViewState(vs)
    if (mapRef.current) {
      mapRef.current.jumpTo({
        center: [vs.longitude, vs.latitude],
        zoom: vs.zoom,
        pitch: vs.pitch ?? 0,
        bearing: vs.bearing ?? 0,
      })
    }
  }, [])

  // ── Tooltip on vehicle hover ───────────────────────────────────────────
  const getTooltip = useCallback(({ object, layer }) => {
    if (!object) return null

    const style = {
      background: 'rgba(15,23,42,0.88)',
      color: '#f1f5f9',
      fontSize: '12px',
      padding: '4px 8px',
      borderRadius: '4px',
      border: '1px solid rgba(255,255,255,0.1)',
      pointerEvents: 'none',
    }

    // Traffic light inner circle hover
    if (layer?.id === 'tl-inner') {
      const remaining = object.remaining ?? 0
      const state = object.state || '—'
      return { text: `TL-${object.id}: ${state} — ${remaining}s remaining`, style }
    }

    // Vehicle hover
    if (object.speed != null) {
      return { text: `Speed: ${object.speed.toFixed(1)} m/s`, style }
    }

    return null
  }, [])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* MapLibre base map */}
      <div
        ref={mapContainerRef}
        style={{ position: 'absolute', inset: 0 }}
      />

      {/* DeckGL overlay — canvas must be transparent so MapLibre tiles show through */}
      <DeckGL
        viewState={viewState}
        controller
        onViewStateChange={onViewStateChange}
        layers={[...roadLayers, carLayer, ...tlLayers]}
        getTooltip={getTooltip}
        style={{ position: 'absolute', inset: 0, background: 'transparent' }}
        parameters={{ clearColor: [0, 0, 0, 0] }}
      />
    </div>
  )
}
