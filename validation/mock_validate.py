from __future__ import annotations

import json
import math
import os
import random
import re
import statistics
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import requests
from bs4 import BeautifulSoup

SITE = "https://nikhilanand1998.github.io/espn-live-scores/"
FFC_URL = "https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?position=all&teams=14&year=2026"
PICKS = [9, 20, 37, 48, 65, 76, 93, 104, 121, 132, 149, 160, 177, 188, 205, 216]
SCENARIOS = {"normal": {}, "rb_run": {"RB": -5.0}, "wr_run": {"WR": -5.0}}
POLICIES = ["tree", "market_balanced", "projection_balanced", "robust_rb", "wr_lean"]
MOCKS_PER_SCENARIO = int(os.getenv("MOCKS_PER_SCENARIO", "1000"))
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36"}


@dataclass(frozen=True)
class Player:
    key: str
    name: str
    pos: str
    adp: float
    app_id: int | None = None


def norm(name: str) -> str:
    value = name.lower().replace("’", "'")
    value = re.sub(r"\b(jr|sr|ii|iii|iv)\.?\b", " ", value)
    return re.sub(r"[^a-z0-9]+", "", value)


def get_text(url: str, require: str | None = None, attempts: int = 36) -> str:
    last = None
    for attempt in range(attempts):
        try:
            response = requests.get(url, headers=UA, timeout=35)
            response.raise_for_status()
            if require and require not in response.text:
                raise RuntimeError(f"latest deployed asset not ready: missing {require!r}")
            return response.text
        except Exception as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(5)
    raise RuntimeError(f"Unable to fetch {url}: {last}")


def load_app_players() -> list[Player]:
    js = get_text(SITE + "data.js", require="const raw=")
    match = re.search(r"const raw=`(.*?)`;", js, flags=re.S)
    if not match:
        raise RuntimeError("Could not parse deployed data.js")
    result = []
    for idx, token in enumerate(match.group(1).split(";")):
        name, pos, adp = token.split("|")
        pos = "DEF" if pos in {"DST", "D/ST"} else pos
        result.append(Player(norm(name), name, pos, float(adp), idx))
    if len(result) < 100:
        raise RuntimeError(f"App player pool is unexpectedly small: {len(result)}")
    app_js = get_text(SITE + "app.js", require="pick9-hosted-v2")
    if "function scarcity" not in app_js or "clear draft value" not in app_js:
        raise RuntimeError("Latest value/scarcity recommendation engine is not deployed")
    return result


def extract_rows(payload) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        for key in ("players", "data", "results"):
            rows = payload.get(key)
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
        for value in payload.values():
            rows = extract_rows(value)
            if rows:
                return rows
    return []


def load_ffc_players(app_players: list[Player]) -> tuple[list[Player], dict]:
    response = requests.get(FFC_URL, headers=UA, timeout=35)
    response.raise_for_status()
    payload = response.json()
    rows = extract_rows(payload)
    all_players: dict[str, Player] = {}
    parsed = 0
    for row in rows:
        name = row.get("name") or row.get("player_name") or row.get("player")
        pos = row.get("position") or row.get("pos")
        adp = row.get("adp") or row.get("average_pick") or row.get("avg_pick")
        try:
            adp = float(adp)
        except (TypeError, ValueError):
            continue
        if not name or not pos:
            continue
        pos = str(pos).upper().replace("D/ST", "DEF").replace("DST", "DEF")
        key = norm(str(name))
        all_players[key] = Player(key, str(name), pos, adp)
        parsed += 1
    if parsed < 180:
        raise RuntimeError(f"FFC exact-format ADP returned only {parsed} usable players")
    for p in app_players:
        existing = all_players.get(p.key)
        all_players[p.key] = Player(p.key, p.name, p.pos, existing.adp if existing else p.adp, p.app_id)
    meta = {
        "url": FFC_URL,
        "usable_players": parsed,
        "payload_keys": list(payload) if isinstance(payload, dict) else [type(payload).__name__],
    }
    return list(all_players.values()), meta


