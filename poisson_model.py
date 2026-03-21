"""
Poisson win probability model for NHL betting.

Computes P(home wins) given current score and remaining game state
using independent Poisson processes for each team's goal scoring.
Ties count as 0.5 wins (standard moneyline convention).
"""

import math

import config

_MAX_GOALS = 20  # max additional goals per team in the probability grid


def _poisson_pmf(lam: float, max_k: int) -> list[float]:
    """P(X = k) for k in 0..max_k-1, Poisson(lam). Pure Python, no scipy needed."""
    pmf = []
    log_lam = math.log(lam) if lam > 0 else float("-inf")
    log_fact = 0.0
    for k in range(max_k):
        if lam == 0:
            pmf.append(1.0 if k == 0 else 0.0)
        else:
            pmf.append(math.exp(k * log_lam - lam - log_fact))
        log_fact += math.log(k + 1) if k + 1 > 0 else 0.0
    return pmf


def compute_win_prob(
    home_score: int,
    away_score: int,
    lam_home: float,
    lam_away: float,
    max_goals: int = _MAX_GOALS,
) -> float:
    """
    P(home wins) given current score and Poisson lambdas for remaining goals.
    Ties count as 0.5 (e.g. for moneyline markets that pay on regulation winner).
    """
    ph = _poisson_pmf(lam_home, max_goals)
    pa = _poisson_pmf(lam_away, max_goals)

    win = draw = 0.0
    for h_add, p_h in enumerate(ph):
        h_total = home_score + h_add
        for a_add, p_a in enumerate(pa):
            a_total = away_score + a_add
            joint = p_h * p_a
            if h_total > a_total:
                win += joint
            elif h_total == a_total:
                draw += joint

    return win + 0.5 * draw


def solve_home_lambda(
    target_win_prob: float,
    expected_goals: float,
    tol: float = 1e-6,
) -> float:
    """
    Binary search for the home_lambda (in [0,1]) such that
    compute_win_prob(0, 0, E*h, E*(1-h)) == target_win_prob.

    Monotonic in home_lambda so bisection converges in ~50 iterations.
    """
    lo, hi = 0.001, 0.999
    for _ in range(60):
        mid = (lo + hi) / 2
        lam_h = expected_goals * mid
        lam_a = expected_goals * (1.0 - mid)
        p = compute_win_prob(0, 0, lam_h, lam_a)
        if p < target_win_prob:
            lo = mid
        else:
            hi = mid
        if hi - lo < tol:
            break
    return (lo + hi) / 2


def goal_probabilities(
    home_score: int,
    away_score: int,
    portion_left: float,
    expected_goals: float | None = None,
    home_lambda: float | None = None,
) -> dict:
    """
    Compute current and conditional win probabilities.

    Args:
        home_score:    Current home score
        away_score:    Current away score
        portion_left:  Fraction of regulation remaining (0.0–1.0)
        expected_goals: Total expected goals for regulation (default: config)
        home_lambda:   Home share of expected goals 0–1 (default: config)

    Returns dict:
        current         P(home wins) right now
        if_home_scores  P(home wins) if home scores the next goal
        if_away_scores  P(home wins) if away scores the next goal
        home_swing      if_home_scores − current
        away_swing      if_away_scores − current  (negative → away goal hurts home)
        lam_home        expected home goals remaining
        lam_away        expected away goals remaining
    """
    if expected_goals is None:
        expected_goals = config.EXPECTED_TOTAL_GOALS
    if home_lambda is None:
        home_lambda = solve_home_lambda(config.HOME_WIN_PROB, expected_goals)

    away_lambda = 1.0 - home_lambda
    lam_home = expected_goals * home_lambda * max(portion_left, 0.0)
    lam_away = expected_goals * away_lambda * max(portion_left, 0.0)

    p_now         = compute_win_prob(home_score,     away_score,     lam_home, lam_away)
    p_home_scored = compute_win_prob(home_score + 1, away_score,     lam_home, lam_away)
    p_away_scored = compute_win_prob(home_score,     away_score + 1, lam_home, lam_away)

    return {
        "current":        p_now,
        "if_home_scores": p_home_scored,
        "if_away_scores": p_away_scored,
        "home_swing":     p_home_scored - p_now,
        "away_swing":     p_away_scored - p_now,
        "lam_home":       lam_home,
        "lam_away":       lam_away,
    }
