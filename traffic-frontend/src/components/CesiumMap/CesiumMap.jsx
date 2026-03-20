import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { useSimulationStore } from '../../store/simulationStore'

// ── Constants ─────────────────────────────────────────────────────────────────
const RIYADH_LNG    = 46.6753
const RIYADH_LAT    = 24.7136
const CAMERA_HEIGHT = 1500   // metres above Riyadh

// ── Colour helpers ────────────────────────────────────────────────────────────

/** Speed (m/s) → Cesium.Color for vehicle box fill. */
function speedToColor(speed) {
  if (speed > 10) return Cesium.Color.LIME
  if (speed >= 3) return Cesium.Color.ORANGE
  return Cesium.Color.RED
}

/**
 * SUMO traffic-light state string → Cesium.Color.
 * Inspects the dominant character across the whole phase string.
 */
function stateToColor(state = '') {
  const s = state.toLowerCase()
  const counts = { r: 0, y: 0, g: 0 }
  for (const ch of s) {
    if      (ch === 'r') counts.r++
    else if (ch === 'y') counts.y++
    else if (ch === 'g') counts.g++
  }
  const dom = Object.keys(counts).reduce((a, b) => counts[a] >= counts[b] ? a : b)
  if (dom === 'g') return Cesium.Color.LIME
  if (dom === 'y') return Cesium.Color.YELLOW
  return Cesium.Color.RED
}

// ── Entity factory helpers ────────────────────────────────────────────────────

/**
 * Create a new vehicle entity with a SampledPositionProperty so Cesium can
 * smoothly interpolate between consecutive WebSocket position updates.
 * VelocityOrientationProperty derives heading automatically from velocity.
 */
function createVehicleEntity(viewer, id, lng, lat, speed) {
  const now = Cesium.JulianDate.now()
  const pos = Cesium.Cartesian3.fromDegrees(lng, lat, 0.75)

  const sampledPos = new Cesium.SampledPositionProperty()
  sampledPos.addSample(now, pos)
  sampledPos.setInterpolationOptions({
    interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
    interpolationDegree: 1,   // linear – no overshooting between samples
  })

  return viewer.entities.add({
    id:          `v-${id}`,
    position:    sampledPos,
    orientation: new Cesium.VelocityOrientationProperty(sampledPos),
    box: {
      dimensions: new Cesium.Cartesian3(2.0, 4.5, 1.5),
      material:   new Cesium.ColorMaterialProperty(speedToColor(speed)),
    },
  })
}

/**
 * Create the 3-entity group (pole, light ellipse, countdown label) for one
 * traffic light junction.  Returns [pole, light, label] for later updates.
 */
