import { create } from 'zustand'

const HISTORY_LIMIT = 60

/**
 * simulationStore – global Zustand store for all live simulation state.
 *
 * State shape:
 *  step          {number}        – current simulation step
 *  vehicles      {Array}         – live vehicle objects from SUMO
 *  trafficLights {Array}         – live traffic light objects from SUMO
 *  aiDecision    {Object|null}   – latest AI decision from DecisionEngine
 *  isConnected   {boolean}       – WebSocket connection state
 *  history       {Array}         – rolling buffer of {step, totalVehicles} snapshots
 *  roadCongestion {Array}         – top-50 congested edges with shape geometry from SUMO
 */
export const useSimulationStore = create((set, get) => ({
  step: 0,
  vehicles: [],
  trafficLights: [],
  roadCongestion: [],
  aiDecision: null,
  isConnected: false,
  history: [],
  totalRerouted: 0,   // session-cumulative rerouted junction count

  setVehicles: (vehicles) => set({ vehicles }),

  setTrafficLights: (trafficLights) => set({ trafficLights }),

  setAIDecision: (aiDecision) => set({ aiDecision }),

  setConnected: (isConnected) => set({ isConnected }),

  setSimulationFrame: (frame) => {
    const { history, totalRerouted } = get()
    const snapshot = {
      step: frame.step,
      totalVehicles: frame.vehicles?.length ?? 0,
    }
    const updatedHistory = [...history, snapshot].slice(-HISTORY_LIMIT)
    const newReroutes = frame.ai_decision?.rerouted_vehicles?.length ?? 0
    set({
      step: frame.step ?? 0,
      vehicles:       frame.vehicles ?? [],
      trafficLights:  frame.traffic_lights ?? [],
      roadCongestion: frame.road_congestion ?? [],
      aiDecision:     frame.ai_decision ?? null,
      history: updatedHistory,
      totalRerouted: totalRerouted + newReroutes,
    })
  },

  clearHistory: () => set({ history: [], totalRerouted: 0 }),
}))
