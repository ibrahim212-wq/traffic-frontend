import asyncio
import json
import logging
import threading
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import HOST, PORT
from sumo_runner import SUMORunner
from ai.decision_engine import DecisionEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

STEP_INTERVAL: float = 0.1  # 100 ms between simulation steps


# ---------------------------------------------------------------------------
# Per-client simulation session
# ---------------------------------------------------------------------------

class SimulationSession:
    """
    Owns one SUMORunner + one DecisionEngine for a single WebSocket client.

    The heavy TraCI work runs in a daemon thread (_worker).
    Results are placed onto an asyncio.Queue so the WebSocket coroutine
    can await them without blocking the event loop.
    """

    def __init__(self, client_id: str, loop: asyncio.AbstractEventLoop) -> None:
        self.client_id = client_id
        self._loop = loop
        self._queue: asyncio.Queue[Optional[Dict[str, Any]]] = asyncio.Queue(maxsize=10)
        self._stop = threading.Event()
        self._runner: Optional[SUMORunner] = None
        self._engine: Optional[DecisionEngine] = None
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Initialise models and launch the background worker thread."""
        self._runner = SUMORunner()
        self._engine = DecisionEngine()
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._worker,
            name=f"sumo-{self.client_id[:8]}",
            daemon=True,
        )
        self._thread.start()
        logger.info("[Session %s] Started.", self.client_id[:8])

    def stop(self) -> None:
        """Signal the worker to exit and wait for it (up to 5 s)."""
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5.0)
        logger.info("[Session %s] Stopped.", self.client_id[:8])

    # ------------------------------------------------------------------
    # Background worker (runs in its own thread)
    # ------------------------------------------------------------------

    def _worker(self) -> None:
        try:
            self._runner.start()
            logger.info("[Session %s] SUMO started.", self.client_id[:8])

            while not self._stop.is_set():
                # (a) Advance simulation by one step
                snapshot = self._runner.step()

                # (b) Run AI decision engine
                decision = self._engine.analyze(snapshot)

                # (c) Apply recommended TL phases back to SUMO via TraCI
                self._apply_tl_phases(decision.get("new_tl_phases", {}))

                # (d) Build combined packet
                packet: Dict[str, Any] = {
                    "step": snapshot["step"],
                    "vehicles": snapshot["vehicles"],
                    "traffic_lights": snapshot["traffic_lights"],
                    "ai_decision": {
                        "model_used": decision["model_used"],
                        "action": decision["action"],
                        "why": decision["why"],
                        "confidence": decision["confidence"],
                        "rerouted_vehicles": decision["rerouted_vehicles"],
                        "new_tl_phases": decision["new_tl_phases"],
                        "gcn": decision.get("gcn", {}),
                        "lstm": decision.get("lstm", {}),
                        "prophet": decision.get("prophet", {}),
                    },
                }

                # (e) Hand packet to the asyncio queue (non-blocking put)
                try:
                    self._loop.call_soon_threadsafe(
                        self._queue.put_nowait, packet
                    )
                except asyncio.QueueFull:
                    pass  # Drop frame if client is lagging

                # 100 ms cadence
                self._stop.wait(timeout=STEP_INTERVAL)

        except Exception as exc:
            logger.error("[Session %s] Worker error: %s", self.client_id[:8], exc)
        finally:
            # Signal the WebSocket coroutine that the stream has ended
            self._loop.call_soon_threadsafe(self._queue.put_nowait, None)
            if self._runner:
                self._runner.stop()

    # ------------------------------------------------------------------
    # TL phase application
    # ------------------------------------------------------------------

    def _apply_tl_phases(self, new_tl_phases: Dict[str, Any]) -> None:
        """
        Apply AI-recommended signal phases back to the running simulation.
        Errors are caught per-junction so one bad ID doesn't abort the loop.
        """
        if not new_tl_phases or self._runner is None:
            return
        traci = self._runner._traci
        if traci is None:
            return
        for tl_id, spec in new_tl_phases.items():
            try:
                phase = int(spec.get("phase", 0))
                traci.trafficlight.setPhase(tl_id, phase)
                logger.debug(
                    "[Session %s] TL %s → phase %d",
                    self.client_id[:8], tl_id, phase,
                )
            except Exception as exc:
                logger.warning(
                    "[Session %s] Could not set phase for TL '%s': %s",
                    self.client_id[:8], tl_id, exc,
                )

    # ------------------------------------------------------------------
    # Queue accessor
    # ------------------------------------------------------------------

    async def next_packet(self) -> Optional[Dict[str, Any]]:
        """Await the next simulation packet. Returns None when stream ends."""
        return await self._queue.get()


# ---------------------------------------------------------------------------
# Lifespan (no global SUMO thread — sessions are per-client)
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Smart City Traffic API starting up.")
    yield
    logger.info("Smart City Traffic API shutting down.")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Smart City Traffic API",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",   # React/Vite dev server
        "http://127.0.0.1:5173",
        "http://localhost:3000",   # CRA fallback
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# WebSocket endpoint  —  ws://localhost:8000/ws/simulation
# ---------------------------------------------------------------------------

@app.websocket("/ws/simulation")
async def websocket_simulation_endpoint(websocket: WebSocket) -> None:
    client_id = str(uuid.uuid4())
    await websocket.accept()
    logger.info("[WS] Client %s connected.", client_id[:8])

    loop = asyncio.get_event_loop()
    session = SimulationSession(client_id=client_id, loop=loop)

    try:
        session.start()

        while True:
            packet = await session.next_packet()

            # None sentinel means the worker thread has exited
            if packet is None:
                logger.info("[WS] Client %s: simulation stream ended.", client_id[:8])
                break

            try:
                await websocket.send_text(json.dumps(packet))
            except WebSocketDisconnect:
                logger.info("[WS] Client %s disconnected during send.", client_id[:8])
                break
            except Exception as exc:
                logger.warning("[WS] Client %s send error: %s", client_id[:8], exc)
                break

    except WebSocketDisconnect:
        logger.info("[WS] Client %s disconnected.", client_id[:8])
    except Exception as exc:
        logger.error("[WS] Client %s unexpected error: %s", client_id[:8], exc)
    finally:
        session.stop()
        try:
            await websocket.close()
        except Exception:
            pass
        logger.info("[WS] Client %s session cleaned up.", client_id[:8])


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/")
async def root() -> Dict[str, str]:
    return {
        "message": "Smart City Traffic API is running",
        "version": "2.0.0",
        "websocket": f"ws://localhost:{PORT}/ws/simulation",
        "health": f"http://localhost:{PORT}/health",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
