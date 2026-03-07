import { useSimulationStore } from '../store/simulationStore'

/**
 * useSimulation – convenience hook that exposes derived simulation state
 * and control actions from the Zustand store.
 *
 * @returns {Object} Simulation state slices and action helpers
 */
export default function useSimulation() {
  const step = useSimulationStore((state) => state.step)
  const totalVehicles = useSimulationStore((state) => state.totalVehicles)
  const trafficLightId = useSimulationStore((state) => state.trafficLightId)
  const currentPhase = useSimulationStore((state) => state.currentPhase)
  const connectionStatus = useSimulationStore((state) => state.connectionStatus)
  const history = useSimulationStore((state) => state.history)

  // TODO: Derive additional computed values (e.g., congestion level) from state
  // TODO: Expose any simulation control actions (pause, reset) when backend supports them

  return {
    step,
    totalVehicles,
    trafficLightId,
    currentPhase,
    connectionStatus,
    history,
  }
}