def load_fantasypros() -> tuple[dict[str, float], dict]:
    projection: dict[str, float] = {}
    counts = {}
    for pos in ("qb", "rb", "wr", "te"):
        scoring = "&scoring=HALF" if pos != "qb" else ""
        url = f"https://www.fantasypros.com/nfl/projections/{pos}.php?week=draft{scoring}"
        response = requests.get(url, headers=UA, timeout=35)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        table = soup.select_one("table#data") or soup.find("table")
        found = 0
        if table:
            for row in table.select("tbody tr"):
                name_el = row.select_one("a.player-name") or row.find("a")
                cells = row.find_all("td")
                if not name_el or len(cells) < 2:
                    continue
                numbers = re.findall(r"-?\d+(?:\.\d+)?", cells[-1].get_text(" ", strip=True).replace(",", ""))
                if not numbers:
                    continue
                value = float(numbers[-1])
                if value <= 0:
                    continue
                projection[norm(name_el.get_text(" ", strip=True))] = value
                found += 1
        counts[pos.upper()] = found
    return projection, {"source": "FantasyPros draft projections", "counts": counts, "usable": len(projection)}


def fallback_projection(pos: str, rank: int) -> float:
    if pos == "QB":
        return max(205.0, 350.0 - 5.8 * (rank - 1))
    if pos == "RB":
        if rank <= 12:
            return 300.0 - 7.0 * (rank - 1)
        if rank <= 36:
            return 223.0 - 3.9 * (rank - 12)
        return max(70.0, 129.4 - 2.0 * (rank - 36))
    if pos == "WR":
        if rank <= 12:
            return 305.0 - 6.2 * (rank - 1)
        if rank <= 42:
            return 236.8 - 3.15 * (rank - 12)
        return max(65.0, 142.3 - 1.75 * (rank - 42))
    if pos == "TE":
        if rank <= 5:
            return 245.0 - 12.0 * (rank - 1)
        if rank <= 14:
            return 197.0 - 6.0 * (rank - 5)
        return max(55.0, 143.0 - 3.2 * (rank - 14))
    return 115.0


def build_projection_map(all_players: list[Player], fp: dict[str, float]) -> tuple[dict[str, float], dict]:
    by_pos = defaultdict(list)
    for p in all_players:
        by_pos[p.pos].append(p)
    for values in by_pos.values():
        values.sort(key=lambda p: p.adp)
    result = {}
    matched = 0
    for pos, values in by_pos.items():
        for rank, p in enumerate(values, 1):
            if p.key in fp:
                result[p.key] = fp[p.key]
                matched += 1
            else:
                result[p.key] = fallback_projection(pos, rank)
    return result, {"matched_to_independent_projection": matched, "total_players": len(all_players), "coverage": matched / max(1, len(all_players))}


def position_ranks(app_players: list[Player]) -> dict[str, int]:
    ranks = {}
    groups = defaultdict(list)
    for p in app_players:
        groups[p.pos].append(p)
    for values in groups.values():
        values.sort(key=lambda p: p.adp)
        for i, p in enumerate(values, 1):
            ranks[p.key] = i
    return ranks


def count_positions(roster: list[Player]) -> Counter:
    return Counter(p.pos for p in roster)


