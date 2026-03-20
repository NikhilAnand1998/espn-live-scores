"""
Parses ESPN game data into a structured NHL game state dict, including
the fraction of regulation time remaining (portion_left).

ESPN `detail` examples for NHL:
  Pre:          "7:00 PM ET"
  In-period:    "16:46 - 1st", "5:01 - 2nd", "0:22 - 3rd"
  Intermission: "End of 1st", "End of 2nd", "Intermission"
  OT:           "4:32 - OT"
  Final:        "Final", "Final/OT", "Final/SO"
"""

import re

_PERIOD_RE = re.compile(r"^(\d+):(\d+)\s*-\s*(1st|2nd|3rd)$", re.IGNORECASE)
_END_RE    = re.compile(r"^End of (1st|2nd|3rd)$", re.IGNORECASE)
_OT_RE     = re.compile(r"^\d+:\d+\s*-\s*OT$", re.IGNORECASE)

_PERIOD_NUM = {"1st": 1, "2nd": 2, "3rd": 3}
_PERIOD_SEC = 1200  # 20 minutes per period
_REG_SEC    = 3 * _PERIOD_SEC  # 3600s


def parse_portion_left(detail: str, state: str) -> float | None:
    """
    Convert an ESPN detail string into the fraction of regulation remaining.

    Returns:
        float in [0.0, 1.0]  — for in-progress regulation
        0.0                  — overtime or after regulation (OT/SO/Final)
        1.0                  — pre-game
        None                 — intermission (between periods; portion is
                               discrete so caller can treat as full next period)
    """
    if state == "pre":
        return 1.0

    if state == "post":
        return 0.0

    # Live game
    d = detail.strip()

    # In-period: "14:32 - 2nd"
    m = _PERIOD_RE.match(d)
    if m:
        period = _PERIOD_NUM[m.group(3).capitalize()]
        mins, secs = int(m.group(1)), int(m.group(2))
        secs_in_period = mins * 60 + secs          # time left in this period
        elapsed = (period - 1) * _PERIOD_SEC + (_PERIOD_SEC - secs_in_period)
        remaining = _REG_SEC - elapsed
        return max(0.0, remaining / _REG_SEC)

    # End of period / intermission
    m = _END_RE.match(d)
    if m:
        period = _PERIOD_NUM[m.group(1).capitalize()]
        remaining = _REG_SEC - period * _PERIOD_SEC
        return max(0.0, remaining / _REG_SEC)

    if "Intermission" in d:
        # Unknown which intermission — return None so caller can handle
        return None

    # OT or shootout
    if _OT_RE.match(d) or "OT" in d or "SO" in d:
        return 0.0

    # Final
    if "Final" in d or state == "post":
        return 0.0

    return None


def parse_nhl_state(game: dict) -> dict:
    """
    Enrich a parsed ESPN game dict with NHL-specific fields.

    Input:  game dict from scores.parse_game()
    Output: same dict plus:
        home_score    int
        away_score    int
        period        str   (detail, e.g. "2nd 14:32")
        portion_left  float | None
        is_live       bool
    """
    home_score = _safe_int(game.get("home", {}).get("score", "0"))
    away_score = _safe_int(game.get("away", {}).get("score", "0"))
    state      = game.get("state", "")
    detail     = game.get("detail", "")
    portion    = parse_portion_left(detail, state)

    return {
        **game,
        "home_score":   home_score,
        "away_score":   away_score,
        "period":       detail,
        "portion_left": portion,
        "is_live":      state == "in",
    }


def _safe_int(val) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return 0
