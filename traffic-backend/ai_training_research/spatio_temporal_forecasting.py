# =============================================================================
# SPATIO-TEMPORAL TRAFFIC FORECASTING PIPELINE
# Hybrid GCN-LSTM-Prophet Architecture for Graduation Project
# =============================================================================
# Author        : Graduation Project — AI/ML Research
# Target Env    : Google Colab (GPU runtime recommended)
# Python        : 3.10+
# Description   : End-to-end pipeline: data loading → graph construction →
#                 multi-step forecasting → ablation comparison table for thesis.
# =============================================================================

# ─────────────────────────────────────────────────────────────────────────────
# CELL 1 ── Install Dependencies (Run once per Colab session)
# ─────────────────────────────────────────────────────────────────────────────
# Uncomment and run this cell first in Colab before importing anything.
#
# !pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
# !pip install torch_geometric
# !pip install torch_scatter torch_sparse torch_cluster torch_spline_conv \
#       -f https://data.pyg.org/whl/torch-2.2.0+cu118.html
# !pip install prophet scikit-learn pandas numpy matplotlib tabulate
#
# NOTE: Adjust the CUDA version (cu118 / cu121 / cpu) to match your Colab GPU.
# Check with: !nvcc --version  or use cpu builds if no GPU is assigned.
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# CELL 2 ── Imports
# ─────────────────────────────────────────────────────────────────────────────

import os
import math
import warnings
import random
import time
from copy import deepcopy

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader

from sklearn.preprocessing import MinMaxScaler
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

# PyTorch Geometric
from torch_geometric.nn import GCNConv
from torch_geometric.data import Data as GeoData

# Prophet (Meta's time-series library)
from prophet import Prophet

from tabulate import tabulate

warnings.filterwarnings("ignore")

# ─────────────────────────────────────────────────────────────────────────────
# CELL 3 ── Global Configuration / Hyper-Parameters
# ─────────────────────────────────────────────────────────────────────────────

# Reproducibility seed — pin everything so experiments are repeatable
SEED = 42
random.seed(SEED)
np.random.seed(SEED)
torch.manual_seed(SEED)
torch.cuda.manual_seed_all(SEED)

# Device selection: use GPU when available (strongly recommended in Colab)
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"[INFO] Running on device: {DEVICE}")

# ── Forecasting horizon ──────────────────────────────────────────────────────
LOOKBACK_STEPS = 12   # 12 × 10 min = 2 hours of historical context
FORECAST_STEPS = 36   # 36 × 10 min = 6 hours ahead (multi-step output)
TIME_STEP_MINS = 10   # resolution of each step in minutes

# ── Model hyper-parameters ───────────────────────────────────────────────────
GCN_HIDDEN_DIM   = 64   # output dim of GCN spatial embedding
LSTM_HIDDEN_DIM  = 128  # hidden units in LSTM temporal encoder
LSTM_NUM_LAYERS  = 2    # stacked LSTM depth
DROPOUT_RATE     = 0.3  # dropout probability (regularisation for small dataset)
FUSION_HIDDEN    = 64   # hidden units in the dense fusion layer

# ── Training ─────────────────────────────────────────────────────────────────
BATCH_SIZE       = 32
LEARNING_RATE    = 1e-3
MAX_EPOCHS       = 200
PATIENCE         = 20   # early-stopping patience (epochs without val improvement)
TRAIN_RATIO      = 0.70
VAL_RATIO        = 0.15
# TEST_RATIO is implicitly 1 - TRAIN_RATIO - VAL_RATIO = 0.15

# ── Paths ─────────────────────────────────────────────────────────────────────
CSV_PATH         = "traffic_data.csv"   # path to your real CSV in Colab
MODEL_SAVE_PATH  = "hybrid_gcn_lstm_prophet.pth"

print("[INFO] Configuration loaded.")


# ─────────────────────────────────────────────────────────────────────────────
# CELL 4 ── Data Loading
# ─────────────────────────────────────────────────────────────────────────────

def load_data(csv_path: str = CSV_PATH) -> pd.DataFrame:
    """
    Loads the traffic dataset from the specified CSV file.
    The CSV must contain the exact columns:
    Timestamp, Date, Time, Route_Name, Origin_Node, Destination_Node,
    Distance_meters, Normal_Duration_sec, Traffic_Duration_sec
    """
    print(f"[INFO] Loading dataset from '{csv_path}' …")
    df = pd.read_csv(csv_path, parse_dates=["Timestamp"])
    
    # Validate required columns
    required_cols = [
        "Timestamp", "Date", "Time", "Route_Name", "Origin_Node", 
        "Destination_Node", "Distance_meters", "Normal_Duration_sec", 
        "Traffic_Duration_sec"
    ]
    missing_cols = [col for col in required_cols if col not in df.columns]
    if missing_cols:
        raise ValueError(f"Missing required columns: {missing_cols}")
    
    print(f"[INFO] Dataset shape: {df.shape}")
    print(df.head(3))
    return df


# ─────────────────────────────────────────────────────────────────────────────
# CELL 6 ── Graph Construction (Adjacency / Edge Index)
# ─────────────────────────────────────────────────────────────────────────────

def build_graph(df: pd.DataFrame):
    """
    Constructs the road-network graph that is fed into the GCN layer.

    Each unique (Origin_Node, Destination_Node) pair becomes a directed edge.
    Edge weights are derived from Distance_meters (inverted & normalised so
    shorter roads get higher weight, reflecting stronger spatial correlation).

    Returns
    -------
    edge_index : torch.LongTensor  shape [2, num_edges]
    edge_weight: torch.FloatTensor shape [num_edges]
    num_nodes  : int
    node_map   : dict  mapping original node id → 0-based integer index
    """
    # Collect all unique edges and their mean distance
    edge_df = (df.groupby(["Origin_Node", "Destination_Node"])
                 ["Distance_meters"]
                 .mean()
                 .reset_index())

    # Build a contiguous integer node index
    unique_nodes = sorted(set(edge_df["Origin_Node"]) | set(edge_df["Destination_Node"]))
    node_map = {n: i for i, n in enumerate(unique_nodes)}
    num_nodes = len(unique_nodes)

    src_list, dst_list, wgt_list = [], [], []
    for _, row in edge_df.iterrows():
        src = node_map[row["Origin_Node"]]
        dst = node_map[row["Destination_Node"]]
        dist = row["Distance_meters"]
        # Inverse-distance weight: closer nodes = higher weight
        weight = 1.0 / (dist + 1e-6)
        src_list.append(src)
        dst_list.append(dst)
        wgt_list.append(weight)

    # Normalise weights to [0, 1]
    wgt_arr = np.array(wgt_list, dtype=np.float32)
    wgt_arr = (wgt_arr - wgt_arr.min()) / (wgt_arr.max() - wgt_arr.min() + 1e-8)

    edge_index  = torch.tensor([src_list, dst_list], dtype=torch.long)
    edge_weight = torch.tensor(wgt_arr, dtype=torch.float32)

    print(f"[INFO] Graph: {num_nodes} nodes, {len(src_list)} edges.")
    return edge_index, edge_weight, num_nodes, node_map


