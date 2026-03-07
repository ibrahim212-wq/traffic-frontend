import logging
import random
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional, Tuple

import torch

from .gcn_model import TrafficGCN, build_graph_from_sumo, predict_gcn
from .lstm_model import TrafficLSTM, predict_lstm
from .prophet_model import (
    build_prophet_dataframe,
    extract_forecast_values,
    forecast_prophet,
    load_historical_csv,
    train_prophet,
)
from .dijkstra import build_road_graph, find_k_shortest_paths, update_edge_weights

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Hyperparameters
# ---------------------------------------------------------------------------

GCN_IN_CHANNELS: int = 3        # [vehicle_count, avg_speed, density]
GCN_HIDDEN: int = 32
GCN_OUT: int = 1                 # congestion score logit per junction

LSTM_INPUT_SIZE: int = 1         # scalar: total vehicle count
LSTM_HIDDEN: int = 64
LSTM_LAYERS: int = 2
LSTM_OUTPUT: int = 1             # predicted vehicle count
LSTM_SEQ_LEN: int = 20           # rolling window length

CONGESTION_THRESHOLD: float = 0.6   # score ≥ this → junction is congested
PROPHET_MIN_ROWS: int = 10          # minimum observations before on-the-fly fit
HISTORICAL_CSV_PATH: str = "data/historical_traffic.csv"


# ---------------------------------------------------------------------------
# DecisionEngine
# ---------------------------------------------------------------------------