def fit_score(p: Player, r: int, c: Counter, pos_rank: dict[str, int]) -> float:
    s, z = 0.0, p.pos
    if c["QB"] and z == "QB": s -= 52
    if c["TE"] and z == "TE": s -= 26
    if c["DEF"] and z == "DEF": s -= 80
    if c["K"] and z == "K": s -= 80
    if r == 1:
        s += 8 if z in {"RB", "WR"} else -55
    elif r == 2:
        if c["RB"] == 0: s += 18 if z == "RB" else 5 if z == "WR" else -30
        else: s += 14 if z == "RB" else 10 if z == "WR" else -28
    elif r <= 4:
        if c["RB"] < 2 and z == "RB": s += 18
        if c["WR"] < 2 and z == "WR": s += 18
        if c["RB"] >= 2 and z == "RB": s -= 3
        if c["WR"] >= 2 and z == "WR": s += 6
        if z == "TE" and not c["TE"] and pos_rank.get(p.key, 99) <= 3: s += 8
        if z == "QB": s -= 8
    elif r <= 6:
        if c["RB"] < 2 and z == "RB": s += 23
        if c["WR"] < 2 and z == "WR": s += 23
        if c["WR"] < 3 and z == "WR": s += 10
        if c["QB"] < 1 and z == "QB": s += 18 if r == 6 else 7
        if c["TE"] < 1 and z == "TE": s += 12
        if z == "RB": s += 5
    elif r <= 8:
        if c["QB"] < 1 and z == "QB": s += 34
        if c["TE"] < 1 and z == "TE": s += 18
        if c["RB"] < 3 and z == "RB": s += 10
        if c["WR"] < 4 and z == "WR": s += 9
    elif r <= 10:
        if c["TE"] < 1 and z == "TE": s += 40
        if c["QB"] < 1 and z == "QB": s += 28
        if z in {"RB", "WR"}: s += 11
    elif r < 15:
        s += 26 if z in {"RB", "WR"} else 18 if z == "TE" and not c["TE"] else -42
    else:
        s += 115 if (r == 15 and z == "DEF") or (r == 16 and z == "K") else -115
    return s


def app_candidates(app_players: list[Player], available: set[str], r: int) -> list[Player]:
    pick = PICKS[r - 1]
    result = []
    for p in app_players:
        if p.key not in available:
            continue
        if r == 15:
            if p.pos == "DEF": result.append(p)
            continue
        if r == 16:
            if p.pos == "K": result.append(p)
            continue
        if p.pos in {"DEF", "K"}:
            continue
        if (r == 1 and p.adp < 32) or (r > 1 and p.adp <= pick + (55 if r <= 8 else 85)):
            result.append(p)
    return result


def tree_ranked(app_players: list[Player], available: set[str], roster: list[Player], r: int, pos_rank: dict[str, int]) -> list[Player]:
    cand = app_candidates(app_players, available, r)
    c = count_positions(roster)
    next_pick = PICKS[r] if r < 16 else 999
    def scarcity(p: Player) -> float:
        if r >= 15 or p.adp > next_pick - 5:
            return 0.0
        pr = pos_rank.get(p.key, 99)
        next_pos = sorted((q for q in cand if q.pos == p.pos and q.key != p.key and q.adp >= next_pick - 5), key=lambda q: q.adp)
        if not next_pos:
            return 10.0
        gap = pos_rank.get(next_pos[0].key, pr) - pr
        return max(0.0, min(12.0, gap * 1.8))
    def score(p: Player) -> float:
        pick = PICKS[r - 1]
        delta = pick - p.adp
        value = 70 - abs(delta) * 0.35 + max(-20, min(30, delta * 1.1))
        value += fit_score(p, r, c, pos_rank) + scarcity(p)
        if r <= 8 and p.adp > pick + 18:
            value -= (p.adp - (pick + 18)) * 1.1
        if p.adp < pick - 20:
            value += 10
        return value
    return sorted(cand, key=lambda p: (-score(p), p.adp))


def replacement_levels(all_players: list[Player], projection: dict[str, float]) -> dict[str, float]:
    ranks = {"QB": 14, "RB": 36, "WR": 42, "TE": 14}
    result = {}
    for pos, rank in ranks.items():
        vals = sorted((projection[p.key] for p in all_players if p.pos == pos), reverse=True)
        result[pos] = vals[min(rank - 1, len(vals) - 1)]
    return result


