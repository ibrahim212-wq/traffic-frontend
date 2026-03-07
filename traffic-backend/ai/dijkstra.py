import logging
from typing import Any, Dict, List, Optional

import networkx as nx

logger = logging.getLogger(__name__)


def build_road_graph(
    traffic_lights: List[Dict[str, Any]],
    vehicles: Optional[List[Dict[str, Any]]] = None,
) -> nx.DiGraph:
    """
    Construct a directed NetworkX graph from live SUMO data.

    Nodes  = traffic light junctions (keyed by TL ID).
    Edges  = sequential connections between adjacent TL nodes with a default
             travel_time of 30.0 seconds. Replace with real net.xml topology
             when available.

    Node attributes : phase, state (from TL data)
    Edge attributes : travel_time (seconds, updated dynamically by update_edge_weights)
    """
    G = nx.DiGraph()

    for tl in traffic_lights:
        G.add_node(
            tl["id"],
            phase=tl.get("current_phase", 0),
            state=tl.get("state", ""),
        )

    node_list = list(G.nodes)
    for i in range(len(node_list) - 1):
        G.add_edge(node_list[i], node_list[i + 1], travel_time=30.0)
        G.add_edge(node_list[i + 1], node_list[i], travel_time=30.0)

    logger.debug("[Dijkstra] Road graph built: %d nodes, %d edges.", G.number_of_nodes(), G.number_of_edges())
    return G


def find_shortest_path(
    graph: nx.DiGraph,
    source: str,
    target: str,
    weight: str = "travel_time",
) -> List[str]:
    """
    Return the shortest weighted path (list of node IDs) from source to target.
    Returns an empty list if no path exists or a node is missing.
    """
    try:
        return nx.shortest_path(graph, source=source, target=target, weight=weight)
    except nx.NetworkXNoPath:
        logger.warning("[Dijkstra] No path from '%s' to '%s'.", source, target)
        return []
    except nx.NodeNotFound as exc:
        logger.warning("[Dijkstra] Node not found: %s", exc)
        return []


def find_k_shortest_paths(
    graph: nx.DiGraph,
    source: str,
    target: str,
    k: int = 3,
    weight: str = "travel_time",
) -> List[List[str]]:
    """
    Return up to k shortest simple paths from source to target.
    Uses Yen's algorithm via networkx.shortest_simple_paths.
    Returns fewer than k paths if the graph does not have enough distinct routes.
    """
    results: List[List[str]] = []
    try:
        gen = nx.shortest_simple_paths(graph, source=source, target=target, weight=weight)
        for _ in range(k):
            try:
                results.append(next(gen))
            except StopIteration:
                break
    except nx.NetworkXNoPath:
        logger.warning("[Dijkstra] No simple paths from '%s' to '%s'.", source, target)
    except nx.NodeNotFound as exc:
        logger.warning("[Dijkstra] Node not found: %s", exc)
    return results


def update_edge_weights(
    graph: nx.DiGraph,
    congestion_data: Dict[str, float],
) -> None:
    """
    Update edge travel_time weights using BPR-inspired congestion scaling.

    congestion_data : {node_id: congestion_score}  where score is in [0.0, 1.0].
    Formula         : new_travel_time = base * (1 + 4 * score^4)
    Higher congestion → significantly longer effective travel time on outgoing edges.
    """
    for node, score in congestion_data.items():
        if node not in graph:
            continue
        score = max(0.0, min(1.0, score))
        multiplier = 1.0 + 4.0 * (score ** 4)
        for _, _, edge_data in graph.out_edges(node, data=True):
            base = edge_data.get("travel_time", 30.0)
            edge_data["travel_time"] = round(base * multiplier, 4)