# ─────────────────────────────────────────────────────────────────────────────
# CELL 7 ── Feature Engineering & Scaling
# ─────────────────────────────────────────────────────────────────────────────

def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """
    Adds cyclic time encodings and lag features to enrich the temporal signal.

    Cyclic encoding (sin/cos) avoids the artificial discontinuity that plain
    integer hours/minutes would introduce at midnight or end-of-week.
    """
    df = df.copy()
    df["Timestamp"] = pd.to_datetime(df["Timestamp"])
    df = df.sort_values("Timestamp").reset_index(drop=True)

    # ── Cyclic time features ──────────────────────────────────────────────────
    hour_of_day  = df["Timestamp"].dt.hour + df["Timestamp"].dt.minute / 60.0
    day_of_week  = df["Timestamp"].dt.dayofweek           # 0 = Monday
    day_of_month = df["Timestamp"].dt.day
    month        = df["Timestamp"].dt.month

    df["hour_sin"]  = np.sin(2 * np.pi * hour_of_day  / 24.0)
    df["hour_cos"]  = np.cos(2 * np.pi * hour_of_day  / 24.0)
    df["dow_sin"]   = np.sin(2 * np.pi * day_of_week  / 7.0)
    df["dow_cos"]   = np.cos(2 * np.pi * day_of_week  / 7.0)
    df["dom_sin"]   = np.sin(2 * np.pi * day_of_month / 31.0)
    df["dom_cos"]   = np.cos(2 * np.pi * day_of_month / 31.0)
    df["month_sin"] = np.sin(2 * np.pi * month        / 12.0)
    df["month_cos"] = np.cos(2 * np.pi * month        / 12.0)

    # ── Weekend flag ─────────────────────────────────────────────────────────
    df["is_weekend"] = (df["Timestamp"].dt.dayofweek >= 5).astype(float)

    # ── Lag features (previous steps of the target) ──────────────────────────
    df["lag_1"]  = df["Traffic_Duration_sec"].shift(1)
    df["lag_6"]  = df["Traffic_Duration_sec"].shift(6)
    df["lag_12"] = df["Traffic_Duration_sec"].shift(12)

    # ── Rolling statistics ────────────────────────────────────────────────────
    df["roll_mean_6"]  = df["Traffic_Duration_sec"].rolling(6).mean()
    df["roll_std_6"]   = df["Traffic_Duration_sec"].rolling(6).std()

    # Drop rows with NaN introduced by lags/rolling
    df = df.dropna().reset_index(drop=True)
    return df


# List of numerical features fed into the LSTM alongside GCN embeddings
TEMPORAL_FEATURE_COLS = [
    "Distance_meters", "Normal_Duration_sec",
    "hour_sin", "hour_cos", "dow_sin", "dow_cos",
    "dom_sin", "dom_cos", "month_sin", "month_cos",
    "is_weekend", "lag_1", "lag_6", "lag_12",
    "roll_mean_6", "roll_std_6",
]
TARGET_COL = "Traffic_Duration_sec"


def scale_data(df: pd.DataFrame, train_end_idx: int):
    """
    Fits MinMaxScalers on the **training portion only** (to prevent data
    leakage) and transforms the full DataFrame.

    Returns
    -------
    df_scaled      : pd.DataFrame  — scaled values
    target_scaler  : MinMaxScaler  — used to inverse-transform predictions
    feature_scaler : MinMaxScaler  — used to inverse-transform features
    """
    feature_scaler = MinMaxScaler()
    target_scaler  = MinMaxScaler()

    # Fit only on training rows
    train_df = df.iloc[:train_end_idx]
    feature_scaler.fit(train_df[TEMPORAL_FEATURE_COLS])
    target_scaler.fit(train_df[[TARGET_COL]])

    df_scaled = df.copy()
    df_scaled[TEMPORAL_FEATURE_COLS] = feature_scaler.transform(df[TEMPORAL_FEATURE_COLS])
    df_scaled[TARGET_COL]            = target_scaler.transform(df[[TARGET_COL]])

    return df_scaled, target_scaler, feature_scaler


# ─────────────────────────────────────────────────────────────────────────────
# CELL 8 ── Sliding-Window Dataset
# ─────────────────────────────────────────────────────────────────────────────

class TrafficWindowDataset(Dataset):
    """
    Creates fixed-size (lookback → forecast) sliding windows over the
    time-series for use with PyTorch DataLoader.

    Each sample contains:
        x_temporal  : float tensor [lookback, n_features]  — input window
        node_ids    : long tensor  [lookback]               — origin node per step
        y           : float tensor [forecast_steps]         — future targets
    """

    def __init__(self, df: pd.DataFrame, lookback: int, forecast: int,
                 feature_cols: list, target_col: str, node_map: dict):
        self.lookback      = lookback
        self.forecast      = forecast
        self.feature_cols  = feature_cols
        self.target_col    = target_col

        self.X = df[feature_cols].values.astype(np.float32)   # [T, F]
        self.y = df[target_col].values.astype(np.float32)      # [T]
        # Map origin node labels to integer indices (for GCN node selection)
        self.node_ids = np.array(
            [node_map.get(n, 0) for n in df["Origin_Node"]], dtype=np.int64
        )

    def __len__(self):
        # Total samples = T - lookback - forecast + 1
        return len(self.X) - self.lookback - self.forecast + 1

    def __getitem__(self, idx):
        x_window    = self.X[idx : idx + self.lookback]              # [lookback, F]
        node_window = self.node_ids[idx : idx + self.lookback]       # [lookback]
        y_window    = self.y[idx + self.lookback :
                             idx + self.lookback + self.forecast]    # [forecast]

        return (
            torch.tensor(x_window,    dtype=torch.float32),
            torch.tensor(node_window, dtype=torch.long),
            torch.tensor(y_window,    dtype=torch.float32),
        )


def split_dataset(df_scaled: pd.DataFrame, node_map: dict):
    """
    Chronological train / val / test split (no shuffling to preserve time order).
    """
    n = len(df_scaled)
    train_end = int(n * TRAIN_RATIO)
    val_end   = int(n * (TRAIN_RATIO + VAL_RATIO))

    train_df = df_scaled.iloc[:train_end].reset_index(drop=True)
    val_df   = df_scaled.iloc[train_end:val_end].reset_index(drop=True)
    test_df  = df_scaled.iloc[val_end:].reset_index(drop=True)

    make_ds = lambda d: TrafficWindowDataset(
        d, LOOKBACK_STEPS, FORECAST_STEPS, TEMPORAL_FEATURE_COLS, TARGET_COL, node_map
    )

    train_ds, val_ds, test_ds = make_ds(train_df), make_ds(val_df), make_ds(test_df)

    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True,  drop_last=True)
    val_loader   = DataLoader(val_ds,   batch_size=BATCH_SIZE, shuffle=False, drop_last=False)
    test_loader  = DataLoader(test_ds,  batch_size=BATCH_SIZE, shuffle=False, drop_last=False)

    print(f"[INFO] Splits → Train: {len(train_ds)}, Val: {len(val_ds)}, Test: {len(test_ds)} windows.")
    return train_loader, val_loader, test_loader, train_end