def policy_pick(policy: str, app_players: list[Player], available: set[str], roster: list[Player], r: int,
                pos_rank: dict[str, int], projection: dict[str, float], repl: dict[str, float]) -> Player | None:
    candidates = app_candidates(app_players, available, r)
    if not candidates:
        return None
    if policy == "tree":
        return tree_ranked(app_players, available, roster, r, pos_rank)[0]
    c = count_positions(roster)
    pick = PICKS[r - 1]
    def deadlines(p: Player) -> float:
        s = 0.0
        if r >= 4 and c["RB"] < 2 and p.pos == "RB": s += 55
        if r >= 4 and c["WR"] < 2 and p.pos == "WR": s += 55
        if r >= 8 and c["QB"] < 1 and p.pos == "QB": s += 75
        if r >= 10 and c["TE"] < 1 and p.pos == "TE": s += 75
        if r == 15: s += 200 if p.pos == "DEF" else -200
        if r == 16: s += 200 if p.pos == "K" else -200
        if c[p.pos] and p.pos in {"QB", "TE", "DEF", "K"}: s -= 65
        return s
    if policy == "market_balanced":
        return max(candidates, key=lambda p: deadlines(p) - p.adp - max(0, p.adp - pick - 15) * 1.5)
    def proj_utility(p: Player) -> float:
        vorp = projection[p.key] - repl.get(p.pos, projection[p.key])
        s = vorp + deadlines(p)
        if p.pos == "RB" and c["RB"] < 2: s += 18
        if p.pos == "WR" and c["WR"] < 3: s += 15
        if p.pos == "QB" and r < 5: s -= 35
        if p.pos == "TE" and r < 4: s -= 18
        s += max(-20, min(25, (pick - p.adp) * 0.8))
        return s
    if policy == "projection_balanced":
        return max(candidates, key=proj_utility)
    if policy == "robust_rb":
        if r <= 2:
            rbs = [p for p in candidates if p.pos == "RB" and p.adp <= pick + 12]
            if rbs: return max(rbs, key=proj_utility)
        return max(candidates, key=proj_utility)
    if policy == "wr_lean":
        if r <= 2:
            wrs = [p for p in candidates if p.pos == "WR" and p.adp <= pick + 10]
            if wrs: return max(wrs, key=proj_utility)
        return max(candidates, key=proj_utility)
    raise ValueError(policy)


def roster_score(roster: list[Player], projection: dict[str, float]) -> tuple[float, bool]:
    groups = defaultdict(list)
    for p in roster:
        groups[p.pos].append(projection[p.key])
    for vals in groups.values(): vals.sort(reverse=True)
    complete = len(groups["QB"]) >= 1 and len(groups["RB"]) >= 2 and len(groups["WR"]) >= 2 and len(groups["TE"]) >= 1 and len(groups["DEF"]) >= 1 and len(groups["K"]) >= 1
    if not complete:
        return -1000.0, False
    used = {"QB": 1, "RB": 2, "WR": 2, "TE": 1}
    score = groups["QB"][0] + sum(groups["RB"][:2]) + sum(groups["WR"][:2]) + groups["TE"][0]
    flex = []
    for pos in ("RB", "WR", "TE"):
        flex += groups[pos][used[pos]:]
    flex.sort(reverse=True)
    if flex: score += flex[0]
    bench = flex[1:5]
    score += 0.025 * sum(bench)
    return score, True


