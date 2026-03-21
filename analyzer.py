#!/usr/bin/env python3
"""
Live NHL win probability + Kelly sizing analyzer.

Polls ESPN for live game state, runs the Poisson model, and outputs
current win probabilities and optimal contract sizes.

Usage:
    python analyzer.py <team> [home_price] [away_price]

Examples:
    python analyzer.py TOR
    python analyzer.py TOR 55 48          # specify Kalshi market prices (cents)
    python analyzer.py "Maple Leafs" 55   # with home price only

Args:
    team:        Team abbreviation or name (matched against home or away)
    home_price:  Kalshi YES_home price in cents (default: implied by win prob × 100)
    away_price:  Kalshi YES_away price in cents (default: 100 - home_price)
"""

import sys
import time
from datetime import datetime

import config
from scores import fetch_scoreboard, parse_game, matches_team, format_game, SPORTS
from nhl_state import parse_nhl_state
from poisson_model import goal_probabilities
from kelly_sizer import kelly_summary

SPORT_KEY = "nhl"


def analyze(game_state: dict, home_price: int | None, away_price: int | None) -> None:
    portion = game_state["portion_left"]

    if portion is None:
        print("  [sizing unavailable — intermission]")
        return

    home_score = game_state["home_score"]
    away_score = game_state["away_score"]

    probs = goal_probabilities(home_score, away_score, portion)
    p_home = probs["current"]
    p_away = 1.0 - p_home

    # Default prices: assume 25% edge on the goal swing
    # i.e. we fill at current_prob + 75% of the expected move
    if home_price is None:
        home_price = max(1, min(99, round((p_home + 0.75 * probs["home_swing"]) * 100)))
    if away_price is None:
        away_price = max(1, min(99, round((p_away - 0.75 * probs["away_swing"]) * 100)))

    # Kelly uses conditional win prob (after the goal that triggered the buy)
    p_home_after = probs["if_home_scores"]
    p_away_after = 1.0 - probs["if_away_scores"]

    home_kelly = kelly_summary(p_home_after, home_price)
    away_kelly = kelly_summary(p_away_after, away_price)

    home_abbr = game_state["home"]["abbr"]
    away_abbr = game_state["away"]["abbr"]

    print(f"\n  Win probabilities:")
    print(f"    {home_abbr} (home): {p_home*100:5.1f}%   swing if scores: +{probs['home_swing']*100:.1f}%")
    print(f"    {away_abbr} (away): {p_away*100:5.1f}%   swing if scores: {probs['away_swing']*100:.1f}%")
    print(f"    Expected goals remaining — {home_abbr}: {probs['lam_home']:.2f}  {away_abbr}: {probs['lam_away']:.2f}")

    print(f"\n  Kelly sizing (portfolio=${config.PORTFOLIO_SIZE:.0f}, fraction={config.KELLY_FRACTION}):")
    _print_kelly(f"  YES_{home_abbr} @ {home_price}¢", home_kelly)
    _print_kelly(f"  YES_{away_abbr} @ {away_price}¢", away_kelly)

    print(f"\n  Model params: expected_goals={config.EXPECTED_TOTAL_GOALS}  home_win_prob={config.HOME_WIN_PROB}  solved_lambda={probs['lam_home'] / (config.EXPECTED_TOTAL_GOALS * portion):.3f}" if portion > 0 else f"\n  Model params: expected_goals={config.EXPECTED_TOTAL_GOALS}  home_win_prob={config.HOME_WIN_PROB}")


def _print_kelly(label: str, k: dict) -> None:
    if k["contracts"] == 0:
        edge = "no edge"
    else:
        edge = f"f*={k['kelly_fraction_f']:.3f}  risk=${k['dollar_risk']:.2f}  → {k['contracts']} contracts"
    print(f"    {label:<22} {edge}")


def poll(team_query: str, home_price: int | None, away_price: int | None) -> None:
    sport_path = SPORTS[SPORT_KEY]
    print(f"Tracking '{team_query}' (NHL) — updates every {config.POLL_INTERVAL}s. Ctrl+C to quit.\n")

    while True:
        now = datetime.now().strftime("%H:%M:%S")
        try:
            data = fetch_scoreboard(sport_path)
            events = data.get("events", [])
            games = [parse_game(e) for e in events]
            match = next((g for g in games if matches_team(g, team_query)), None)

            print(f"[{now}] ", end="")
            if match is None:
                print(f"No game found today for '{team_query}'.")
            else:
                state = parse_nhl_state(match)
                print(format_game(match))
                print(f"  Portion of regulation left: {state['portion_left']:.1%}"
                      if state["portion_left"] is not None else "  Portion: unknown")

                if state["is_live"] or state["state"] in ("pre",):
                    analyze(state, home_price, away_price)
                else:
                    print("  [game not in progress]")

        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(f"Error: {e}")

        print()
        time.sleep(config.POLL_INTERVAL)


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    team = args[0]
    home_p = int(args[1]) if len(args) >= 2 else None
    away_p = int(args[2]) if len(args) >= 3 else None

    try:
        poll(team, home_p, away_p)
    except KeyboardInterrupt:
        print("\nStopped.")
