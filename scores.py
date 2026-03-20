#!/usr/bin/env python3
"""
Live score poller using ESPN's unofficial scoreboard API.

Usage:
    python scores.py <sport> <team>

Examples:
    python scores.py nhl TOR
    python scores.py ncaab "Duke"
    python scores.py nhl                  # lists today's NHL games
    python scores.py ncaab                # lists today's NCAAB games
"""

import sys
import time
import urllib.request
import urllib.error
import json
from datetime import datetime

SPORTS = {
    "nhl": "hockey/nhl",
    "ncaab": "basketball/mens-college-basketball",
}

POLL_INTERVAL = 15  # seconds


def fetch_scoreboard(sport_path: str) -> dict:
    url = f"https://site.api.espn.com/apis/site/v2/sports/{sport_path}/scoreboard"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def parse_game(event: dict) -> dict:
    """Extract structured info from a raw ESPN event."""
    status = event.get("status", {})
    state = status.get("type", {}).get("state", "")
    detail = status.get("type", {}).get("shortDetail", "")

    competitors = event.get("competitions", [{}])[0].get("competitors", [])
    teams = {}
    for c in competitors:
        side = c.get("homeAway", "home")
        team = c.get("team", {})
        teams[side] = {
            "abbr": team.get("abbreviation", "???").upper(),
            "name": team.get("displayName", ""),
            "score": c.get("score", "-"),
        }

    return {
        "state": state,
        "detail": detail,
        "home": teams.get("home", {}),
        "away": teams.get("away", {}),
    }


def matches_team(game: dict, query: str) -> bool:
    q = query.lower()
    for side in ("home", "away"):
        t = game.get(side, {})
        if q in t.get("abbr", "").lower() or q in t.get("name", "").lower():
            return True
    return False


def format_game(game: dict) -> str:
    home, away = game["home"], game["away"]
    score_str = f"{away['abbr']} {away['score']}  @  {home['abbr']} {home['score']}"
    state, detail = game["state"], game["detail"]

    if state == "in":
        return f"[LIVE]  {score_str}  ({detail})"
    elif state == "post":
        return f"[FINAL] {score_str}"
    else:
        return f"[PRE]   {score_str}  ({detail})"


def list_games(sport_key: str, live_only: bool = False):
    """Print all games today and exit — useful for finding team abbreviations."""
    sport_path = SPORTS[sport_key]
    data = fetch_scoreboard(sport_path)
    events = data.get("events", [])
    if not events:
        print("No games scheduled today.")
        return
    print(f"\nToday's {sport_key.upper()} games:")
    for e in events:
        g = parse_game(e)
        if live_only and g["state"] == "post":
            continue
        print(f"  {format_game(g)}")
        print(f"    Home: {g['home']['name']} ({g['home']['abbr']})")
        print(f"    Away: {g['away']['name']} ({g['away']['abbr']})")


def poll(sport_key: str, team_query: str, live_only: bool = False):
    sport_path = SPORTS[sport_key]

    while True:
        now = datetime.now().strftime("%H:%M:%S")

        try:
            data = fetch_scoreboard(sport_path)
            events = data.get("events", [])

            games = [parse_game(e) for e in events]
            match = next((g for g in games if matches_team(g, team_query)), None)

            print(f"\n[{now}] ", end="")
            if match is None:
                print(f"No game found today for '{team_query}'.")
            elif live_only and match["state"] == "post":
                print(f"Game is final — skipping. (drop -l to see final scores)")
            else:
                print(format_game(match))

        except urllib.error.URLError as e:
            print(f"\n[{now}] Network error: {e.reason}")
        except Exception as e:
            print(f"\n[{now}] Error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    args = sys.argv[1:]

    live_only = "-l" in args
    args = [a for a in args if a != "-l"]

    if not args:
        print(__doc__)
        sys.exit(0)

    sport = args[0].lower()
    if sport not in SPORTS:
        print(f"Unknown sport '{sport}'. Available: {', '.join(SPORTS)}")
        sys.exit(1)

    if len(args) < 2:
        # No team specified — just list today's games
        list_games(sport, live_only=live_only)
        sys.exit(0)

    team = args[1]
    print(f"Tracking '{team}' ({sport.upper()}) — updates every {POLL_INTERVAL}s. Ctrl+C to quit.")
    try:
        poll(sport, team, live_only=live_only)
    except KeyboardInterrupt:
        print("\nStopped.")