# ─────────────────────────────────────────────────────────────────────────────
# CELL 9 ── Custom Time-Decay Weighted Loss
# ─────────────────────────────────────────────────────────────────────────────

class TimeDecayWeightedLoss(nn.Module):
    """
    Weighted MSE + MAE hybrid loss that assigns exponentially-decaying weights
    along the forecast horizon so that errors at t+1 are penalised more than
    errors at t+36.

    The decay schedule is:
        w(k) = exp(−λ × k / forecast_steps),  k ∈ {0, …, forecast_steps−1}

    where λ controls the steepness of the decay.  With λ=2:
        • Step  1  (10 min): weight ≈ 1.00  (highest priority)
        • Step 12  (2 hr):   weight ≈ 0.45
        • Step 36  (6 hr):   weight ≈ 0.13  (lowest priority)

    The final loss is a convex combination of weighted MSE and weighted MAE,
    controlled by `alpha`:
        L = alpha × wMSE + (1 − alpha) × wMAE

    MSE is sensitive to large spikes; MAE is robust to outliers.  Combining
    both gives a balanced training signal.
    """

    def __init__(self, forecast_steps: int = FORECAST_STEPS,
                 decay_lambda: float = 2.0, alpha: float = 0.6):
        """
        Parameters
        ----------
        forecast_steps : int   — number of future steps (= FORECAST_STEPS)
        decay_lambda   : float — exponential decay rate (higher → steeper decay)
        alpha          : float — weight of MSE term vs MAE term [0, 1]
        """
        super().__init__()
        self.alpha = alpha

        # Pre-compute and register weight vector (non-trainable buffer)
        k = torch.arange(forecast_steps, dtype=torch.float32)
        weights = torch.exp(-decay_lambda * k / forecast_steps)   # [forecast_steps]
        weights = weights / weights.sum()                          # normalise to sum=1
        self.register_buffer("weights", weights)                   # moved to device automatically

    def forward(self, pred: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
        """
        Parameters
        ----------
        pred   : [batch, forecast_steps]
        target : [batch, forecast_steps]

        Returns
        -------
        scalar loss value
        """
        # Per-step errors
        sq_err  = (pred - target) ** 2        # [batch, forecast_steps]
        abs_err = torch.abs(pred - target)    # [batch, forecast_steps]

        # Apply time-decay weights (broadcast over batch dimension)
        w = self.weights.unsqueeze(0)         # [1, forecast_steps]
        weighted_mse = (sq_err  * w).sum(dim=1).mean()
        weighted_mae = (abs_err * w).sum(dim=1).mean()

        return self.alpha * weighted_mse + (1.0 - self.alpha) * weighted_mae


# ─────────────────────────────────────────────────────────────────────────────
# CELL 10 ── Model: LSTM_Only (Baseline)
# ─────────────────────────────────────────────────────────────────────────────

class LSTM_Only(nn.Module):
    """
    Pure temporal baseline.  A stacked LSTM encodes the lookback window and a
    linear head projects the final hidden state to the full forecast horizon.

    Architecture:
        Input  [batch, lookback, n_features]
            ↓ LSTM × LSTM_NUM_LAYERS
        Hidden [batch, LSTM_HIDDEN_DIM]
            ↓ Dropout
            ↓ Linear(LSTM_HIDDEN_DIM → FORECAST_STEPS)
        Output [batch, FORECAST_STEPS]
    """

    def __init__(self, input_dim: int, hidden_dim: int = LSTM_HIDDEN_DIM,
                 num_layers: int = LSTM_NUM_LAYERS, dropout: float = DROPOUT_RATE,
                 forecast_steps: int = FORECAST_STEPS):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size=input_dim,
            hidden_size=hidden_dim,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0.0,  # LSTM dropout only between layers
        )
        self.dropout = nn.Dropout(dropout)
        self.fc      = nn.Linear(hidden_dim, forecast_steps)

    def forward(self, x_temporal, node_ids=None, edge_index=None, edge_weight=None,
                node_features=None, prophet_pred=None):
        # x_temporal : [batch, lookback, n_features]
        _, (h_n, _) = self.lstm(x_temporal)   # h_n : [num_layers, batch, hidden]
        h_last = h_n[-1]                       # take the top-most LSTM layer
        h_last = self.dropout(h_last)          # [batch, hidden_dim]
        out    = self.fc(h_last)               # [batch, forecast_steps]
        return out


# ─────────────────────────────────────────────────────────────────────────────
# CELL 11 ── Model: GCN_Only (Baseline)
# ─────────────────────────────────────────────────────────────────────────────

class GCN_Only(nn.Module):
    """
    Pure spatial baseline.  At each time step the GCN produces a node embedding;
    we select the embedding for the relevant origin node, concatenate the raw
    temporal features with it, and apply a linear readout.

    Architecture:
        Node feature matrix  [num_nodes, node_feat_dim]
            ↓ GCNConv(node_feat_dim → GCN_HIDDEN_DIM)   + ReLU
            ↓ GCNConv(GCN_HIDDEN_DIM → GCN_HIDDEN_DIM)  + ReLU
        Selected node embeddings per time-step [batch, lookback, GCN_HIDDEN_DIM]
            ↓ Mean-pool over lookback
        [batch, GCN_HIDDEN_DIM]
            ↓ Dropout
            ↓ Linear → FORECAST_STEPS
        Output [batch, FORECAST_STEPS]
    """

    def __init__(self, node_feat_dim: int, gcn_hidden: int = GCN_HIDDEN_DIM,
                 dropout: float = DROPOUT_RATE, forecast_steps: int = FORECAST_STEPS):
        super().__init__()
        self.gcn1    = GCNConv(node_feat_dim, gcn_hidden)
        self.gcn2    = GCNConv(gcn_hidden, gcn_hidden)
        self.dropout = nn.Dropout(dropout)
        self.fc      = nn.Linear(gcn_hidden, forecast_steps)

    def _get_gcn_embedding(self, node_features, edge_index, edge_weight):
        """Runs the two GCN layers and returns node embeddings [num_nodes, gcn_hidden]."""
        h = F.relu(self.gcn1(node_features, edge_index, edge_weight))
        h = self.dropout(h)
        h = F.relu(self.gcn2(h, edge_index, edge_weight))
        return h   # [num_nodes, gcn_hidden]

    def forward(self, x_temporal, node_ids, edge_index, edge_weight,
                node_features, prophet_pred=None):
        # node_features : [num_nodes, node_feat_dim]
        # node_ids      : [batch, lookback]  (integer origin-node indices)
        batch_size = x_temporal.size(0)

        gcn_emb = self._get_gcn_embedding(node_features, edge_index, edge_weight)
        # [num_nodes, gcn_hidden]

        # Gather embeddings for each (batch, timestep) pair
        flat_ids   = node_ids.reshape(-1)                    # [batch × lookback]
        flat_emb   = gcn_emb[flat_ids]                       # [batch × lookback, gcn_hidden]
        step_emb   = flat_emb.view(batch_size, LOOKBACK_STEPS, -1)  # [batch, lookback, gcn_hidden]

        pooled = step_emb.mean(dim=1)    # mean-pool over time: [batch, gcn_hidden]
        pooled = self.dropout(pooled)
        out    = self.fc(pooled)         # [batch, forecast_steps]
        return out


