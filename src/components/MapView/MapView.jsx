import { useEffect, useRef, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import DeckGL from '@deck.gl/react'
import useCarLayer from '../CarLayer/CarLayer'
import useTrafficLightLayer from '../TrafficLightLayer/TrafficLightLayer'
import useDensityHeatmap from '../DensityHeatmap/DensityHeatmap'

/**
 * Initial camera centred on Riyadh, Saudi Arabia.
 * pitch=45 gives a slight 3-D tilt that makes vehicle dots more readable.
 */
const INITIAL_VIEW_STATE = {
  latitude: 24.7136,
  longitude: 46.6753,
  zoom: 14,
  pitch: 45,
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
 *   1. DensityHeatmap      – traffic density glow beneath everything
 *   2. CarLayer            – animated vehicle dots with lerp interpolation
 *   3. TL IconLayer        – signal state circles (r/y/g)
 *   4. TL TextLayer        – countdown seconds floating above icons
 */
export default function MapView() {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE)

  // ── Layer hooks ─────────────────────────────────────────────────────────
  // useTrafficLightLayer returns [IconLayer, TextLayer]
  const heatmapLayer = useDensityHeatmap()
  const carLayer = useCarLayer()
  const tlLayers = useTrafficLightLayer()  // array: [iconLayer, textLayer]

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

    // Traffic light icon hover
    if (layer?.id === 'tl-icon-layer') {
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

      {/* DeckGL overlay */}
      <DeckGL
        viewState={viewState}
        controller
        onViewStateChange={onViewStateChange}
        layers={[heatmapLayer, carLayer, ...tlLayers]}
        getTooltip={getTooltip}
        style={{ position: 'absolute', inset: 0 }}
      />
    </div>
  )
}