def simulate_one(all_players: list[Player], app_players: list[Player], projection: dict[str, float], repl: dict[str, float],
                 pos_rank: dict[str, int], scenario: str, policy: str, seed: int):
    rng = random.Random(seed)
    shifts = SCENARIOS[scenario]
    latent = {}
    by_key = {p.key: p for p in all_players}
    for p in all_players:
        sigma = min(18.0, max(3.0, 2.0 + 0.075 * p.adp))
        shift = shifts.get(p.pos, 0.0) if p.adp < 90 else 0.0
        latent[p.key] = p.adp + shift + rng.gauss(0, sigma)
    order = sorted(all_players, key=lambda p: latent[p.key])
    available = set(by_key)
    pointer = 0
    roster = []
    early_reaches = 0
    fallback = 0
    our_pick_set = set(PICKS)
    snapshots = []
    for overall in range(1, 217):
        if overall in our_pick_set:
            r = PICKS.index(overall) + 1
            choice = policy_pick(policy, app_players, available, roster, r, pos_rank, projection, repl)
            if choice is None:
                fallback += 1
                eligible = [by_key[k] for k in available if (r == 15 and by_key[k].pos == "DEF") or (r == 16 and by_key[k].pos == "K") or (r < 15 and by_key[k].pos not in {"DEF", "K"})]
                if not eligible: break
                choice = min(eligible, key=lambda p: p.adp)
            roster.append(choice)
            available.discard(choice.key)
            if r <= 8 and choice.adp - overall > 20:
                early_reaches += 1
            snapshots.append(Counter(p.pos for p in roster))
        else:
            while pointer < len(order) and order[pointer].key not in available:
                pointer += 1
            if pointer >= len(order):
                break
            available.remove(order[pointer].key)
            pointer += 1
    score, complete = roster_score(roster, projection)
    c8 = snapshots[7] if len(snapshots) >= 8 else Counter()
    core8 = c8["QB"] >= 1 and c8["RB"] >= 2 and c8["WR"] >= 2
    return {"roster": roster, "score": score, "complete": complete, "core8": core8, "early_reaches": early_reaches, "fallback": fallback}


def stress_tests(app_players: list[Player], pos_rank: dict[str, int]) -> list[dict]:
    by_name = {p.name: p for p in app_players}
    all_keys = {p.key for p in app_players}
    results = []
    def run(label: str, roster_names: list[str], gone_names: list[str], r: int, allowed_pos: set[str] | None = None, allowed_names: set[str] | None = None):
        roster = [by_name[n] for n in roster_names]
        available = all_keys - {p.key for p in roster} - {by_name[n].key for n in gone_names if n in by_name}
        ranked = tree_ranked(app_players, available, roster, r, pos_rank)
        top = ranked[0]
        ok = (allowed_pos is None or top.pos in allowed_pos) and (allowed_names is None or top.name in allowed_names)
        results.append({"label": label, "top": top.name, "position": top.pos, "passed": ok})
    top8 = ["Jahmyr Gibbs","Bijan Robinson","Puka Nacua","Ja'Marr Chase","Jaxon Smith-Njigba","Jonathan Taylor","Christian McCaffrey","Amon-Ra St. Brown"]
    run("Normal pick 9", [], top8, 1, allowed_names={"James Cook","Derrick Henry","CeeDee Lamb","De'Von Achane"})
    run("RB-first Round 2", ["James Cook"], top8 + ["Derrick Henry","De'Von Achane","CeeDee Lamb","Justin Jefferson","Chase Brown","Drake London","Saquon Barkley","Rashee Rice","George Pickens"], 2, allowed_names={"Kenneth Walker","A.J. Brown","Nico Collins","Omarion Hampton"})
    run("WR-first Round 2", ["CeeDee Lamb"], top8 + ["James Cook","Derrick Henry","De'Von Achane","Chase Brown","Saquon Barkley"], 2, allowed_pos={"RB"})
    run("RB-RB Round 3", ["James Cook","Kenneth Walker"], top8 + ["Derrick Henry","De'Von Achane","CeeDee Lamb","Justin Jefferson","Chase Brown","Drake London","Saquon Barkley","A.J. Brown","Rashee Rice","George Pickens","Nico Collins","Omarion Hampton","Chris Olave","Malik Nabers","Kyren Williams","Javonte Williams","Breece Hall"], 3, allowed_pos={"WR"})
    run("Balanced Round 5", ["James Cook","Kenneth Walker","Garrett Wilson","Jaylen Waddle"], top8, 5, allowed_pos={"WR","TE","RB"})
    run("QB deadline Round 8", ["James Cook","Kenneth Walker","Garrett Wilson","Jaylen Waddle","Colston Loveland","Parker Washington","Blake Corum"], top8, 8, allowed_pos={"QB"})
    run("Defense Round 15", ["James Cook","Kenneth Walker","Garrett Wilson","Jaylen Waddle","Colston Loveland","Parker Washington","Jayden Daniels","Blake Corum","Rashid Shaheed","Rachaad White","Woody Marks","Denzel Boston","Ray Davis","Tre Harris"], top8, 15, allowed_pos={"DEF"})
    run("Kicker Round 16", ["James Cook","Kenneth Walker","Garrett Wilson","Jaylen Waddle","Colston Loveland","Parker Washington","Jayden Daniels","Blake Corum","Rashid Shaheed","Rachaad White","Woody Marks","Denzel Boston","Ray Davis","Tre Harris","Jacksonville Defense"], top8, 16, allowed_pos={"K"})
    return results


