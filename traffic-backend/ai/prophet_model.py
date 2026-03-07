import logging
import os
from typing import Optional

import pandas as pd
from prophet import Prophet

logger = logging.getLogger(__name__)


def build_prophet_dataframe(timestamps: list, values: list) -> pd.DataFrame:
    """
    Build a Prophet-compatible DataFrame with columns [ds, y].

    Parameters
    ----------
    timestamps : list of Unix epoch floats
    values     : list of numeric vehicle counts
    """
    return pd.DataFrame({
        "ds": pd.to_datetime(timestamps, unit="s", utc=True).tz_localize(None),
        "y": values,
    })


def train_prophet(df: pd.DataFrame) -> Prophet:
    """Fit a Prophet model on the provided time-series DataFrame."""
    model = Prophet(
        changepoint_prior_scale=0.05,
        seasonality_mode="additive",
        daily_seasonality=True,
        weekly_seasonality=False,
        interval_width=0.80,
    )
    model.fit(df)
    logger.info("[Prophet] Model fitted on %d observations.", len(df))
    return model


def forecast_prophet(
    model: Prophet,
    periods: int = 1800,
    freq: str = "S",
) -> pd.DataFrame:
    """
    Generate a future forecast for `periods` steps ahead.

    Parameters
    ----------
    periods : number of future steps (default 1800 = 30 minutes at 1-second freq)
    freq    : pandas frequency string (default "S" = seconds)
    """
    future = model.make_future_dataframe(periods=periods, freq=freq, include_history=False)
    return model.predict(future)


def extract_forecast_values(forecast: pd.DataFrame) -> dict:
    """Extract yhat, yhat_lower, yhat_upper from the last row of a forecast DataFrame."""
    if forecast.empty:
        return {"yhat": 0.0, "yhat_lower": 0.0, "yhat_upper": 0.0}
    last = forecast.iloc[-1]
    return {
        "yhat": round(float(last["yhat"]), 2),
        "yhat_lower": round(float(last["yhat_lower"]), 2),
        "yhat_upper": round(float(last["yhat_upper"]), 2),
    }


def load_historical_csv(path: str) -> Optional[pd.DataFrame]:
    """
    Load a historical traffic CSV and return a Prophet DataFrame.

    Expected CSV columns: timestamp (Unix epoch), vehicle_count.
    Returns None if the file does not exist or cannot be parsed.
    """
    if not os.path.exists(path):
        logger.info("[Prophet] Historical CSV not found at: %s", path)
        return None
    try:
        raw = pd.read_csv(path)
        if "timestamp" not in raw.columns or "vehicle_count" not in raw.columns:
            logger.warning("[Prophet] CSV missing required columns (timestamp, vehicle_count).")
            return None
        df = build_prophet_dataframe(raw["timestamp"].tolist(), raw["vehicle_count"].tolist())
        logger.info("[Prophet] Loaded %d rows from historical CSV.", len(df))
        return df
    except Exception as exc:
        logger.error("[Prophet] Failed to load historical CSV '%s': %s", path, exc)
        return None