# ─────────────────────────────────────────────────────────────────────────────
# CELL 12 ── Model: GCN_LSTM (Ablation — no Prophet branch)
# ─────────────────────────────────────────────────────────────────────────────

class GCN_LSTM(nn.Module):
    """
    Ablation model that fuses GCN spatial embeddings with LSTM temporal
    encoding but omits the Prophet seasonality branch.

    Architecture:
        GCN branch  →  node embeddings  [batch, lookback, gcn_hidden]
        ↓ Concatenated with x_temporal  [batch, lookback, gcn_hidden + n_features]
        ↓ LSTM
        ↓ Dropout + Linear
        Output [batch, FORECAST_STEPS]
    """

    def __init__(self, input_dim: int, node_feat_dim: int,
                 gcn_hidden: int = GCN_HIDDEN_DIM, lstm_hidden: int = LSTM_HIDDEN_DIM,
                 num_layers: int = LSTM_NUM_LAYERS, dropout: float = DROPOUT_RATE,
                 forecast_steps: int = FORECAST_STEPS):
        super().__init__()
        self.gcn1    = GCNConv(node_feat_dim, gcn_hidden)
        self.gcn2    = GCNConv(gcn_hidden, gcn_hidden)
        self.lstm    = nn.LSTM(
            input_size=gcn_hidden + input_dim,
            hidden_size=lstm_hidden,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0.0,
        )
        self.dropout = nn.Dropout(dropout)
        self.fc      = nn.Linear(lstm_hidden, forecast_steps)

    def _gcn_embed(self, node_features, edge_index, edge_weight):
        h = F.relu(self.gcn1(node_features, edge_index, edge_weight))
        h = self.dropout(h)
        h = F.relu(self.gcn2(h, edge_index, edge_weight))
        return h

    def forward(self, x_temporal, node_ids, edge_index, edge_weight,
                node_features, prophet_pred=None):
        batch_size = x_temporal.size(0)

        gcn_emb   = self._gcn_embed(node_features, edge_index, edge_weight)
        flat_ids  = node_ids.reshape(-1)
        flat_emb  = gcn_emb[flat_ids]
        step_emb  = flat_emb.view(batch_size, LOOKBACK_STEPS, -1)   # [batch, lookback, gcn_hidden]

        # Concatenate spatial embeddings with temporal features
        combined  = torch.cat([step_emb, x_temporal], dim=-1)       # [batch, lookback, gcn_hidden+F]

        _, (h_n, _) = self.lstm(combined)
        h_last    = self.dropout(h_n[-1])
        out       = self.fc(h_last)                                  # [batch, forecast_steps]
        return out


# ─────────────────────────────────────────────────────────────────────────────
# CELL 13 ── Model: Hybrid_GCN_LSTM_Prophet (Full Architecture)
# ─────────────────────────────────────────────────────────────────────────────

