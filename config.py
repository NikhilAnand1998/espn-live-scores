# --- Poisson model parameters (update before each game) ---
EXPECTED_TOTAL_GOALS: float = 6.0   # pregame over/under expectation
HOME_GOAL_LAMBDA: float = 0.44       # home share of expected goals (0–1)
GAME_DURATION_SEC: float = 3600.0   # 60 min regulation

# --- Kelly sizer ---
PORTFOLIO_SIZE: float = 1000.0      # total bankroll ($)
KELLY_FRACTION: float = 1.0         # fractional Kelly multiplier (1.0 = full Kelly)

# --- Polling ---
POLL_INTERVAL: int = 15             # seconds between ESPN fetches
