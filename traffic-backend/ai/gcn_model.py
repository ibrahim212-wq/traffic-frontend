import logging
from typing import Any, Dict, List, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.data import Data
from torch_geometric.nn import GCNConv

logger = logging.getLogger(__name__)


class TrafficGCN(nn.Module):
    """
    2-layer Graph Convolutional Network for traffic congestion prediction.

    Input node features : [vehicle_count, avg_speed, density]  (in_channels=3)
    Output per node     : congestion score logit               (out_channels=1)
    """

    def __init__(self, in_channels: int, hidden_channels: int, out_channels: int) -> None:
        super().__init__()
        self.conv1 = GCNConv(in_channels, hidden_channels)
        self.conv2 = GCNConv(hidden_channels, hidden_channels)
        self.head = nn.Linear(hidden_channels, out_channels)
        self.dropout = nn.Dropout(p=0.3)

    def forward(self, data: Data) -> torch.Tensor:
        x, edge_index = data.x, data.edge_index
        x = F.relu(self.conv1(x, edge_index))
        x = self.dropout(x)
        x = F.relu(self.conv2(x, edge_index))
        return self.head(x)  # [num_nodes, out_channels]


def build_graph_from_sumo(
    vehicles: List[Dict[str, Any]],
    traffic_lights: List[Dict[str, Any]],
) -> Tuple[Data, List[str]]:
    """
    Build a torch_geometric Data object from a live SUMO snapshot.

    Nodes  = traffic light junctions (one per TL ID).
    Edges  = fully connected directed graph (placeholder until net.xml is parsed).
    Node features = [vehicle_count, avg_speed, density].

    Returns
    -------
    (Data, node_ids)  where node_ids[i] is the TL id for node i.
    """
    if not traffic_lights:
        return Data(x=torch.zeros(1, 3), edge_index=torch.zeros(2, 0, dtype=torch.long)), ["unknown"]

    node_ids = [tl["id"] for tl in traffic_lights]
    n = len(node_ids)

    # Distribute vehicles evenly across junctions (approximation without net.xml)
    per_node = max(1, len(vehicles) // n) if vehicles else 0
    features: List[List[float]] = []
    for i in range(n):
        chunk = vehicles[i * per_node : (i + 1) * per_node]
        count = float(len(chunk))
        avg_speed = sum(v.get("speed", 0.0) for v in chunk) / count if count > 0 else 0.0
        density = count / 100.0  # vehicles per 100 m (normalised placeholder)
        features.append([count, avg_speed, density])

    x = torch.tensor(features, dtype=torch.float)

    # Fully connected directed edges
    src, dst = zip(*[(i, j) for i in range(n) for j in range(n) if i != j]) if n > 1 else ([], [])
    edge_index = (
        torch.tensor([list(src), list(dst)], dtype=torch.long)
        if src
        else torch.zeros(2, 0, dtype=torch.long)
    )

    return Data(x=x, edge_index=edge_index), node_ids


def train_gcn(model: TrafficGCN, data: Data, epochs: int = 100) -> None:
    """Supervised training loop — data.y must contain per-node congestion labels."""
    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3, weight_decay=5e-4)
    criterion = nn.MSELoss()
    model.train()
    for epoch in range(epochs):
        optimizer.zero_grad()
        loss = criterion(model(data), data.y)
        loss.backward()
        optimizer.step()
        if (epoch + 1) % 20 == 0:
            logger.debug("[GCN] epoch %d/%d  loss=%.4f", epoch + 1, epochs, loss.item())


def predict_gcn(model: TrafficGCN, data: Data) -> torch.Tensor:
    """Return raw congestion logits per node. Shape: [num_nodes, out_channels]."""
    model.eval()
    with torch.no_grad():
        return model(data)
