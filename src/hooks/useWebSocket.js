import { useEffect, useRef, useCallback } from 'react'
import { useSimulationStore } from '../store/simulationStore'

const WS_URL = `${import.meta.env.VITE_WS_URL}/ws/simulation`
const RECONNECT_DELAY_MS = 3000

/**
 * useWebSocket – manages the WebSocket connection to the backend simulation.
 *
 * Behaviour:
 *  - Connects to WS_URL on mount.
 *  - Each incoming JSON frame is written atomically to the Zustand store
 *    via setSimulationFrame (updates step, vehicles, trafficLights, aiDecision, history).
 *  - If the connection drops for any reason, schedules a reconnect after 3 s.
 *  - Sets isConnected true/false to reflect live connection state.
 *  - Cleans up the socket and any pending reconnect timer on unmount.
 *
 * @returns {{ isConnected: boolean }}
 */
export default function useWebSocket() {
  const ws = useRef(null)
  const reconnectTimer = useRef(null)
  const isMounted = useRef(true)

  const setSimulationFrame = useSimulationStore((state) => state.setSimulationFrame)
  const setConnected = useSimulationStore((state) => state.setConnected)
  const isConnected = useSimulationStore((state) => state.isConnected)

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimer.current !== null) {
      clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
  }, [])

  const connect = useCallback(() => {
    if (!isMounted.current) return

    // Avoid opening a second socket if one is already open/connecting
    if (
      ws.current &&
      (ws.current.readyState === WebSocket.OPEN ||
        ws.current.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    const socket = new WebSocket(WS_URL)
    ws.current = socket

    socket.onopen = () => {
      if (!isMounted.current) return
      setConnected(true)
      clearReconnectTimer()
    }

    socket.onmessage = (event) => {
      if (!isMounted.current) return
      try {
        const frame = JSON.parse(event.data)
        setSimulationFrame(frame)
      } catch (err) {
        console.warn('[useWebSocket] Failed to parse message:', err)
      }
    }

    socket.onerror = (err) => {
      console.error('[useWebSocket] WebSocket error:', err)
      setConnected(false)
    }

    socket.onclose = () => {
      if (!isMounted.current) return
      setConnected(false)
      ws.current = null
      // Schedule automatic reconnect
      clearReconnectTimer()
      reconnectTimer.current = setTimeout(() => {
        if (isMounted.current) connect()
      }, RECONNECT_DELAY_MS)
    }
  }, [setSimulationFrame, setConnected, clearReconnectTimer])

  const disconnect = useCallback(() => {
    clearReconnectTimer()
    if (ws.current) {
      ws.current.onclose = null  // prevent the onclose handler from firing a reconnect
      ws.current.close()
      ws.current = null
    }
    setConnected(false)
  }, [clearReconnectTimer, setConnected])

  useEffect(() => {
    isMounted.current = true
    connect()
    return () => {
      isMounted.current = false
      disconnect()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { isConnected }
}