class DecisionEngine:
    """
    Orchestrates GCN, LSTM, and Prophet analyses on live SUMO data and
    produces actionable traffic control decisions.

    Modes
    -----
    mock    — models are initialised but not trained; returns plausible
              random values so the pipeline runs from step 1.
    trained — call mark_trained() after explicitly training GCN and LSTM
              to switch to real inference.
    """

    def __init__(self, historical_csv: str = HISTORICAL_CSV_PATH) -> None:
        self._trained: bool = False
        self._historical_csv: str = historical_csv

        # Rolling histories
        self._vehicle_history: Deque[float] = deque(maxlen=LSTM_SEQ_LEN)
        self._prophet_history: List[Tuple[float, float]] = []  # (unix_ts, count)

        # Road graph (rebuilt each call)
        self._road_graph: Optional[Any] = None

        # Model instances
        self._gcn: Optional[TrafficGCN] = None
        self._lstm: Optional[TrafficLSTM] = None
        self._prophet = None

        self._init_models()

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _init_models(self) -> None:
        """Instantiate model objects and attempt to load Prophet from CSV."""
        try:
            self._gcn = TrafficGCN(GCN_IN_CHANNELS, GCN_HIDDEN, GCN_OUT)
            logger.info("[DecisionEngine] GCN model initialised (untrained).")
        except Exception as exc:
            logger.error("[DecisionEngine] GCN init failed: %s", exc)

        try:
            self._lstm = TrafficLSTM(LSTM_INPUT_SIZE, LSTM_HIDDEN, LSTM_LAYERS, LSTM_OUTPUT)
            logger.info("[DecisionEngine] LSTM model initialised (untrained).")
        except Exception as exc:
            logger.error("[DecisionEngine] LSTM init failed: %s", exc)

        self._try_bootstrap_prophet()

    def _try_bootstrap_prophet(self) -> None:
        """Fit Prophet from historical CSV if the file exists."""
        try:
            df = load_historical_csv(self._historical_csv)
            if df is not None and len(df) >= PROPHET_MIN_ROWS:
                self._prophet = train_prophet(df)
                logger.info("[DecisionEngine] Prophet bootstrapped from historical CSV.")
        except Exception as exc:
            logger.warning("[DecisionEngine] Prophet bootstrap failed: %s", exc)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def analyze(self, sumo_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Main entry point. Accepts a raw SUMORunner.step() snapshot and
        returns a structured decision dict.

        Parameters
        ----------
        sumo_data : {"step": int, "vehicles": [...], "traffic_lights": [...]}

        Returns
        -------
        {
            "model_used"       : str,
            "action"           : str,
            "why"              : str,
            "confidence"       : float  (0.0 – 1.0),
            "rerouted_vehicles": list,
            "new_tl_phases"    : {tl_id: {"phase": int, "duration": int}},
            "gcn"              : {...},
            "lstm"             : {...},
            "prophet"          : {...},
        }
        """
        vehicles: List[Dict[str, Any]] = sumo_data.get("vehicles", [])
        traffic_lights: List[Dict[str, Any]] = sumo_data.get("traffic_lights", [])

        # Update rolling histories
        self._vehicle_history.append(float(len(vehicles)))
        self._prophet_history.append((time.time(), float(len(vehicles))))

        # Rebuild road graph from current TL snapshot
        self._road_graph = build_road_graph(traffic_lights, vehicles)

        # --- Run the three AI analyses ---
        gcn_result = self._run_gcn(vehicles, traffic_lights)
        lstm_result = self._run_lstm()
        prophet_result = self._run_prophet()

        # --- Identify most congested junction ---
        congested_id, congestion_score = self._worst_junction(gcn_result["congestion_scores"])

        # --- Rerouting via Dijkstra ---
        rerouted = self._compute_reroutes(gcn_result["congestion_scores"], traffic_lights)

        # --- Signal phase decision ---
        new_tl_phases: Dict[str, Any] = {}
        action = "No action required."
        why = "Traffic flow is within normal parameters across all monitored junctions."

        if congested_id and congestion_score >= CONGESTION_THRESHOLD:
            duration = min(60, max(10, int(congestion_score * 60)))
            new_tl_phases[congested_id] = {"phase": 0, "duration": duration}
            action = f"{congested_id} set RED for {duration} seconds"
            why = (
                f"Junction {congested_id} has a GCN congestion score of "
                f"{congestion_score:.2f} (threshold {CONGESTION_THRESHOLD}). "
                f"LSTM forecasts {lstm_result['predicted_vehicles']:.0f} vehicles in "
                f"the next 45 seconds. Holding RED to clear the downstream queue."
            )

        confidence = self._compute_confidence(gcn_result, lstm_result, prophet_result)

        active_models = [
            name
            for name, result in [("GCN", gcn_result), ("LSTM", lstm_result), ("Prophet", prophet_result)]
            if result.get("used_real_model")
        ]
        model_used = "+".join(active_models) if active_models else "GCN+LSTM (mock)"

        return {
            "model_used": model_used,
            "action": action,
            "why": why,
            "confidence": round(confidence, 4),
            "rerouted_vehicles": rerouted,
            "new_tl_phases": new_tl_phases,
            "gcn": gcn_result,
            "lstm": lstm_result,
            "prophet": prophet_result,
        }

    def mark_trained(self) -> None:
        """Switch from mock to real inference after GCN and LSTM have been trained."""
        self._trained = True
        logger.info("[DecisionEngine] Switched to trained inference mode.")

    # ------------------------------------------------------------------
    # GCN analysis
    # ------------------------------------------------------------------

    def _run_gcn(
        self,
        vehicles: List[Dict[str, Any]],
        traffic_lights: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Build road graph and predict a congestion score (0–1) per junction."""
        congestion_scores: Dict[str, float] = {}
        used_real = False

        if self._gcn is not None and traffic_lights:
            try:
                graph_data, node_ids = build_graph_from_sumo(vehicles, traffic_lights)
                logits = predict_gcn(self._gcn, graph_data)          # [n, 1]
                scores = torch.sigmoid(logits).squeeze(-1).tolist()
                if isinstance(scores, float):
                    scores = [scores]
                congestion_scores = {nid: round(s, 4) for nid, s in zip(node_ids, scores)}
                used_real = self._trained
            except Exception as exc:
                logger.warning("[GCN] Inference failed, using mock: %s", exc)

        if not congestion_scores:
            for tl in traffic_lights:
                congestion_scores[tl["id"]] = round(random.uniform(0.1, 0.85), 4)
            if not congestion_scores:
                congestion_scores["unknown"] = round(random.uniform(0.1, 0.5), 4)

        return {"congestion_scores": congestion_scores, "used_real_model": used_real}

    # ------------------------------------------------------------------
    # LSTM analysis
    # ------------------------------------------------------------------

    def _run_lstm(self) -> Dict[str, Any]:
        """Predict vehicle count 45 seconds ahead from the rolling window."""
        predicted = 0.0
        used_real = False

        if self._lstm is not None and len(self._vehicle_history) >= LSTM_SEQ_LEN:
            try:
                seq = list(self._vehicle_history)
                max_val = max(seq) if max(seq) > 0 else 1.0
                norm = [v / max_val for v in seq]
                tensor = torch.tensor(norm, dtype=torch.float).unsqueeze(0).unsqueeze(-1)
                out = predict_lstm(self._lstm, tensor)               # [1, 1]
                predicted = float(out.item()) * max_val
                used_real = self._trained
            except Exception as exc:
                logger.warning("[LSTM] Inference failed, using mock: %s", exc)

        if not used_real:
            last = self._vehicle_history[-1] if self._vehicle_history else 0.0
            predicted = max(0.0, last + random.gauss(0.0, last * 0.1 + 1.0))

        return {
            "predicted_vehicles": round(predicted, 2),
            "window_size": len(self._vehicle_history),
            "used_real_model": used_real,
        }

    # ------------------------------------------------------------------
    # Prophet analysis
    # ------------------------------------------------------------------

    def _run_prophet(self) -> Dict[str, Any]:
        """Forecast peak traffic 30 minutes ahead; fits on-the-fly if needed."""
        forecast: Dict[str, float] = {"yhat": 0.0, "yhat_lower": 0.0, "yhat_upper": 0.0}
        used_real = False

        # Attempt on-the-fly fit once enough observations accumulate
        if self._prophet is None and len(self._prophet_history) >= PROPHET_MIN_ROWS:
            try:
                ts = [t for t, _ in self._prophet_history]
                vs = [v for _, v in self._prophet_history]
                df = build_prophet_dataframe(ts, vs)
                self._prophet = train_prophet(df)
                logger.info("[Prophet] On-the-fly model fitted on %d observations.", len(df))
            except Exception as exc:
                logger.warning("[Prophet] On-the-fly fitting failed: %s", exc)

        if self._prophet is not None:
            try:
                fc = forecast_prophet(self._prophet, periods=1800, freq="S")
                forecast = extract_forecast_values(fc)
                used_real = True
            except Exception as exc:
                logger.warning("[Prophet] Forecast failed, using mock: %s", exc)

        if not used_real:
            base = self._vehicle_history[-1] if self._vehicle_history else 100.0
            yhat = base * random.uniform(0.8, 1.4)
            forecast = {
                "yhat": round(yhat, 2),
                "yhat_lower": round(yhat * 0.8, 2),
                "yhat_upper": round(yhat * 1.2, 2),
            }

        return {"forecast_30min": forecast, "used_real_model": used_real}

    # ------------------------------------------------------------------
    # Dijkstra rerouting
    # ------------------------------------------------------------------

    def _compute_reroutes(
        self,
        congestion_scores: Dict[str, float],
        traffic_lights: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        For every junction above the congestion threshold, find an alternative
        path to the next downstream junction using Dijkstra with BPR-weighted edges.
        """
        rerouted: List[Dict[str, Any]] = []
        if self._road_graph is None or self._road_graph.number_of_nodes() < 2:
            return rerouted

        update_edge_weights(self._road_graph, congestion_scores)
        node_list = list(self._road_graph.nodes)

        for tl_id, score in congestion_scores.items():
            if score < CONGESTION_THRESHOLD:
                continue
            try:
                idx = node_list.index(tl_id)
            except ValueError:
                continue
            if idx + 1 >= len(node_list):
                continue

            target = node_list[idx + 1]
            paths = find_k_shortest_paths(self._road_graph, tl_id, target, k=2)
            if len(paths) > 1:
                rerouted.append({
                    "from_junction": tl_id,
                    "to_junction": target,
                    "alternative_path": paths[1],
                    "congestion_score": round(score, 4),
                })

        return rerouted

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _worst_junction(
        self, congestion_scores: Dict[str, float]
    ) -> Tuple[Optional[str], float]:
        """Return the (junction_id, score) of the most congested node."""
        if not congestion_scores:
            return None, 0.0
        worst = max(congestion_scores, key=lambda k: congestion_scores[k])
        return worst, congestion_scores[worst]

    def _compute_confidence(
        self,
        gcn_result: Dict[str, Any],
        lstm_result: Dict[str, Any],
        prophet_result: Dict[str, Any],
    ) -> float:
        """
        Composite confidence score.

        Base  : LSTM window fill ratio scaled to [0.3, 0.7].
        Bonus : +0.10 per active real model (max +0.30).
        """
        window_fill = lstm_result["window_size"] / LSTM_SEQ_LEN
        base = 0.3 + 0.4 * window_fill
        bonus = sum([
            0.10 if gcn_result["used_real_model"] else 0.0,
            0.10 if lstm_result["used_real_model"] else 0.0,
            0.10 if prophet_result["used_real_model"] else 0.0,
        ])
        return min(1.0, base + bonus)


# ---------------------------------------------------------------------------
# Module-level convenience functions (kept for backward compatibility)
# ---------------------------------------------------------------------------

def analyze_traffic_state(live_data: Dict[str, Any]) -> Dict[str, Any]:
    """Stateless wrapper — creates a fresh DecisionEngine and calls analyze()."""
    return DecisionEngine().analyze(live_data)


def recommend_signal_phase(intersection_id: str, traffic_state: Dict[str, Any]) -> int:
    """Return the recommended phase index for the given intersection."""
    phases = traffic_state.get("new_tl_phases", {})
    return phases.get(intersection_id, {}).get("phase", 0)


def compute_reroute_suggestions(
    congestion_map: Dict[str, float],
    origin: str,
    destination: str,
) -> List[str]:
    """Use Dijkstra with live congestion weights to suggest an alternate route."""
    dummy_tls = [{"id": node, "current_phase": 0, "state": ""} for node in congestion_map]
    graph = build_road_graph(dummy_tls)
    update_edge_weights(graph, congestion_map)
    paths = find_k_shortest_paths(graph, origin, destination, k=2)
    return paths[1] if len(paths) > 1 else (paths[0] if paths else [])


def get_confidence_scores(predictions: Dict[str, Any]) -> Dict[str, float]:
    """Extract per-model confidence flags from a DecisionEngine result."""
    return {
        "gcn": 1.0 if predictions.get("gcn", {}).get("used_real_model") else 0.0,
        "lstm": 1.0 if predictions.get("lstm", {}).get("used_real_model") else 0.0,
        "prophet": 1.0 if predictions.get("prophet", {}).get("used_real_model") else 0.0,
    }
