import os

# SUMO configuration
SUMO_HOME: str = os.environ.get("SUMO_HOME", "")
SUMO_CONFIG_FILE: str = r"G:\grad_all\Riyadh_Simulation\config.sumocfg"
SUMO_USE_GUI: bool = True
SUMO_MAX_STEPS: int = 5000
SUMO_STEP_DELAY: float = 0.1

# Traffic light
DEFAULT_TRAFFIC_LIGHT_ID: str = "12045304748"

# WebSocket / API
HOST: str = "0.0.0.0"
PORT: int = 8000
BROADCAST_INTERVAL: float = 0.5