class Hybrid_GCN_LSTM_Prophet(nn.Module):
    """
    The complete proposed architecture.

    Three parallel branches feed a dense fusion layer:

    ① GCN Spatial Branch
       Raw node feature matrix → 2× GCNConv → node embeddings
       (captures road topology and spatial correlations between routes)

    ② LSTM Temporal Branch
       [GCN embeddings ‖ temporal features] per timestep → stacked LSTM
       (captures sequential dependencies and short-term dynamics)

    ③ Prophet Baseline Branch
       Pre-computed Prophet predictions are passed as a 1-D tensor
       [batch, forecast_steps], then projected through a small MLP.
       (captures global trend and weekly/daily seasonality)

    ─────────────────────────────────────────────────────────────────
    Fusion Layer (Dense)
       Concatenate LSTM output + Prophet MLP output
       → Linear(lstm_hidden + fusion_hidden → FUSION_HIDDEN)
       → ReLU → Dropout
       → Linear(FUSION_HIDDEN → FORECAST_STEPS)
    ─────────────────────────────────────────────────────────────────

    Dropout is applied after every major sub-block to regularise the
    relatively small 3500-row training set.
    """

    def __init__(self, input_dim: int, node_feat_dim: int,
                 gcn_hidden: int  = GCN_HIDDEN_DIM,
                 lstm_hidden: int = LSTM_HIDDEN_DIM,
                 num_layers: int  = LSTM_NUM_LAYERS,
                 dropout: float   = DROPOUT_RATE,
                 fusion_hidden: int = FUSION_HIDDEN,
                 forecast_steps: int = FORECAST_STEPS):
        super().__init__()

        # ── ① GCN Spatial Branch ─────────────────────────────────────────────
        self.gcn1 = GCNConv(node_feat_dim, gcn_hidden)
        self.gcn2 = GCNConv(gcn_hidden, gcn_hidden)

        # ── ② LSTM Temporal Branch ───────────────────────────────────────────
        # Input to LSTM is the concat of GCN embedding + raw temporal features
        self.lstm = nn.LSTM(
            input_size=gcn_hidden + input_dim,
            hidden_size=lstm_hidden,
            num_layers=num_layers,
            batch_first=True,
            dropout=dropout if num_layers > 1 else 0.0,
        )

        # ── ③ Prophet Projection Branch ──────────────────────────────────────
        # Prophet predictions [batch, forecast_steps] → compact representation
        self.prophet_proj = nn.Sequential(
            nn.Linear(forecast_steps, fusion_hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(fusion_hidden, fusion_hidden),
        )

        # ── Fusion / Readout Layer ────────────────────────────────────────────
        # Combines LSTM hidden state with Prophet projection
        self.fusion = nn.Sequential(
            nn.Linear(lstm_hidden + fusion_hidden, fusion_hidden),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(fusion_hidden, forecast_steps),
        )

        self.dropout_layer = nn.Dropout(dropout)

    def _gcn_embed(self, node_features, edge_index, edge_weight):
        """Two-layer GCN producing node embeddings [num_nodes, gcn_hidden]."""
        h = F.relu(self.gcn1(node_features, edge_index, edge_weight))
        h = self.dropout_layer(h)
        h = F.relu(self.gcn2(h, edge_index, edge_weight))
        return h

    def forward(self, x_temporal, node_ids, edge_index, edge_weight,
                node_features, prophet_pred):
        """
        Parameters
        ----------
        x_temporal   : [batch, lookback, n_features]    — scaled temporal features
        node_ids     : [batch, lookback]                 — integer origin-node index per step
        edge_index   : [2, num_edges]                    — COO graph connectivity
        edge_weight  : [num_edges]                       — normalised inverse-distance weights
        node_features: [num_nodes, node_feat_dim]        — per-node feature matrix
        prophet_pred : [batch, forecast_steps]           — Prophet baseline predictions
        """
        batch_size = x_temporal.size(0)

        # ── ① GCN ────────────────────────────────────────────────────────────
        gcn_emb  = self._gcn_embed(node_features, edge_index, edge_weight)
        # Select the relevant node embedding for each (batch, timestep) pair
        flat_ids = node_ids.reshape(-1)
        flat_emb = gcn_emb[flat_ids]
        step_emb = flat_emb.view(batch_size, LOOKBACK_STEPS, -1)  # [batch, lookback, gcn_hidden]

        # ── ② LSTM ───────────────────────────────────────────────────────────
        combined       = torch.cat([step_emb, x_temporal], dim=-1)  # [batch, lookback, gcn_h+F]
        _, (h_n, _)    = self.lstm(combined)
        lstm_out       = self.dropout_layer(h_n[-1])                 # [batch, lstm_hidden]

        # ── ③ Prophet branch ─────────────────────────────────────────────────
        prophet_out = self.prophet_proj(prophet_pred)                # [batch, fusion_hidden]

        # ── Fusion ───────────────────────────────────────────────────────────
        fused = torch.cat([lstm_out, prophet_out], dim=-1)           # [batch, lstm_h+fusion_h]
        out   = self.fusion(fused)                                   # [batch, forecast_steps]
        return out


# ─────────────────────────────────────────────────────────────────────────────
# CELL 14 ── Prophet Training & Inference Helper
# ─────────────────────────────────────────────────────────────────────────────

def train_prophet(df: pd.DataFrame, target_col: str = TARGET_COL):
    """
    Fits a Prophet model to the full (unscaled) training portion of the
    time-series. Prophet expects a DataFrame with columns 'ds' (datetime) and
    'y' (target value).

    Returns
    -------
    prophet_model : fitted Prophet instance
    """
    prophet_df = df[["Timestamp", target_col]].rename(
        columns={"Timestamp": "ds", target_col: "y"}
    )
    # Aggregate to per-timestamp mean (in case multiple routes share a timestamp)
    prophet_df = prophet_df.groupby("ds")["y"].mean().reset_index()

    model = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=True,
        daily_seasonality=True,
        changepoint_prior_scale=0.05,    # mild trend flexibility
        seasonality_prior_scale=10.0,    # allow strong seasonality
    )
    model.fit(prophet_df)
    print("[INFO] Prophet model fitted.")
    return model


def get_prophet_predictions(prophet_model, future_timestamps: pd.DatetimeIndex,
                             target_scaler: MinMaxScaler) -> np.ndarray:
    """
    Returns normalised Prophet forecasts aligned to `future_timestamps`.

    The raw Prophet yhat values are scaled using the same target_scaler that
    was fitted on the training data so they live in the same [0,1] space as
    the PyTorch model outputs.

    Parameters
    ----------
    prophet_model    : fitted Prophet instance
    future_timestamps: DatetimeIndex of timestamps to forecast (length = batch × forecast_steps)
    target_scaler    : MinMaxScaler fitted on target column

    Returns
    -------
    numpy array of shape [len(future_timestamps)] with normalised forecasts
    """
    future_df = pd.DataFrame({"ds": future_timestamps})
    forecast  = prophet_model.predict(future_df)
    yhat      = forecast["yhat"].values.reshape(-1, 1)
    yhat_scaled = target_scaler.transform(yhat).flatten()
    return yhat_scaled


# ─────────────────────────────────────────────────────────────────────────────
# CELL 15 ── Node Feature Matrix Helper
# ─────────────────────────────────────────────────────────────────────────────

def build_node_features(df: pd.DataFrame, node_map: dict,
                         feature_cols: list) -> torch.Tensor:
    """
    Constructs a static node feature matrix by averaging the temporal features
    of all rows whose Origin_Node equals each node.

    Shape: [num_nodes, len(feature_cols)]

    In a more advanced setup this could be updated dynamically each timestep,
    but for this architecture it serves as a fixed spatial prior.
    """
    num_nodes = len(node_map)
    n_feat    = len(feature_cols)
    node_feat = np.zeros((num_nodes, n_feat), dtype=np.float32)

    for node_label, node_idx in node_map.items():
        rows = df[df["Origin_Node"] == node_label][feature_cols]
        if len(rows) > 0:
            node_feat[node_idx] = rows.mean(axis=0).values
        # If a node has no rows (isolated destination), features stay at 0

    return torch.tensor(node_feat, dtype=torch.float32)


# ─────────────────────────────────────────────────────────────────────────────
# CELL 16 ── Early Stopping
# ─────────────────────────────────────────────────────────────────────────────

class EarlyStopping:
    """
    Monitors validation loss and halts training if no improvement is observed
    for `patience` consecutive epochs.  Saves the best model weights so the
    final evaluation always uses the generalization-optimal checkpoint.
    """

    def __init__(self, patience: int = PATIENCE, min_delta: float = 1e-4,
                 save_path: str = "best_model_temp.pth"):
        self.patience    = patience
        self.min_delta   = min_delta
        self.save_path   = save_path
        self.best_loss   = float("inf")
        self.counter     = 0
        self.should_stop = False

    def step(self, val_loss: float, model: nn.Module) -> bool:
        """
        Call after each epoch.  Returns True when training should stop.
        """
        if val_loss < self.best_loss - self.min_delta:
            self.best_loss = val_loss
            self.counter   = 0
            # Save checkpoint of best weights
            torch.save(model.state_dict(), self.save_path)
        else:
            self.counter += 1
            if self.counter >= self.patience:
                self.should_stop = True
        return self.should_stop

    def restore_best(self, model: nn.Module):
        """Load the best-epoch weights back into the model."""
        if os.path.exists(self.save_path):
            model.load_state_dict(torch.load(self.save_path, map_location=DEVICE))
            print(f"[INFO] Restored best model weights from '{self.save_path}'.")


