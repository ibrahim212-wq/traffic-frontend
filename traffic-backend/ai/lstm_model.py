import logging
from typing import List, Tuple

import torch
import torch.nn as nn

logger = logging.getLogger(__name__)


class TrafficLSTM(nn.Module):
    """
    2-layer LSTM for time-series vehicle arrival rate forecasting.

    Input  : sequence of shape [batch, seq_len, input_size]
    Output : next-step prediction of shape [batch, output_size]
    """

    def __init__(self, input_size: int, hidden_size: int, num_layers: int, output_size: int) -> None:
        super().__init__()
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        self.lstm = nn.LSTM(
            input_size=input_size,
            hidden_size=hidden_size,
            num_layers=num_layers,
            batch_first=True,
            dropout=0.2 if num_layers > 1 else 0.0,
        )
        self.fc = nn.Linear(hidden_size, output_size)

    def forward(
        self,
        x: torch.Tensor,
        hidden: Tuple[torch.Tensor, torch.Tensor],
    ) -> Tuple[torch.Tensor, Tuple[torch.Tensor, torch.Tensor]]:
        out, hidden = self.lstm(x, hidden)
        return self.fc(out[:, -1, :]), hidden  # last time-step → linear head

    def init_hidden(self, batch_size: int) -> Tuple[torch.Tensor, torch.Tensor]:
        """Return zero-initialised (h_0, c_0) tensors."""
        h0 = torch.zeros(self.num_layers, batch_size, self.hidden_size)
        c0 = torch.zeros(self.num_layers, batch_size, self.hidden_size)
        return h0, c0


def prepare_sequences(
    series: List[float],
    seq_len: int = 10,
) -> Tuple[torch.Tensor, torch.Tensor]:
    """
    Slide a window of length seq_len over a 1-D series.

    Returns
    -------
    X : Tensor of shape [N, seq_len, 1]
    y : Tensor of shape [N, 1]
    """
    if len(series) <= seq_len:
        return torch.zeros(0, seq_len, 1), torch.zeros(0, 1)

    X, y = [], []
    for i in range(len(series) - seq_len):
        X.append(series[i : i + seq_len])
        y.append(series[i + seq_len])

    return (
        torch.tensor(X, dtype=torch.float).unsqueeze(-1),   # [N, seq_len, 1]
        torch.tensor(y, dtype=torch.float).unsqueeze(-1),   # [N, 1]
    )


def train_lstm(
    model: TrafficLSTM,
    X: torch.Tensor,
    y: torch.Tensor,
    epochs: int = 50,
) -> None:
    """Training loop for the LSTM model."""
    if X.shape[0] == 0:
        logger.warning("[LSTM] Empty training set — skipping training.")
        return

    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
    criterion = nn.MSELoss()
    model.train()

    for epoch in range(epochs):
        hidden = model.init_hidden(X.size(0))
        optimizer.zero_grad()
        output, _ = model(X, hidden)
        loss = criterion(output, y)
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        if (epoch + 1) % 10 == 0:
            logger.debug("[LSTM] epoch %d/%d  loss=%.4f", epoch + 1, epochs, loss.item())


def predict_lstm(model: TrafficLSTM, sequence: torch.Tensor) -> torch.Tensor:
    """
    Run single-step inference.

    Parameters
    ----------
    sequence : Tensor of shape [1, seq_len, input_size]

    Returns
    -------
    Tensor of shape [1, output_size]
    """
    model.eval()
    with torch.no_grad():
        hidden = model.init_hidden(1)
        output, _ = model(sequence, hidden)
    return output
