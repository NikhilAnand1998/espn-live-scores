(() => {
  'use strict';

  const Engine = window.DraftEngine;
  const originalScorePlayer = Engine.scorePlayer;
  const originalReasons = Engine.reasons;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  Engine.scorePlayer = function consensusAdjustedScore(player, roster, round) {
    const base = originalScorePlayer(player, roster, round);
    if (!base || base.total <= -1e8) return base;

    const currentPick = Engine.PICKS[round - 1];
    const consensusRank = Number.isFinite(Number(player.consensusRank))
      ? Number(player.consensusRank)
      : Number(player.adp);
    const valueRank = Number.isFinite(Number(player.valueRank))
      ? Number(player.valueRank)
      : consensusRank;
    const adp = Number(player.adp);
    const sd = Math.max(1.5, Number(player.sd || 8));

    // RotoAlpha supplies exact 14-team VOR; current RotoWire consensus and live
    // exact-format ADP prevent any single projection source from dominating.
    const vorCompression = -0.15 * Number(base.vor || 0);
    const consensusValue = clamp((currentPick - consensusRank) * 1.25, -20, 20);

    // Penalize a player when the exact-format VOR source is dramatically more
    // bullish than current expert consensus. Reward the reverse disagreement
    // more conservatively so true fallers still surface without becoming reaches.
    const bullishOutlierGap = consensusRank - valueRank;
    const outlierPenalty = bullishOutlierGap > 8
      ? Math.min(20, (bullishOutlierGap - 8) * 0.65)
      : 0;
    const consensusUpsideGap = valueRank - consensusRank;
    const consensusBonus = consensusUpsideGap > 12
      ? Math.min(6, (consensusUpsideGap - 12) * 0.25)
      : 0;

    const reachAllowance = round <= 5
      ? Math.max(4, sd * 0.5)
      : Math.max(7, sd * 0.7);
    const additionalReachPenalty = Math.max(0, adp - currentPick - reachAllowance)
      * (round <= 5 ? 1.15 : 0.65);

    const eliteFallerBonus = round >= 3 && round <= 6 && ['QB', 'TE'].includes(player.pos)
      ? clamp((currentPick - consensusRank - 10) * 0.55, 0, 13)
      : 0;

    return {
      ...base,
      total: base.total
        + vorCompression
        + consensusValue
        - outlierPenalty
        + consensusBonus
        - additionalReachPenalty
        + eliteFallerBonus,
      consensusRank,
      consensusValue,
      outlierPenalty,
      consensusBonus,
      additionalReachPenalty,
      eliteFallerBonus
    };
  };

  Engine.rankPlayers = function rankPlayersWithConsensus(players, blockedValues, roster, round) {
    const blocked = blockedValues instanceof Set ? blockedValues : new Set(blockedValues || []);
    const expanded = new Set(blocked);

    for (const player of players) {
      if (blocked.has(player.key) || blocked.has(player.id)) {
        expanded.add(player.key);
        expanded.add(player.id);
      }
    }

    const currentPick = Engine.PICKS[round - 1];
    return players
      .filter(player => !expanded.has(player.key) && !expanded.has(player.id))
      .filter(player => Engine.isEligible(player, roster, round))
      .filter(player => {
        if (round >= 15) return true;
        if (player.adp <= currentPick) return true;
        const sd = Math.max(1.5, Number(player.sd || 8));
        const consensusRank = Number.isFinite(Number(player.consensusRank))
          ? Number(player.consensusRank)
          : Number(player.adp);
        const reasonableReach = Math.max(18, sd * 1.5);
        return player.adp <= currentPick + reasonableReach
          || consensusRank <= currentPick + 12
          || Number(player.valueRank || 999) <= currentPick + 12;
      })
      .map(player => ({ player, details: Engine.scorePlayer(player, roster, round) }))
      .sort((a, b) => b.details.total - a.details.total || a.player.adp - b.player.adp);
  };

  Engine.reasons = function consensusReasons(entry, roster, round, index) {
    const labels = originalReasons(entry, roster, round, index);
    const player = entry.player;
    const currentPick = Engine.PICKS[round - 1];
    const consensusRank = Number(player.consensusRank);

    if (Number.isFinite(consensusRank) && consensusRank <= currentPick - 8) {
      labels.splice(index === 0 ? 1 : 0, 0, 'Expert-rank value');
    }
    if (entry.details.outlierPenalty >= 8) labels.push('Projection disagreement');

    return [...new Set(labels)].slice(0, 4);
  };
})();