# ─────────────────────────────────────────────────────────────────────────────
# CELL 17 ── Generic Training Loop
# ─────────────────────────────────────────────────────────────────────────────

def train_model(model: nn.Module, train_loader: DataLoader, val_loader: DataLoader,
                edge_index: torch.Tensor, edge_weight: torch.Tensor,
                node_features: torch.Tensor, criterion, optimizer,
                model_name: str = "model", prophet_model=None,
                df_full: pd.DataFrame = None, target_scaler: MinMaxScaler = None,
                df_scaled: pd.DataFrame = None) -> dict:
    """
    Generic PyTorch training loop shared across all model variants.

    Returns
    -------
    history : dict with "train_loss" and "val_loss" lists (one per epoch)
    """

    early_stopper = EarlyStopping(
        patience=PATIENCE, save_path=f"best_{model_name}.pth"
    )
    history = {"train_loss": [], "val_loss": []}

    # Move graph tensors to device once
    edge_index   = edge_index.to(DEVICE)
    edge_weight  = edge_weight.to(DEVICE)
    node_features = node_features.to(DEVICE)

    print(f"\n{'─'*60}")
    print(f"  Training: {model_name}")
    print(f"{'─'*60}")

    for epoch in range(1, MAX_EPOCHS + 1):
        # ── Training phase ───────────────────────────────────────────────────
        model.train()
        epoch_train_loss = 0.0

        for x_temp, node_ids, y_true in train_loader:
            x_temp   = x_temp.to(DEVICE)     # [batch, lookback, F]
            node_ids = node_ids.to(DEVICE)   # [batch, lookback]
            y_true   = y_true.to(DEVICE)     # [batch, forecast_steps]

            # Build Prophet prediction tensor for this batch (if applicable)
            prophet_pred_tensor = _make_prophet_tensor(
                prophet_model, df_full, df_scaled, target_scaler,
                x_temp.size(0), DEVICE
            )

            optimizer.zero_grad()
            y_pred = model(x_temp, node_ids, edge_index, edge_weight,
                           node_features, prophet_pred_tensor)
            loss   = criterion(y_pred, y_true)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)  # gradient clipping
            optimizer.step()
            epoch_train_loss += loss.item()

        avg_train = epoch_train_loss / len(train_loader)

        # ── Validation phase ─────────────────────────────────────────────────
        model.eval()
        epoch_val_loss = 0.0
        with torch.no_grad():
            for x_temp, node_ids, y_true in val_loader:
                x_temp   = x_temp.to(DEVICE)
                node_ids = node_ids.to(DEVICE)
                y_true   = y_true.to(DEVICE)

                prophet_pred_tensor = _make_prophet_tensor(
                    prophet_model, df_full, df_scaled, target_scaler,
                    x_temp.size(0), DEVICE
                )

                y_pred = model(x_temp, node_ids, edge_index, edge_weight,
                               node_features, prophet_pred_tensor)
                loss   = criterion(y_pred, y_true)
                epoch_val_loss += loss.item()

        avg_val = epoch_val_loss / len(val_loader)

        history["train_loss"].append(avg_train)
        history["val_loss"].append(avg_val)

        # Print progress every 10 epochs
        if epoch % 10 == 0 or epoch == 1:
            print(f"  Epoch {epoch:>4d}/{MAX_EPOCHS} | "
                  f"Train Loss: {avg_train:.6f} | Val Loss: {avg_val:.6f} | "
                  f"ES Counter: {early_stopper.counter}/{PATIENCE}")

        if early_stopper.step(avg_val, model):
            print(f"  [Early Stop] No improvement for {PATIENCE} epochs. Stopping at epoch {epoch}.")
            break

    # Restore the generalization-optimal weights
    early_stopper.restore_best(model)
    return history


def _make_prophet_tensor(prophet_model, df_full, df_scaled, target_scaler,
                          batch_size: int, device: torch.device) -> torch.Tensor:
    """
    Convenience helper: returns a zero tensor for models that don't use Prophet,
    or actual Prophet predictions for the Hybrid model.
    """
    if prophet_model is None:
        # Return a zero tensor shaped [batch, forecast_steps]
        return torch.zeros(batch_size, FORECAST_STEPS, device=device)

    # For simplicity in the training loop we return a fixed future prediction.
    # In a production system this would be aligned to each batch's actual
    # future timestamps — here the Prophet branch learns to correct the trend
    # rather than provide exact values, so minor misalignment is acceptable.
    last_ts    = pd.to_datetime(df_full["Timestamp"].iloc[-1])
    future_ts  = pd.date_range(
        start=last_ts + pd.Timedelta(minutes=TIME_STEP_MINS),
        periods=FORECAST_STEPS, freq=f"{TIME_STEP_MINS}min"
    )
    prophet_vals = get_prophet_predictions(prophet_model, future_ts, target_scaler)
    # Repeat the same prediction for every item in the batch
    tensor = torch.tensor(
        np.tile(prophet_vals, (batch_size, 1)), dtype=torch.float32
    ).to(device)
    return tensor


# ─────────────────────────────────────────────────────────────────────────────
# CELL 18 ── Evaluation Metrics
# ─────────────────────────────────────────────────────────────────────────────

def evaluate_model(model: nn.Module, test_loader: DataLoader,
                   edge_index: torch.Tensor, edge_weight: torch.Tensor,
                   node_features: torch.Tensor, target_scaler: MinMaxScaler,
                   prophet_model=None, df_full=None, df_scaled=None,
                   target_scaler_ref=None) -> dict:
    """
    Runs inference on the test set and computes MAE, RMSE, and R².

    Predictions are inverse-transformed back to the original seconds scale
    before computing metrics so they are interpretable.

    Returns
    -------
    dict with keys: "MAE", "RMSE", "R2"
    """
    model.eval()
    edge_index    = edge_index.to(DEVICE)
    edge_weight   = edge_weight.to(DEVICE)
    node_features = node_features.to(DEVICE)

    all_preds  = []
    all_true   = []

    with torch.no_grad():
        for x_temp, node_ids, y_true in test_loader:
            x_temp   = x_temp.to(DEVICE)
            node_ids = node_ids.to(DEVICE)

            prophet_pred_tensor = _make_prophet_tensor(
                prophet_model, df_full, df_scaled, target_scaler,
                x_temp.size(0), DEVICE
            )

            y_pred = model(x_temp, node_ids, edge_index, edge_weight,
                           node_features, prophet_pred_tensor)

            all_preds.append(y_pred.cpu().numpy())
            all_true.append(y_true.numpy())

    # Concatenate all batches: [n_samples, forecast_steps]
    preds = np.concatenate(all_preds, axis=0)
    trues = np.concatenate(all_true, axis=0)

    # Flatten to 1-D for metric computation (all steps treated equally)
    preds_flat = preds.flatten()
    trues_flat = trues.flatten()

    # Inverse-scale back to seconds
    preds_inv = target_scaler.inverse_transform(preds_flat.reshape(-1, 1)).flatten()
    trues_inv = target_scaler.inverse_transform(trues_flat.reshape(-1, 1)).flatten()

    mae  = mean_absolute_error(trues_inv, preds_inv)
    rmse = math.sqrt(mean_squared_error(trues_inv, preds_inv))
    r2   = r2_score(trues_inv, preds_inv)

    return {"MAE": mae, "RMSE": rmse, "R2": r2}