def main():
    app_players = load_app_players()
    all_players, ffc_meta = load_ffc_players(app_players)
    fp, fp_meta = load_fantasypros()
    projection, coverage = build_projection_map(all_players, fp)
    pos_rank = position_ranks(app_players)
    repl = replacement_levels(all_players, projection)

    metrics = {scenario: {policy: [] for policy in POLICIES} for scenario in SCENARIOS}
    first_six = {scenario: [Counter() for _ in range(6)] for scenario in SCENARIOS}
    samples = defaultdict(list)
    for scenario_index, scenario in enumerate(SCENARIOS):
        for i in range(MOCKS_PER_SCENARIO):
            seed = 20260904 + scenario_index * 10_000_000 + i
            for policy in POLICIES:
                result = simulate_one(all_players, app_players, projection, repl, pos_rank, scenario, policy, seed)
                metrics[scenario][policy].append(result)
                if policy == "tree":
                    for r, p in enumerate(result["roster"][:6]):
                        first_six[scenario][r][p.name] += 1
                    if i < 4:
                        samples[scenario].append([p.name + " (" + p.pos + ")" for p in result["roster"]])

    summary = {}
    for scenario in SCENARIOS:
        summary[scenario] = {}
        for policy in POLICIES:
            rows = metrics[scenario][policy]
            scores = [x["score"] for x in rows]
            summary[scenario][policy] = {
                "mean_score": round(statistics.fmean(scores), 2),
                "median_score": round(statistics.median(scores), 2),
                "complete_rate": round(statistics.fmean(x["complete"] for x in rows), 4),
                "core_by_round_8_rate": round(statistics.fmean(x["core8"] for x in rows), 4),
                "mean_early_reaches": round(statistics.fmean(x["early_reaches"] for x in rows), 4),
                "mean_pool_fallbacks": round(statistics.fmean(x["fallback"] for x in rows), 4),
            }

    stress = stress_tests(app_players, pos_rank)
    all_stress_pass = all(x["passed"] for x in stress)
    tree_scores = [summary[s]["tree"]["mean_score"] for s in SCENARIOS]
    baseline_best = [max(summary[s][p]["mean_score"] for p in POLICIES if p != "projection_balanced") for s in SCENARIOS]
    oracle_scores = [summary[s]["projection_balanced"]["mean_score"] for s in SCENARIOS]
    ratios_baseline = [a / b for a, b in zip(tree_scores, baseline_best)]
    ratios_oracle = [a / b for a, b in zip(tree_scores, oracle_scores)]
    complete_min = min(summary[s]["tree"]["complete_rate"] for s in SCENARIOS)
    core8_min = min(summary[s]["tree"]["core_by_round_8_rate"] for s in SCENARIOS)
    fallback_max = max(summary[s]["tree"]["mean_pool_fallbacks"] for s in SCENARIOS)
    reach_max = max(summary[s]["tree"]["mean_early_reaches"] for s in SCENARIOS)

    checks = {
        "all_human_reviewed_stress_branches_pass": all_stress_pass,
        "within_2_percent_of_best_rule_based_strategy_every_room": min(ratios_baseline) >= 0.98,
        "within_4_percent_of_projection_aware_oracle_every_room": min(ratios_oracle) >= 0.96,
        "complete_roster_rate_at_least_99_5_percent": complete_min >= 0.995,
        "qb_2rb_2wr_core_by_round_8_at_least_85_percent": core8_min >= 0.85,
        "app_pool_fallbacks_below_one_per_100_drafts": fallback_max <= 0.01,
        "severe_early_reaches_below_one_per_20_drafts": reach_max <= 0.05,
        "independent_projection_coverage_at_least_35_percent": coverage["coverage"] >= 0.35,
    }
    valid = all(checks.values())

    report = {
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "site": SITE,
        "format": "14-team, half-PPR, 1QB, 2RB, 2WR, 1TE, 1FLEX, DEF, K; pick 9 snake",
        "mocks_per_scenario": MOCKS_PER_SCENARIO,
        "total_tree_mock_drafts": MOCKS_PER_SCENARIO * len(SCENARIOS),
        "total_policy_draft_runs": MOCKS_PER_SCENARIO * len(SCENARIOS) * len(POLICIES),
        "scenarios": list(SCENARIOS),
        "policies": POLICIES,
        "source_meta": {"ffc_adp": ffc_meta, "fantasypros": fp_meta, "projection_coverage": coverage},
        "replacement_projection_points": {k: round(v, 2) for k, v in repl.items()},
        "summary": summary,
        "tree_relative_to_best_rule_policy": {s: round(ratios_baseline[i], 4) for i, s in enumerate(SCENARIOS)},
        "tree_relative_to_projection_oracle": {s: round(ratios_oracle[i], 4) for i, s in enumerate(SCENARIOS)},
        "top_tree_picks_by_round": {s: [{name: count for name, count in counter.most_common(8)} for counter in first_six[s]] for s in SCENARIOS},
        "sample_tree_rosters": dict(samples),
        "stress_tests": stress,
        "checks": checks,
        "VALIDATED": valid,
        "limitations": [
            "Mocks model opponent availability from exact-format ADP with realistic random variance; they do not know your league mates.",
            "FantasyPros consensus projections are independent of the tree's ADP ranking, but projections remain uncertain.",
            "Season-long sportsbook props are useful cross-checks for early players but are not available consistently enough for the entire player pool.",
            "Passing this audit means the recommendations are defensible and robust, not guaranteed to be optimal in every live room."
        ]
    }
    out = Path("validation-output")
    out.mkdir(exist_ok=True)
    (out / "mock-draft-validation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    lines = [
        "# Pick 9 Draft Tree — Mock-Draft Validation",
        "",
        f"**Result:** {'PASS' if valid else 'FAIL'}",
        f"**Generated:** {report['generated_utc']}",
        f"**Drafts:** {report['total_tree_mock_drafts']:,} tree drafts; {report['total_policy_draft_runs']:,} total policy runs",
        "",
        "## Scenario results",
        "",
        "| Room | Tree mean | Best rule policy | Projection-aware | Complete | Core by R8 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for s in SCENARIOS:
        tree = summary[s]["tree"]
        best_rule = max(summary[s][p]["mean_score"] for p in POLICIES if p != "projection_balanced")
        oracle = summary[s]["projection_balanced"]["mean_score"]
        lines.append(f"| {s} | {tree['mean_score']:.2f} | {best_rule:.2f} | {oracle:.2f} | {tree['complete_rate']:.1%} | {tree['core_by_round_8_rate']:.1%} |")
    lines += ["", "## Validation checks", ""]
    for label, passed in checks.items():
        lines.append(f"- {'PASS' if passed else 'FAIL'} — {label.replace('_',' ')}")
    lines += ["", "## Human-reviewed branch stress tests", ""]
    for test in stress:
        lines.append(f"- {'PASS' if test['passed'] else 'FAIL'} — {test['label']}: **{test['top']} ({test['position']})**")
    lines += ["", "## Important limitation", "", "This audit validates the decision framework against current market availability and an independent projection set. It cannot guarantee the highest-scoring roster because injuries, role changes, and your league's draft behavior remain uncertain."]
    (out / "mock-draft-validation.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if not valid:
        failed = [name for name, passed in checks.items() if not passed]
        raise SystemExit("VALIDATION FAILED: " + ", ".join(failed))


if __name__ == "__main__":
    main()
