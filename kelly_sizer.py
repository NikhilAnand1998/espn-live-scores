"""
Kelly Criterion contract sizer for NHL moneyline markets.

Given a new win probability and a target fill price,
computes the optimal number of contracts to buy.
"""

import config


def kelly_contracts(
    win_prob: float,
    target_price_cents: int,
    current_position: int = 0,
    portfolio: float | None = None,
    kelly_fraction: float | None = None,
) -> int:
    """
    Full Kelly optimal contract count for a binary outcome market.

    Args:
        win_prob:            P(home wins) after the goal
        target_price_cents:  Expected fill price in cents (e.g. 65 = 65¢)
        current_position:    Contracts already held (positive = long)
        portfolio:           Total bankroll in dollars (default: config)
        kelly_fraction:      Fractional Kelly multiplier (default: config)

    Returns:
        Contracts to buy (0 if Kelly says don't bet or already over-invested).
    """
    if portfolio is None:
        portfolio = config.PORTFOLIO_SIZE
    if kelly_fraction is None:
        kelly_fraction = config.KELLY_FRACTION

    p = win_prob
    q = 1.0 - p
    target_price = target_price_cents / 100.0

    if p <= 0 or p >= 1 or target_price <= 0 or target_price >= 1:
        return 0

    # Payout odds: net gain per dollar risked if we win
    # Buy at `target_price`, payout is $1 → net gain = (1 - target_price) / target_price
    ml_odds = (1.0 - target_price) / target_price

    # Kelly fraction of bankroll to wager
    f_star = (ml_odds * p - q) / ml_odds
    f_star = max(0.0, f_star) * kelly_fraction

    dollar_risk = f_star * portfolio
    # Each contract costs target_price dollars
    target_contracts = dollar_risk / target_price
    contracts_to_buy = int(target_contracts) - current_position

    return max(0, contracts_to_buy)


def kelly_summary(
    win_prob: float,
    target_price_cents: int,
    current_position: int = 0,
    portfolio: float | None = None,
    kelly_fraction: float | None = None,
) -> dict:
    """
    Returns a dict with full Kelly breakdown for display/logging.
    """
    if portfolio is None:
        portfolio = config.PORTFOLIO_SIZE
    if kelly_fraction is None:
        kelly_fraction = config.KELLY_FRACTION

    p = win_prob
    target_price = target_price_cents / 100.0
    contracts = kelly_contracts(win_prob, target_price_cents, current_position, portfolio, kelly_fraction)

    if p <= 0 or p >= 1 or target_price <= 0 or target_price >= 1:
        f_star = 0.0
    else:
        ml_odds = (1.0 - target_price) / target_price
        f_star = max(0.0, (ml_odds * p - (1.0 - p)) / ml_odds) * kelly_fraction

    return {
        "win_prob":         round(p, 4),
        "target_price":     target_price_cents,
        "kelly_fraction_f": round(f_star, 4),
        "dollar_risk":      round(f_star * portfolio, 2),
        "contracts":        contracts,
        "current_position": current_position,
    }