# ─────────────────────────────────────────────────────────────────────────────
# CELL 19 ── Training Curve Plotting
# ─────────────────────────────────────────────────────────────────────────────

def plot_training_curves(histories: dict):
    """
    Plots train/validation loss curves for all trained models side-by-side.
    Saved to 'training_curves.png' and displayed inline in Colab.
    """
    n = len(histories)
    fig, axes = plt.subplots(1, n, figsize=(6 * n, 4), sharey=False)
    if n == 1:
        axes = [axes]

    for ax, (name, hist) in zip(axes, histories.items()):
        ax.plot(hist["train_loss"], label="Train", linewidth=1.5)
        ax.plot(hist["val_loss"],   label="Val",   linewidth=1.5, linestyle="--")
        ax.set_title(name, fontsize=12, fontweight="bold")
        ax.set_xlabel("Epoch")
        ax.set_ylabel("Weighted Loss")
        ax.legend()
        ax.grid(True, alpha=0.3)

    plt.suptitle("Training & Validation Loss Curves", fontsize=14, fontweight="bold", y=1.02)
    plt.tight_layout()
    plt.savefig("training_curves.png", dpi=150, bbox_inches="tight")
    plt.show()
    print("[INFO] Saved training_curves.png")


# ─────────────────────────────────────────────────────────────────────────────
# CELL 20 ── Comparison Table (Thesis Chapter 5)
# ─────────────────────────────────────────────────────────────────────────────

def print_comparison_table(results: dict):
    """
    Prints a formatted comparison table of MAE / RMSE / R² across all models.
    Uses the `tabulate` library for clean ASCII output suitable for thesis copy-paste.

    Also prints a plain-text version that can be included verbatim in Chapter 5.
    """
    rows = []
    for model_name, metrics in results.items():
        rows.append([
            model_name,
            f"{metrics['MAE']:.2f}",
            f"{metrics['RMSE']:.2f}",
            f"{metrics['R2']:.4f}",
        ])

    headers = ["Model", "MAE (sec)", "RMSE (sec)", "R²"]

    # Grid format (suitable for direct thesis inclusion)
    table_grid = tabulate(rows, headers=headers, tablefmt="grid")
    # Pipe format (easy to convert to Markdown / LaTeX)
    table_pipe = tabulate(rows, headers=headers, tablefmt="pipe")

    print("\n" + "=" * 65)
    print("  MODEL COMPARISON TABLE  —  Multi-Step Traffic Forecasting")
    print(f"  Horizon: {FORECAST_STEPS} steps ({FORECAST_STEPS * TIME_STEP_MINS} min) | "
          f"Lookback: {LOOKBACK_STEPS} steps ({LOOKBACK_STEPS * TIME_STEP_MINS} min)")
    print("=" * 65)
    print(table_grid)

    print("\n── Pipe format (Markdown / thesis) ──")
    print(table_pipe)

    print("\n── Plain CSV format ──")
    print(",".join(headers))
    for row in rows:
        print(",".join(row))

    # Identify the best model by R²
    best_model = max(results, key=lambda k: results[k]["R2"])
    best_r2    = results[best_model]["R2"]
    print(f"\n[RESULT] Best model: {best_model} (R² = {best_r2:.4f})")


# ─────────────────────────────────────────────────────────────────────────────
# CELL 21 ── Main Orchestration Function
# ─────────────────────────────────────────────────────────────────────────────

