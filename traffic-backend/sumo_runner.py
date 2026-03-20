import os
import sys
import time
import threading
import logging
from typing import Any, Dict, List, Optional

from config import (
    SUMO_HOME,
    SUMO_CONFIG_FILE,
    SUMO_USE_GUI,
    SUMO_MAX_STEPS,
    SUMO_STEP_DELAY,
    DEFAULT_TRAFFIC_LIGHT_ID,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level shared state (used by the broadcast task in main.py)
# ---------------------------------------------------------------------------

live_traffic_data: Dict[str, Any] = {
    "step": 0,
    "total_vehicles": 0,
    "traffic_light_id": DEFAULT_TRAFFIC_LIGHT_ID,
    "current_phase": 0,
}

_stop_event = threading.Event()


# ---------------------------------------------------------------------------
# SUMORunner class
# ---------------------------------------------------------------------------

class SUMORunner:
    """
    Manages a SUMO simulation session via TraCI.

    Usage:
        runner = SUMORunner()
        runner.start()
        data = runner.step()   # call repeatedly
        runner.stop()
    """

    def __init__(
        self,
        config_file: str = SUMO_CONFIG_FILE,
        use_gui: bool = SUMO_USE_GUI,
    ) -> None:
        self.config_file = config_file
        self.use_gui = use_gui
        self._traci = None
        self._running = False
        self._current_step = 0
        self._setup_environment()

    # ------------------------------------------------------------------
    # Environment setup
    # ------------------------------------------------------------------

    def _setup_environment(self) -> None:
        """Append SUMO tools directory to sys.path and import traci."""
        sumo_home = SUMO_HOME or os.environ.get("SUMO_HOME", "")
        if not sumo_home:
            raise EnvironmentError(
                "SUMO_HOME is not set. "
                "Please set the SUMO_HOME environment variable to your SUMO installation directory."
            )
        tools_dir = os.path.join(sumo_home, "tools")
        if tools_dir not in sys.path:
            sys.path.append(tools_dir)

        import traci
        self._traci = traci

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the SUMO process and open the TraCI connection."""
        if self._running:
            logger.warning("SUMORunner.start() called but simulation is already running.")
            return

        binary = "sumo-gui" if self.use_gui else "sumo"
        cmd = [binary, "-c", self.config_file]

        try:
            self._traci.start(cmd)
            self._running = True
            self._current_step = 0
            logger.info("SUMO simulation started. Config: %s", self.config_file)
        except Exception as exc:
            logger.error("Failed to start SUMO simulation: %s", exc)
            raise

    def stop(self) -> None:
        """Close the TraCI connection and shut down the SUMO process."""
        if not self._running:
            return
        try:
            self._traci.close()
            logger.info("SUMO simulation stopped after %d steps.", self._current_step)
        except self._traci.exceptions.FatalTraCIError as exc:
            logger.warning("TraCI already closed or unreachable: %s", exc)
        except Exception as exc:
            logger.error("Error while closing TraCI connection: %s", exc)
        finally:
            self._running = False

    # ------------------------------------------------------------------
    # Simulation step
    # ------------------------------------------------------------------

    def step(self) -> Dict[str, Any]:
        """
        Advance the simulation by one step and return the full state snapshot.

        Returns
        -------
        dict with keys:
            "step"           – current simulation step (int)
            "vehicles"       – list of vehicle dicts
            "traffic_lights" – list of traffic light dicts
        """
        if not self._running:
            raise RuntimeError("SUMORunner.step() called before start().")

        try:
            self._traci.simulationStep()
            self._current_step += 1
        except self._traci.exceptions.FatalTraCIError as exc:
            logger.error("Fatal TraCI error at step %d: %s", self._current_step, exc)
            self._running = False
            raise

        vehicles = self._collect_vehicles()
        traffic_lights = self._collect_traffic_lights()
        road_congestion = self._get_road_congestion()

        return {
            "step": self._current_step,
            "vehicles": vehicles,
            "traffic_lights": traffic_lights,
            "road_congestion": road_congestion,
        }

    # ------------------------------------------------------------------
    # Data collection helpers
    # ------------------------------------------------------------------

    def _get_road_congestion(self) -> List[Dict[str, Any]]:
        """
        Return the top 50 most congested edges in the current simulation step.

        For each edge the congestion level is determined by the ratio of
        mean speed to max (free-flow) speed:
            ratio < 0.3  → "heavy"
            ratio < 0.7  → "medium"
            else         → "free"   (excluded from the result to keep packets small)

        Returns a list of dicts sorted by speed_ratio ascending (worst first),
        capped at 50 entries.
        """
        results: List[Dict[str, Any]] = []

        try:
            edge_ids = self._traci.edge.getIDList()
        except Exception as exc:
            logger.error("Failed to retrieve edge ID list: %s", exc)
            return results

        for edge_id in edge_ids:
            # Internal SUMO edges start with ':' — skip them (junctions, not roads)
            if edge_id.startswith(":"):
                continue
            try:
                vehicle_count = self._traci.edge.getLastStepVehicleNumber(edge_id)
                if vehicle_count == 0:
                    continue  # no vehicles → free flow, skip to keep packet small

                mean_speed = self._traci.edge.getLastStepMeanSpeed(edge_id)
                max_speed  = self._traci.edge.getMaxSpeed(edge_id)

                if max_speed <= 0:
                    continue

                ratio = mean_speed / max_speed

                if ratio < 0.3:
                    level = "heavy"
                elif ratio < 0.7:
                    level = "medium"
                else:
                    continue  # free flow — omit to keep packet small

                # Edge shape: list of (x, y) SUMO coords converted to [lng, lat]
                try:
                    shape_xy = self._traci.edge.getShape(edge_id)
                    shape = [list(self._convert_to_latlng(x, y)) for x, y in shape_xy]
                except Exception:
                    shape = []

                results.append({
                    "edge_id":     edge_id,
                    "level":       level,
                    "speed_ratio": round(ratio, 3),
                    "shape":       shape,
                })
            except Exception as exc:
                logger.warning("Could not read congestion for edge '%s': %s", edge_id, exc)

        # Sort worst-first and return at most 50 edges
        results.sort(key=lambda e: e["speed_ratio"])
        return results[:50]

    def _collect_vehicles(self) -> List[Dict[str, Any]]:
        """Return a list of dicts for every active vehicle in the simulation."""
        vehicles: List[Dict[str, Any]] = []

        try:
            vehicle_ids = self._traci.vehicle.getIDList()
        except Exception as exc:
            logger.error("Failed to retrieve vehicle ID list: %s", exc)
            return vehicles

        for vid in vehicle_ids:
            try:
                x, y = self._traci.vehicle.getPosition(vid)
                lng, lat = self._convert_to_latlng(x, y)
                vehicles.append({
                    "id": vid,
                    "x": x,
                    "y": y,
                    "lat": lat,
                    "lng": lng,
                    "speed": self._traci.vehicle.getSpeed(vid),
                    "angle": self._traci.vehicle.getAngle(vid),
                    "route_id": self._traci.vehicle.getRouteID(vid),
                })
            except self._traci.exceptions.TraCIException as exc:
                logger.warning("Could not read data for vehicle '%s': %s", vid, exc)
            except Exception as exc:
                logger.error("Unexpected error reading vehicle '%s': %s", vid, exc)

        return vehicles

    def _collect_traffic_lights(self) -> List[Dict[str, Any]]:
        """Return a list of dicts for every traffic light in the simulation."""
        traffic_lights: List[Dict[str, Any]] = []

        try:
            tl_ids = self._traci.trafficlight.getIDList()
        except Exception as exc:
            logger.error("Failed to retrieve traffic light ID list: %s", exc)
            return traffic_lights

        current_time = self._traci.simulation.getTime()

        for tl_id in tl_ids:
            try:
                state = self._traci.trafficlight.getRedYellowGreenState(tl_id)
                next_switch = self._traci.trafficlight.getNextSwitch(tl_id)
                phase = self._traci.trafficlight.getPhase(tl_id)
                time_remaining = max(0.0, next_switch - current_time)

                # Resolve junction position so the frontend can render TL icons
                try:
                    jx, jy = self._traci.junction.getPosition(tl_id)
                    lng, lat = self._convert_to_latlng(jx, jy)
                except Exception:
                    lng, lat = None, None

                traffic_lights.append({
                    "id": tl_id,
                    "current_phase": phase,
                    "state": state,
                    "phase_duration_remaining": round(time_remaining, 2),
                    "lat": lat,
                    "lng": lng,
                })
            except self._traci.exceptions.TraCIException as exc:
                logger.warning("Could not read data for traffic light '%s': %s", tl_id, exc)
            except Exception as exc:
                logger.error("Unexpected error reading traffic light '%s': %s", tl_id, exc)

        return traffic_lights

    # ------------------------------------------------------------------
    # Coordinate conversion
    # ------------------------------------------------------------------

    def _convert_to_latlng(self, x: float, y: float) -> tuple:
        """
        Convert SUMO internal (x, y) coordinates to (longitude, latitude)
        using traci.simulation.convertGeo().

        Returns (lng, lat) to match GeoJSON / Deck.gl conventions.
        """
        try:
            lng, lat = self._traci.simulation.convertGeo(x, y)
            return lng, lat
        except Exception as exc:
            logger.warning("Coordinate conversion failed for (%s, %s): %s", x, y, exc)
            return x, y

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def current_step(self) -> int:
        return self._current_step


# ---------------------------------------------------------------------------
# Module-level thread helpers (used by main.py lifespan)
# ---------------------------------------------------------------------------

def _setup_sumo_environment() -> None:
    """Append SUMO tools directory to sys.path."""
    sumo_home = SUMO_HOME or os.environ.get("SUMO_HOME", "")
    if not sumo_home:
        logger.error("SUMO_HOME is not set.")
        return
    tools_dir = os.path.join(sumo_home, "tools")
    if tools_dir not in sys.path:
        sys.path.append(tools_dir)


def start_simulation_thread() -> threading.Thread:
    """Create, start, and return the SUMO daemon thread."""
    _stop_event.clear()
    thread = threading.Thread(target=run_sumo_simulation, name="sumo-worker", daemon=True)
    thread.start()
    logger.info("SUMO simulation thread started.")
    return thread


def stop_simulation_thread(thread: threading.Thread, timeout: float = 5.0) -> None:
    """Signal the simulation thread to stop and wait for it to finish."""
    _stop_event.set()
    thread.join(timeout=timeout)
    logger.info("SUMO simulation thread stopped.")


def run_sumo_simulation() -> None:
    """
    Entry point for the SUMO background thread.
    Uses SUMORunner to drive the loop and keeps live_traffic_data updated.
    """
    runner = SUMORunner()
    try:
        runner.start()
        step = 0
        while not _stop_event.is_set() and step < SUMO_MAX_STEPS:
            try:
                snapshot = runner.step()

                tl_phase = 0
                for tl in snapshot["traffic_lights"]:
                    if tl["id"] == DEFAULT_TRAFFIC_LIGHT_ID:
                        tl_phase = tl["current_phase"]
                        break

                live_traffic_data["step"] = snapshot["step"]
                live_traffic_data["total_vehicles"] = len(snapshot["vehicles"])
                live_traffic_data["current_phase"] = tl_phase

                step += 1
                time.sleep(SUMO_STEP_DELAY)

            except Exception as exc:
                logger.error("Simulation loop error at step %d: %s", step, exc)
                break

        logger.info("Simulation loop finished after %d steps.", step)

    except Exception as exc:
        logger.error("SUMORunner failed to start: %s", exc)
    finally:
        runner.stop()
