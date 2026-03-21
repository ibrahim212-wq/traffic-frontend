import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { useSimulationStore } from '../../store/simulationStore'

// ── Mock mode toggle ────────────────────────────────────────────────────────
const MOCK_MODE = true

// ── Constants ─────────────────────────────────────────────────────────────────
const RIYADH_LNG    = 46.6753
const RIYADH_LAT    = 24.7136
const CAMERA_HEIGHT = MOCK_MODE ? 800 : 2000

// ── Static mock data ─────────────────────────────────────────────────────────

const MOCK_TL_BASE = [
  { id: 'tl0',  lng: 46.668,  lat: 24.700 },
  { id: 'tl1',  lng: 46.668,  lat: 24.710 },
  { id: 'tl2',  lng: 46.668,  lat: 24.720 },
  { id: 'tl3',  lng: 46.675,  lat: 24.700 },
  { id: 'tl4',  lng: 46.675,  lat: 24.710 },
  { id: 'tl5',  lng: 46.675,  lat: 24.720 },
  { id: 'tl6',  lng: 46.682,  lat: 24.700 },
  { id: 'tl7',  lng: 46.682,  lat: 24.710 },
  { id: 'tl8',  lng: 46.682,  lat: 24.720 },
  { id: 'tl9',  lng: 46.660,  lat: 24.705 },
  { id: 'tl10', lng: 46.660,  lat: 24.715 },
  { id: 'tl11', lng: 46.692,  lat: 24.700 },
  { id: 'tl12', lng: 46.692,  lat: 24.712 },
  { id: 'tl13', lng: 46.692,  lat: 24.722 },
  { id: 'tl14', lng: 46.665,  lat: 24.726 },
  { id: 'tl15', lng: 46.678,  lat: 24.726 },
  { id: 'tl16', lng: 46.670,  lat: 24.694 },
  { id: 'tl17', lng: 46.680,  lat: 24.694 },
  { id: 'tl18', lng: 46.656,  lat: 24.712 },
  { id: 'tl19', lng: 46.698,  lat: 24.715 },
]

// 15 road segments — King Fahd Rd, Olaya St, King Abdullah Rd, Northern Ring, connectors
const MOCK_ROAD_BASE = [
  { id: 'r0',  shape: [[46.668, 24.690], [46.668, 24.700]],              level: 'heavy'  },
  { id: 'r1',  shape: [[46.668, 24.700], [46.668, 24.710]],              level: 'medium' },
  { id: 'r2',  shape: [[46.668, 24.710], [46.668, 24.720], [46.668, 24.730]], level: 'heavy'  },
  { id: 'r3',  shape: [[46.682, 24.690], [46.682, 24.700], [46.682, 24.710]], level: 'heavy'  },
  { id: 'r4',  shape: [[46.682, 24.710], [46.682, 24.720], [46.682, 24.730]], level: 'medium' },
  { id: 'r5',  shape: [[46.655, 24.720], [46.665, 24.720], [46.675, 24.720]], level: 'heavy'  },
  { id: 'r6',  shape: [[46.675, 24.720], [46.685, 24.720], [46.695, 24.720]], level: 'medium' },
  { id: 'r7',  shape: [[46.660, 24.730], [46.675, 24.733], [46.690, 24.730]], level: 'heavy'  },
  { id: 'r8',  shape: [[46.700, 24.700], [46.700, 24.710], [46.700, 24.720]], level: 'medium' },
  { id: 'r9',  shape: [[46.660, 24.690], [46.673, 24.692], [46.685, 24.690]], level: 'heavy'  },
  { id: 'r10', shape: [[46.675, 24.700], [46.679, 24.706], [46.682, 24.710]], level: 'medium' },
  { id: 'r11', shape: [[46.658, 24.705], [46.662, 24.710], [46.665, 24.716]], level: 'heavy'  },
  { id: 'r12', shape: [[46.690, 24.705], [46.694, 24.710], [46.697, 24.716]], level: 'medium' },
  { id: 'r13', shape: [[46.662, 24.718], [46.670, 24.722], [46.680, 24.720]], level: 'heavy'  },
  { id: 'r14', shape: [[46.673, 24.694], [46.676, 24.700], [46.678, 24.706]], level: 'medium' },
]

const PHASE_SEQUENCE  = ['r', 'g', 'y']
const PHASE_DURATIONS = { r: 30, g: 25, y: 3 }

// ── Colour helpers ────────────────────────────────────────────────────────────