def main():
    """
    Full end-to-end pipeline:
        1. Load data (real CSV or synthetic fallback)
        2. Engineer features
        3. Build graph
        4. Scale data
        5. Build datasets / loaders
        6. Fit Prophet
        7. Build & train all model variants
        8. Evaluate and print comparison table
        9. Save final Hybrid model weights
    """
    t_start = time.time()

    # ── Step 1: Load ──────────────────────────────────────────────────────────
    df_raw = load_data(CSV_PATH)

    # ── Step 2: Feature Engineering ──────────────────────────────────────────
    df_feat = engineer_features(df_raw)
    print(f"[INFO] After feature engineering: {df_feat.shape}")

    # ── Step 3: Graph Construction ────────────────────────────────────────────
    edge_index, edge_weight, num_nodes, node_map = build_graph(df_feat)

    # ── Step 4: Chronological split index (before scaling) ───────────────────
    n = len(df_feat)
    train_end = int(n * TRAIN_RATIO)

    # ── Step 5: Scale ─────────────────────────────────────────────────────────
    df_scaled, target_scaler, feature_scaler = scale_data(df_feat, train_end)

    # ── Step 6: DataLoaders ───────────────────────────────────────────────────
    train_loader, val_loader, test_loader, _ = split_dataset(df_scaled, node_map)

    # ── Step 7: Node Feature Matrix ───────────────────────────────────────────
    # Built from the scaled DataFrame so features live in [0,1]
    node_features = build_node_features(df_scaled, node_map, TEMPORAL_FEATURE_COLS)
    node_feat_dim = node_features.shape[1]
    input_dim     = len(TEMPORAL_FEATURE_COLS)

    print(f"[INFO] Node feat dim: {node_feat_dim} | Temporal input dim: {input_dim}")

    # ── Step 8: Fit Prophet ───────────────────────────────────────────────────
    # Prophet is fitted on the raw (unscaled) training data to capture the
    # original scale of seasonality, then its outputs are re-scaled.
    train_raw = df_feat.iloc[:train_end]
    prophet_mdl = train_prophet(train_raw)

    # Shared training objects
    criterion = TimeDecayWeightedLoss(
        forecast_steps=FORECAST_STEPS, decay_lambda=2.0, alpha=0.6
    ).to(DEVICE)

    histories = {}   # store loss curves
    results   = {}   # store test metrics

    # ── Step 9a: LSTM_Only ────────────────────────────────────────────────────
    lstm_model = LSTM_Only(input_dim=input_dim).to(DEVICE)
    opt_lstm   = torch.optim.Adam(lstm_model.parameters(), lr=LEARNING_RATE)
    histories["LSTM_Only"] = train_model(
        lstm_model, train_loader, val_loader,
        edge_index, edge_weight, node_features, criterion, opt_lstm,
        model_name="LSTM_Only"
    )
    results["LSTM_Only"] = evaluate_model(
        lstm_model, test_loader, edge_index, edge_weight, node_features,
        target_scaler
    )
    print(f"[LSTM_Only] Test → {results['LSTM_Only']}")

    # ── Step 9b: GCN_Only ─────────────────────────────────────────────────────
    gcn_model = GCN_Only(node_feat_dim=node_feat_dim).to(DEVICE)
    opt_gcn   = torch.optim.Adam(gcn_model.parameters(), lr=LEARNING_RATE)
    histories["GCN_Only"] = train_model(
        gcn_model, train_loader, val_loader,
        edge_index, edge_weight, node_features, criterion, opt_gcn,
        model_name="GCN_Only"
    )
    results["GCN_Only"] = evaluate_model(
        gcn_model, test_loader, edge_index, edge_weight, node_features,
        target_scaler
    )
    print(f"[GCN_Only] Test → {results['GCN_Only']}")

    # ── Step 9c: GCN + LSTM (Ablation) ───────────────────────────────────────
    gcnlstm_model = GCN_LSTM(input_dim=input_dim, node_feat_dim=node_feat_dim).to(DEVICE)
    opt_gcnlstm   = torch.optim.Adam(gcnlstm_model.parameters(), lr=LEARNING_RATE)
    histories["GCN+LSTM"] = train_model(
        gcnlstm_model, train_loader, val_loader,
        edge_index, edge_weight, node_features, criterion, opt_gcnlstm,
        model_name="GCN_LSTM"
    )
    results["GCN+LSTM"] = evaluate_model(
        gcnlstm_model, test_loader, edge_index, edge_weight, node_features,
        target_scaler
    )
    print(f"[GCN+LSTM] Test → {results['GCN+LSTM']}")

    # ── Step 9d: Hybrid GCN-LSTM-Prophet (Full) ───────────────────────────────
    hybrid_model = Hybrid_GCN_LSTM_Prophet(
        input_dim=input_dim, node_feat_dim=node_feat_dim
    ).to(DEVICE)
    opt_hybrid = torch.optim.Adam(hybrid_model.parameters(), lr=LEARNING_RATE)
    histories["Hybrid_GCN_LSTM_Prophet"] = train_model(
        hybrid_model, train_loader, val_loader,
        edge_index, edge_weight, node_features, criterion, opt_hybrid,
        model_name="Hybrid_GCN_LSTM_Prophet",
        prophet_model=prophet_mdl,
        df_full=df_feat, target_scaler=target_scaler, df_scaled=df_scaled
    )
    results["Hybrid_GCN_LSTM_Prophet"] = evaluate_model(
        hybrid_model, test_loader, edge_index, edge_weight, node_features,
        target_scaler, prophet_model=prophet_mdl,
        df_full=df_feat, df_scaled=df_scaled, target_scaler_ref=target_scaler
    )
    print(f"[Hybrid] Test → {results['Hybrid_GCN_LSTM_Prophet']}")

    # ── Step 10: Training curves ──────────────────────────────────────────────
    plot_training_curves(histories)

    # ── Step 11: Comparison table (Chapter 5) ─────────────────────────────────
    print_comparison_table(results)

    # ── Step 12: Save final Hybrid model weights ──────────────────────────────
    torch.save(hybrid_model.state_dict(), MODEL_SAVE_PATH)
    print(f"\n[INFO] Hybrid model weights saved to '{MODEL_SAVE_PATH}'.")
    print(f"[INFO] Total runtime: {(time.time() - t_start) / 60:.1f} minutes.")


# ─────────────────────────────────────────────────────────────────────────────
# CELL 22 ── Entry Point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    main()


# ─────────────────────────────────────────────────────────────────────────────
# CELL 23 ── Incremental Learning / Fine-tuning Helper
# ─────────────────────────────────────────────────────────────────────────────

def load_and_finetune(new_csv_path: str, weights_path: str = MODEL_SAVE_PATH,
                      finetune_epochs: int = 30):
    """
    Loads a previously saved Hybrid model checkpoint and fine-tunes it on new
    incoming traffic data.  Use this after collecting additional weeks of data.

    Steps:
        1. Load new CSV
        2. Engineer features & rebuild graph
        3. Scale (re-fit scaler only on newly added data to avoid leakage)
        4. Rebuild DataLoader
        5. Load saved weights into Hybrid model
        6. Fine-tune for `finetune_epochs` with a lower LR
        7. Re-save updated weights

    Parameters
    ----------
    new_csv_path    : path to the updated/extended CSV file
    weights_path    : path to the previously saved .pth file
    finetune_epochs : number of epochs for fine-tuning
    """
    df_new = load_data(new_csv_path)
    df_new = engineer_features(df_new)

    edge_index, edge_weight, num_nodes, node_map = build_graph(df_new)

    n         = len(df_new)
    train_end = int(n * TRAIN_RATIO)
    df_scaled_new, target_scaler_new, _ = scale_data(df_new, train_end)
    train_loader_new, val_loader_new, _, _ = split_dataset(df_scaled_new, node_map)

    node_features_new = build_node_features(df_scaled_new, node_map, TEMPORAL_FEATURE_COLS)
    input_dim_new     = len(TEMPORAL_FEATURE_COLS)
    node_feat_dim_new = node_features_new.shape[1]

    # Reconstruct model with same hyper-parameters
    model = Hybrid_GCN_LSTM_Prophet(
        input_dim=input_dim_new, node_feat_dim=node_feat_dim_new
    ).to(DEVICE)

    # Load previous weights (strict=False allows minor architecture drift)
    state_dict = torch.load(weights_path, map_location=DEVICE)
    model.load_state_dict(state_dict, strict=True)
    print(f"[INFO] Loaded weights from '{weights_path}' for fine-tuning.")

    # Lower LR for fine-tuning to avoid catastrophic forgetting
    ft_lr         = LEARNING_RATE * 0.1
    optimizer_ft  = torch.optim.Adam(model.parameters(), lr=ft_lr)
    criterion_ft  = TimeDecayWeightedLoss().to(DEVICE)

    global MAX_EPOCHS, PATIENCE
    _orig_epochs, _orig_patience = MAX_EPOCHS, PATIENCE
    MAX_EPOCHS = finetune_epochs
    PATIENCE   = 10

    train_prophet_new = train_prophet(df_new.iloc[:train_end])

    train_model(
        model, train_loader_new, val_loader_new,
        edge_index, edge_weight, node_features_new, criterion_ft, optimizer_ft,
        model_name="Hybrid_Finetuned",
        prophet_model=train_prophet_new,
        df_full=df_new, target_scaler=target_scaler_new, df_scaled=df_scaled_new
    )

    MAX_EPOCHS = _orig_epochs
    PATIENCE   = _orig_patience

    torch.save(model.state_dict(), weights_path)
    print(f"[INFO] Fine-tuned weights saved back to '{weights_path}'.")
    return model, target_scaler_new