function createTrafficLightEntities(viewer, tl) {
  const { lng, lat } = tl
  const color     = stateToColor(tl.state ?? '')
  const remaining = Math.round(tl.phase_duration_remaining ?? 0)

  const pole = viewer.entities.add({
    id:       `tl-pole-${tl.id}`,
    position: Cesium.Cartesian3.fromDegrees(lng, lat, 2.0),
    cylinder: {
      length:        4.0,
      topRadius:     0.2,
      bottomRadius:  0.2,
      material:      Cesium.Color.fromCssColorString('#888888'),
    },
  })

  const light = viewer.entities.add({
    id:       `tl-light-${tl.id}`,
    position: Cesium.Cartesian3.fromDegrees(lng, lat, 4.0),
    ellipse: {
      semiMajorAxis: 3.0,
      semiMinorAxis: 3.0,
      height:        4.0,
      material:      new Cesium.ColorMaterialProperty(color),
    },
  })

  const label = viewer.entities.add({
    id:       `tl-label-${tl.id}`,
    position: Cesium.Cartesian3.fromDegrees(lng, lat, 6.5),
    label: {
      text:              String(remaining),
      font:              'bold 14px Inter, sans-serif',
      fillColor:         Cesium.Color.WHITE,
      style:             Cesium.LabelStyle.FILL_AND_OUTLINE,
      outlineColor:      Cesium.Color.BLACK,
      outlineWidth:      2,
      verticalOrigin:    Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  })

  return [pole, light, label]
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * CesiumMap – full-screen 3D globe component using CesiumJS.
 *
 * Architecture:
 *   • One CesiumJS Viewer fills the container div.
 *   • Vehicles: box entities with SampledPositionProperty + LagrangeApproximation
 *     → Cesium auto-interpolates smooth movement between WebSocket ticks.
 *   • Traffic lights: cylinder (pole) + ellipse (lamp) + floating label per junction.
 *   • Road congestion: PolylineGlowMaterialProperty polylines on actual edge geometry
 *     from the backend (traci.edge.getShape).
 *   • Entity map refs (vehicleMapRef, tlMapRef) enable O(1) update-vs-create decisions.
 *
 * Keeps:
 *   • useWebSocket, Zustand store, AI Panel, header, footer — all unchanged.
 */
export default function CesiumMap() {
  const containerRef     = useRef(null)
  const viewerRef        = useRef(null)
  const vehicleMapRef    = useRef({})   // vehicleId  → entity
  const tlMapRef         = useRef({})   // tlId       → [pole, light, label]
  const roadEntitiesRef  = useRef([])   // polyline entities (replaced wholesale)

  // Signals that the viewer is ready; other effects gate on this.
  const [viewerReady, setViewerReady] = useState(false)

  // Store slices
  const vehicles      = useSimulationStore((s) => s.vehicles)
  const trafficLights = useSimulationStore((s) => s.trafficLights)
  const roadCongestion = useSimulationStore((s) => s.roadCongestion)

  // ── Viewer initialization ───────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return

    async function initViewer() {
      Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN ?? ''

      const viewer = new Cesium.Viewer(containerRef.current, {
        timeline:             false,
        animation:            false,
        baseLayerPicker:      false,
        navigationHelpButton: false,
        sceneModePicker:      false,
        homeButton:           false,
        geocoder:             false,
        infoBox:              false,
        selectionIndicator:   false,
        fullscreenButton:     false,
      })

      // Replace default Bing layer with OpenStreetMap (no Ion token required)
      viewer.imageryLayers.removeAll()
      try {
        const osmProvider = await Cesium.OpenStreetMapImageryProvider.fromUrl(
          'https://tile.openstreetmap.org/',
          { credit: '© OpenStreetMap contributors' },
        )
        viewer.imageryLayers.addImageryProvider(osmProvider)
      } catch {
        // Fallback: constructor form (Cesium < 1.104)
        viewer.imageryLayers.addImageryProvider(
          new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
        )
      }

      // Globe / scene settings — optimized for performance
      viewer.scene.fog.enabled                      = true
      viewer.scene.fog.density                      = 0.0001
      viewer.scene.globe.enableLighting             = false
      viewer.scene.globe.showGroundAtmosphere       = false
      viewer.scene.globe.maximumScreenSpaceError    = 4
      viewer.shadows                                = false
      viewer.clock.shouldAnimate                    = true

      // Camera: Riyadh city centre, 1500 m height, –45° pitch (oblique bird's-eye)
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(RIYADH_LNG, RIYADH_LAT, CAMERA_HEIGHT),
        orientation: {
          heading: Cesium.Math.toRadians(0),
          pitch:   Cesium.Math.toRadians(-45),
          roll:    0,
        },
      })

      // OSM 3-D buildings – optimized with LOD and 500m radius culling
      if (import.meta.env.VITE_CESIUM_TOKEN) {
        try {
          const osmBuildings = await Cesium.createOsmBuildingsAsync()
          osmBuildings.maximumScreenSpaceError = 32  // Reduce detail for performance
          
          // Limit building visibility to 500m radius from camera
          viewer.scene.preRender.addEventListener(() => {
            const cameraPos = viewer.camera.positionCartographic
            const camHeight = cameraPos.height
            if (camHeight < 3000) {
              osmBuildings.show = true
              // Cull buildings beyond 500m from camera center
              const camCenter = Cesium.Cartesian3.fromRadians(
                cameraPos.longitude,
                cameraPos.latitude,
                0
              )
              osmBuildings.cullWithChildrenBounds = false
            } else {
              osmBuildings.show = false
            }
          })
          
          viewer.scene.primitives.add(osmBuildings)
        } catch { /* silently skip if token invalid */ }
      }

      viewerRef.current = viewer
      setViewerReady(true)
    }

    initViewer()

    return () => {
      vehicleMapRef.current   = {}
      tlMapRef.current        = {}
      roadEntitiesRef.current = []
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.destroy()
        viewerRef.current = null
      }
    }
  }, [])

  // ── Update vehicles ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!viewerReady) return
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return

    const now  = Cesium.JulianDate.now()
    const seen = new Set()

    // Performance: limit to 300 closest vehicles to camera center
    const cameraPos = viewer.camera.positionCartographic
    const cameraCart = Cesium.Cartesian3.fromRadians(
      cameraPos.longitude,
      cameraPos.latitude,
      0
    )

    // Calculate distance from camera for each vehicle
    const vehiclesWithDist = vehicles
      .filter(v => v.lng != null && v.lat != null)
      .map(v => {
        const vPos = Cesium.Cartesian3.fromDegrees(v.lng, v.lat, 0)
        const dist = Cesium.Cartesian3.distance(cameraCart, vPos)
        return { ...v, dist }
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 300)  // Keep only 300 closest

    for (const v of vehiclesWithDist) {
      seen.add(v.id)

      const pos   = Cesium.Cartesian3.fromDegrees(v.lng, v.lat, 0.75)
      const color = speedToColor(v.speed ?? 0)

      const existing = vehicleMapRef.current[v.id]
      if (existing) {
        // Update existing entity — add position sample + recolor
        existing.position.addSample(now, pos)
        existing.box.material = new Cesium.ColorMaterialProperty(color)
      } else {
        // New vehicle — create entity with SampledPositionProperty
        const entity = createVehicleEntity(viewer, v.id, v.lng, v.lat, v.speed ?? 0)
        vehicleMapRef.current[v.id] = entity
      }
    }

    // Remove vehicles that left the simulation or are beyond 300 limit
    for (const id of Object.keys(vehicleMapRef.current)) {
      if (!seen.has(id)) {
        viewer.entities.remove(vehicleMapRef.current[id])
        delete vehicleMapRef.current[id]
      }
    }
  }, [vehicles, viewerReady])

  // ── Update traffic lights ───────────────────────────────────────────────
  useEffect(() => {
    if (!viewerReady) return
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return

    const seen = new Set()

    for (const tl of trafficLights) {
      if (tl.lng == null || tl.lat == null) continue
      seen.add(tl.id)

      const color     = stateToColor(tl.state ?? '')
      const remaining = Math.round(tl.phase_duration_remaining ?? 0)

      const existing = tlMapRef.current[tl.id]
      if (existing) {
        const [, light, label] = existing
        light.ellipse.material = new Cesium.ColorMaterialProperty(color)
        label.label.text       = String(remaining)
      } else {
        tlMapRef.current[tl.id] = createTrafficLightEntities(viewer, tl)
      }
    }

    // Remove stale traffic lights
    for (const id of Object.keys(tlMapRef.current)) {
      if (!seen.has(id)) {
        for (const e of tlMapRef.current[id]) viewer.entities.remove(e)
        delete tlMapRef.current[id]
      }
    }
  }, [trafficLights, viewerReady])

  // ── Update road congestion polylines ────────────────────────────────────
  useEffect(() => {
    if (!viewerReady) return
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return

    // Remove previous road overlay entirely (data changes per step)
    for (const e of roadEntitiesRef.current) viewer.entities.remove(e)
    roadEntitiesRef.current = []

    for (const edge of roadCongestion) {
      if (!Array.isArray(edge.shape) || edge.shape.length < 2) continue

      // [[lng,lat], ...] → flat [lng, lat, lng, lat, ...] for fromDegreesArray
      const flat      = edge.shape.flatMap(([lng, lat]) => [lng, lat])
      const positions = Cesium.Cartesian3.fromDegreesArray(flat)
      const color     = edge.level === 'heavy' ? Cesium.Color.RED : Cesium.Color.ORANGE
      const width     = edge.level === 'heavy' ? 6 : 4

      const entity = viewer.entities.add({
        polyline: {
          positions,
          width,
          clampToGround: true,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.3,
            color,
          }),
        },
      })
      roadEntitiesRef.current.push(entity)
    }
  }, [roadCongestion, viewerReady])

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    />
  )
}
