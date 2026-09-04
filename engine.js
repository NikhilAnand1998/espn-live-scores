(function (global) {
  'use strict';

  const PICKS = [9, 20, 37, 48, 65, 76, 93, 104, 121, 132, 149, 160, 177, 188, 205, 216];
  const STARTERS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1 };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function counts(roster) {
    const result = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0, K: 0 };
    for (const player of roster || []) {
      if (Object.prototype.hasOwnProperty.call(result, player.pos)) result[player.pos] += 1;
    }
    return result;
  }

  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  function normalCdf(z) {
    return 0.5 * (1 + erf(z / Math.SQRT2));
  }

  function goneBeforeNext(player, currentPick, nextPick) {
    if (!nextPick) return 1;
    const sd = Math.max(1.5, Number(player.sd || 8));
    const already = normalCdf((currentPick - player.adp) / sd);
    const byNext = normalCdf((nextPick - player.adp) / sd);
    return clamp((byNext - already) / Math.max(0.001, 1 - already), 0, 1);
  }

  function isEligible(player, roster, round) {
    const c = counts(roster);
    if (!player || player.excluded) return false;
    if (round === 15) return player.pos === 'DEF';
    if (round === 16) return player.pos === 'K';
    if (player.pos === 'DEF' || player.pos === 'K') return false;
    if (round <= 2 && player.pos !== 'RB' && player.pos !== 'WR') return false;
    if (c.QB >= 1 && player.pos === 'QB' && round < 13) return false;
    if (c.TE >= 1 && player.pos === 'TE' && round < 12) return false;
    if (c.QB >= 2 && player.pos === 'QB') return false;
    if (c.TE >= 2 && player.pos === 'TE') return false;
    return true;
  }

  function structureAdjustment(player, roster, round) {
    const c = counts(roster);
    const pos = player.pos;
    let score = 0;

    if (round === 1) return pos === 'RB' ? 4 : pos === 'WR' ? 2 : -100;

    if (round === 2) {
      if (c.RB === 0 && pos === 'RB') score += 25;
      if (c.WR === 0 && pos === 'WR') score += 9;
      if (c.RB === 1 && pos === 'RB') score += 10;
      if (c.WR === 1 && pos === 'RB') score += 14;
      return score;
    }

    if (round <= 4) {
      if (c.RB === 0 && pos === 'RB') score += 44;
      else if (c.RB < 2 && pos === 'RB') score += 22;
      if (c.WR === 0 && pos === 'WR') score += 40;
      else if (c.WR < 2 && pos === 'WR') score += 22;

      if (c.RB >= 2 && c.WR < 2) {
        if (pos === 'WR') score += 25;
        if (pos === 'RB') score -= 34;
      }
      if (c.WR >= 2 && c.RB < 2) {
        if (pos === 'RB') score += 25;
        if (pos === 'WR') score -= 32;
      }
      if (c.RB >= 3 && pos === 'RB') score -= 55;
      if (c.WR >= 3 && pos === 'WR') score -= 42;
      if ((pos === 'QB' || pos === 'TE') && (c.RB < 2 || c.WR < 1)) score -= 24;
      if ((pos === 'QB' || pos === 'TE') && c.RB + c.WR < 3) score -= 18;
      return score;
    }

    if (round <= 6) {
      if (c.RB < 2 && pos === 'RB') score += 36;
      if (c.WR < 2 && pos === 'WR') score += 36;
      if (c.WR < 3 && pos === 'WR') score += 8;
      if (c.RB + c.WR < 4 && (pos === 'QB' || pos === 'TE')) score -= 18;
      if (c.QB === 0 && pos === 'QB') score += round === 5 ? 5 : 10;
      if (c.TE === 0 && pos === 'TE') score += round === 5 ? 7 : 11;
      if (c.RB >= 3 && c.WR < 3 && pos === 'RB') score -= 22;
      if (c.WR >= 4 && c.RB < 3 && pos === 'WR') score -= 18;
      return score;
    }

    if (round <= 8) {
      if (c.RB < 2 && pos === 'RB') score += 55;
      if (c.WR < 2 && pos === 'WR') score += 55;
      if (c.QB === 0 && pos === 'QB') score += round === 7 ? 27 : 46;
      if (c.TE === 0 && pos === 'TE') score += round === 7 ? 16 : 27;
      if (c.RB < 3 && pos === 'RB') score += 8;
      if (c.WR < 4 && pos === 'WR') score += 8;
      return score;
    }

    if (round <= 10) {
      if (c.QB === 0 && pos === 'QB') score += 75;
      if (c.TE === 0 && pos === 'TE') score += 50;
      if (c.RB < 3 && pos === 'RB') score += 13;
      if (c.WR < 4 && pos === 'WR') score += 11;
      return score;
    }

    if (round <= 14) {
      if (c.QB === 0 && pos === 'QB') score += 100;
      if (c.TE === 0 && pos === 'TE') score += 80;
      if (pos === 'RB') score += c.RB < 5 ? 12 : 3;
      if (pos === 'WR') score += c.WR < 5 ? 9 : 2;
      if ((pos === 'QB' && c.QB >= 1) || (pos === 'TE' && c.TE >= 1)) score -= 24;
      return score;
    }

    return score;
  }

  function scorePlayer(player, roster, round) {
    if (!isEligible(player, roster, round)) return { total: -1e9 };

    const currentPick = PICKS[round - 1];
    const nextPick = PICKS[round] || null;
    const vor = Number.isFinite(Number(player.vor)) ? Number(player.vor) : -30;
    const adp = Number(player.adp);
    const sd = Math.max(1.5, Number(player.sd || 8));
    const marketValue = clamp((currentPick - adp) * 0.28, -10, 10);
    const reachAllowance = Math.max(6, sd * 0.55);
    const reachPenalty = Math.max(0, adp - currentPick - reachAllowance) * 1.05;
    const goneChance = goneBeforeNext(player, currentPick, nextPick);
    const urgency = goneChance * Math.max(8, vor + 20) * 0.085;
    const structure = structureAdjustment(player, roster, round);
    const adjustment = Number(player.adjustment || 0);
    const lateUpside = round >= 10 && (player.pos === 'RB' || player.pos === 'WR')
      ? Math.min(6, sd * 0.18) + Number(player.upside || 0)
      : 0;

    return {
      total: vor + marketValue - reachPenalty + urgency + structure + adjustment + lateUpside,
      vor,
      marketValue,
      reachPenalty,
      urgency,
      structure,
      adjustment,
      lateUpside,
      goneChance
    };
  }

  function rankPlayers(players, blockedIds, roster, round) {
    const currentPick = PICKS[round - 1];
    const blocked = blockedIds instanceof Set ? blockedIds : new Set(blockedIds || []);

    return players
      .filter(player => !blocked.has(player.id))
      .filter(player => isEligible(player, roster, round))
      .filter(player => {
        if (round >= 15) return true;
        if (player.adp <= currentPick) return true;
        const reasonableReach = Math.max(18, Number(player.sd || 8) * 1.5);
        return player.adp <= currentPick + reasonableReach || Number(player.valueRank || 999) <= currentPick + 12;
      })
      .map(player => ({ player, details: scorePlayer(player, roster, round) }))
      .sort((a, b) => b.details.total - a.details.total || a.player.adp - b.player.adp);
  }

  function construction(roster) {
    return roster && roster.length ? roster.map(player => player.pos).join('–') : 'Empty';
  }

  function plan(round, roster) {
    if (round > 16) return 'Draft complete';
    const c = counts(roster);
    if (round === 1) return 'Best elite RB or WR still available';
    if (round === 2) return c.RB ? 'Premium RB2 or an elite WR value' : 'Prioritize your first premium RB';
    if (round <= 4) {
      if (c.RB < 2 && c.WR < 2) return 'Build toward two RBs and two WRs';
      if (c.RB < 2) return 'RB priority unless a major value falls';
      if (c.WR < 2) return 'WR priority unless a major value falls';
      return 'Best RB/WR value; elite QB or TE faller allowed';
    }
    if (round <= 6) {
      if (c.RB < 2 || c.WR < 2) return 'Finish the RB/WR starting core';
      return 'FLEX value with QB/TE now entering the board';
    }
    if (round <= 8) {
      if (c.QB < 1) return 'Secure a starting QB by the end of Round 8';
      if (c.TE < 1) return 'TE or upside RB/WR';
      return 'Add upside RB/WR depth';
    }
    if (round <= 10 && c.TE < 1) return 'Draft a tight end before the tier dries up';
    if (round <= 10 && c.QB < 1) return 'Draft your starting quarterback now';
    if (round < 15) return 'Bench upside: contingent RBs and breakout WRs';
    return round === 15 ? 'Draft a defense' : 'Draft a kicker';
  }

  function reasons(entry, roster, round, index) {
    const player = entry.player;
    const d = entry.details;
    const c = counts(roster);
    const currentPick = PICKS[round - 1];
    const labels = [];

    if (index === 0) labels.push('Best fit');
    if (player.adp <= currentPick - 10) labels.push('Smash faller');
    else if (player.adp < currentPick) labels.push('ADP value');
    if (player.pos === 'RB' && c.RB < 2) labels.push('Fills scarce RB slot');
    if (player.pos === 'WR' && c.WR < 2) labels.push('Fills starting WR slot');
    if (player.pos === 'QB' && c.QB < 1) labels.push('Starting QB');
    if (player.pos === 'TE' && c.TE < 1) labels.push('Starting TE');
    if (d.goneChance >= 0.8 && round < 16) labels.push('Unlikely to return');
    if (Number(player.adjustment || 0) > 0) labels.push('Role boost');
    if (player.status) labels.push(player.status);
    if (!labels.length) labels.push('Best available roster value');

    return labels.slice(0, 4);
  }

  global.DraftEngine = {
    PICKS,
    STARTERS,
    counts,
    construction,
    goneBeforeNext,
    isEligible,
    scorePlayer,
    rankPlayers,
    plan,
    reasons
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