/** Speed (m/s) → Cesium.Color for vehicle box fill. */
function speedToColor(speed) {
  if (speed > 10) return Cesium.Color.fromCssColorString('#00FF44')
  if (speed >= 3) return Cesium.Color.fromCssColorString('#FF8800')
  return Cesium.Color.fromCssColorString('#FF2200')
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
      dimensions: new Cesium.Cartesian3(
        MOCK_MODE ? 12.0 : 8.0,
        MOCK_MODE ? 20.0 : 16.0,
        MOCK_MODE ? 5.0  : 4.0,
      ),
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

  const poleLen  = MOCK_MODE ? 8.0  : 4.0
  const poleTop  = MOCK_MODE ? 8.0  : 4.0
  const lightH   = MOCK_MODE ? 8.0  : 4.0
  const labelH   = MOCK_MODE ? 11.0 : 6.5
  const ellipseR = MOCK_MODE ? 10.0 : 3.0

  const pole = viewer.entities.add({
    id:       `tl-pole-${tl.id}`,
    position: Cesium.Cartesian3.fromDegrees(lng, lat, poleLen / 2),
    cylinder: {
      length:        poleLen,
      topRadius:     0.2,
      bottomRadius:  0.2,
      material:      Cesium.Color.fromCssColorString('#888888'),
    },
  })

  const light = viewer.entities.add({
    id:       `tl-light-${tl.id}`,
    position: Cesium.Cartesian3.fromDegrees(lng, lat, poleTop),
    ellipse: {
      semiMajorAxis: ellipseR,
      semiMinorAxis: ellipseR,
      height:        lightH,
      material:      new Cesium.ColorMaterialProperty(color),
    },
  })

  const label = viewer.entities.add({
    id:       `tl-label-${tl.id}`,
    position: Cesium.Cartesian3.fromDegrees(lng, lat, labelH),
    label: {
      text:              String(remaining),
      font:              MOCK_MODE ? 'bold 20px Inter, sans-serif' : 'bold 14px Inter, sans-serif',
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

  // Store slices (unused in MOCK_MODE)
  const vehicles       = useSimulationStore((s) => s.vehicles)
  const trafficLights  = useSimulationStore((s) => s.trafficLights)
  const roadCongestion = useSimulationStore((s) => s.roadCongestion)

  // ── Mock state ──────────────────────────────────────────────────────────
  const mockVehiclesRef = useRef(null)
  const mockTLsRef      = useRef(null)
  const mockRoadsRef    = useRef(null)
  const [mockVehicles, setMockVehicles]   = useState([])
  const [mockTLs,      setMockTLs]        = useState([])
  const [mockRoads,    setMockRoads]      = useState([])

  // ── Mock data intervals ─────────────────────────────────────────────────
  useEffect(() => {
    if (!MOCK_MODE) return

    // ── Initialize 200 vehicles scattered around Riyadh center
    mockVehiclesRef.current = Array.from({ length: 200 }, (_, i) => ({
      id:    `mock-v-${i}`,
      lng:   RIYADH_LNG + (Math.random() - 0.5) * 0.06,
      lat:   RIYADH_LAT + (Math.random() - 0.5) * 0.06,
      speed: 5 + Math.random() * 10,
      angle: Math.random() * Math.PI * 2,
    }))
    setMockVehicles([...mockVehiclesRef.current])

    // ── Initialize 20 traffic lights with random starting phase
    mockTLsRef.current = MOCK_TL_BASE.map(tl => {
      const phaseIdx = Math.floor(Math.random() * 3)
      const phase    = PHASE_SEQUENCE[phaseIdx]
      return {
        ...tl,
        state: phase,
        phase_duration_remaining: Math.floor(Math.random() * PHASE_DURATIONS[phase]),
      }
    })
    setMockTLs([...mockTLsRef.current])

    // ── Initialize 15 road segments
    mockRoadsRef.current = [...MOCK_ROAD_BASE]
    setMockRoads([...mockRoadsRef.current])

    // ── Vehicle movement: every 200ms
    const metersPerDegLat = 111000
    const metersPerDegLng = 111000 * Math.cos(RIYADH_LAT * Math.PI / 180)
    const vehicleTimer = setInterval(() => {
      mockVehiclesRef.current = mockVehiclesRef.current.map(v => {
        let lng   = v.lng + Math.cos(v.angle) * v.speed * 0.2 / metersPerDegLng
        let lat   = v.lat + Math.sin(v.angle) * v.speed * 0.2 / metersPerDegLat
        let angle = v.angle + (Math.random() - 0.5) * 0.1
        if (Math.abs(lng - RIYADH_LNG) > 0.05 || Math.abs(lat - RIYADH_LAT) > 0.05) {
          lng   = RIYADH_LNG + (Math.random() - 0.5) * 0.04
          lat   = RIYADH_LAT + (Math.random() - 0.5) * 0.04
          angle = Math.random() * Math.PI * 2
        }
        return { ...v, lng, lat, angle }
      })
      setMockVehicles([...mockVehiclesRef.current])
    }, 200)

    // ── TL countdown: every 1000ms
    const tlTimer = setInterval(() => {
      mockTLsRef.current = mockTLsRef.current.map(tl => {
        let remaining = tl.phase_duration_remaining - 1
        let state     = tl.state
        if (remaining <= 0) {
          state     = PHASE_SEQUENCE[(PHASE_SEQUENCE.indexOf(state) + 1) % 3]
          remaining = PHASE_DURATIONS[state]
        }
        return { ...tl, state, phase_duration_remaining: remaining }
      })
      setMockTLs([...mockTLsRef.current])
    }, 1000)

    // ── Road congestion: random shuffle every 8s
    const roadTimer = setInterval(() => {
      mockRoadsRef.current = MOCK_ROAD_BASE.map(r => ({
        ...r,
        level: Math.random() > 0.4 ? 'heavy' : 'medium',
      }))
      setMockRoads([...mockRoadsRef.current])
    }, 8000)

    return () => {
      clearInterval(vehicleTimer)
      clearInterval(tlTimer)
      clearInterval(roadTimer)
    }
  }, [])

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

      // Dark CartoDB basemap to match dashboard theme
      viewer.imageryLayers.removeAll()
      try {
        const darkProvider = await Cesium.OpenStreetMapImageryProvider.fromUrl(
          'https://basemaps.cartocdn.com/dark_all/',
          { credit: '© CartoDB © OpenStreetMap contributors' },
        )
        viewer.imageryLayers.addImageryProvider(darkProvider)
      } catch {
        viewer.imageryLayers.addImageryProvider(
          new Cesium.OpenStreetMapImageryProvider({ url: 'https://basemaps.cartocdn.com/dark_all/' }),
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
      viewer.scene.globe.show                       = true
      viewer.scene.skyBox.show                      = false
      viewer.scene.sun.show                         = false
      viewer.scene.moon.show                        = false
      viewer.scene.skyAtmosphere.show               = false

      // Camera: Riyadh city centre, 1500 m height, –45° pitch (oblique bird's-eye)
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(RIYADH_LNG, RIYADH_LAT, CAMERA_HEIGHT),
        orientation: {
          heading: Cesium.Math.toRadians(0),
          pitch:   Cesium.Math.toRadians(-45),
          roll:    0,
        },
      })

      // OSM 3-D buildings disabled — causes severe performance issues
      // if (import.meta.env.VITE_CESIUM_TOKEN) {
      //   try {
      //     const osmBuildings = await Cesium.createOsmBuildingsAsync()
      //     viewer.scene.primitives.add(osmBuildings)
      //   } catch { /* silently skip if token invalid */ }
      // }

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

    const activeVehicles = MOCK_MODE ? mockVehicles : vehicles

    // Calculate distance from camera for each vehicle
    const vehiclesWithDist = activeVehicles
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
  }, [vehicles, mockVehicles, viewerReady])

  // ── Update traffic lights ───────────────────────────────────────────────
  useEffect(() => {
    if (!viewerReady) return
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return

    const seen = new Set()

    const activeTLs = MOCK_MODE ? mockTLs : trafficLights

    for (const tl of activeTLs) {
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
  }, [trafficLights, mockTLs, viewerReady])

  // ── Update road congestion polylines ────────────────────────────────────
  useEffect(() => {
    if (!viewerReady) return
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return

    // Remove previous road overlay entirely (data changes per step)
    for (const e of roadEntitiesRef.current) viewer.entities.remove(e)
    roadEntitiesRef.current = []

    const activeRoads = MOCK_MODE ? mockRoads : roadCongestion

    for (const edge of activeRoads) {
      if (!Array.isArray(edge.shape) || edge.shape.length < 2) continue

      // [[lng,lat], ...] → flat [lng, lat, lng, lat, ...] for fromDegreesArray
      const flat      = edge.shape.flatMap(([lng, lat]) => [lng, lat])
      const positions = Cesium.Cartesian3.fromDegreesArray(flat)
      const color     = edge.level === 'heavy'
        ? Cesium.Color.fromCssColorString('#FF2200')
        : Cesium.Color.fromCssColorString('#FF8800')
      const width     = edge.level === 'heavy' ? 8 : 5

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
  }, [roadCongestion, mockRoads, viewerReady])

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    />
  )
}
