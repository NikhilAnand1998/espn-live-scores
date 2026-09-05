(() => {
  'use strict';

  const Engine = window.DraftEngine;
  const pool = Array.isArray(window.players) ? window.players : [];
  const meta = window.draftMeta || {};
  const originalScorePlayer = Engine.scorePlayer;
  const originalReasons = Engine.reasons;
  const cache = new Map();
  const skillPositions = new Set(['QB', 'RB', 'WR', 'TE']);
  const replacementRank = { QB: 14, RB: 35, WR: 42, TE: 14 };
  const defaultCv = { QB: 0.15, RB: 0.26, WR: 0.23, TE: 0.25, DEF: 0.16, K: 0.14 };

  const finite = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function mulberry32(seed) {
    return function random() {
      let value = seed += 0x6D2B79F5;
      value = Math.imul(value ^ value >>> 15, value | 1);
      value ^= value + Math.imul(value ^ value >>> 7, value | 61);
      return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
  }

  function normalRandom(random) {
    let first = 0;
    let second = 0;
    while (!first) first = random();
    while (!second) second = random();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  }

  function projectedPoints(player) {
    return finite(player.projectionEnsemble) ?? finite(player.projection) ?? 0;
  }

  function projectedFloor(player) {
    const projection = projectedPoints(player);
    const cv = defaultCv[player.pos] ?? 0.24;
    return finite(player.projectionFloor) ?? Math.max(0, projection * (1 - cv * 1.18));
  }

  function projectedCeiling(player) {
    const projection = projectedPoints(player);
    const cv = defaultCv[player.pos] ?? 0.24;
    return finite(player.projectionCeiling) ?? projection * (1 + cv * 1.28);
  }

  function ensembleRank(player) {
    const explicit = finite(player.ensembleRank);
    if (explicit !== null) return explicit;
    const values = [player.adp, player.valueRank, player.consensusRank, player.rotowireRank, player.giqRank]
      .map(finite)
      .filter(value => value !== null)
      .sort((a, b) => a - b);
    if (!values.length) return 999;
    return values[Math.floor(values.length / 2)];
  }

  const replacement = {};
  for (const [position, rank] of Object.entries(replacementRank)) {
    const values = pool
      .filter(player => player.pos === position)
      .map(projectedPoints)
      .filter(Number.isFinite)
      .sort((a, b) => b - a);
    replacement[position] = values[Math.min(rank - 1, values.length - 1)] ?? 0;
  }

  function blendedVor(player) {
    if (!skillPositions.has(player.pos)) return finite(player.vor) ?? 0;
    const projectionVor = projectedPoints(player) - (replacement[player.pos] ?? 0);
    const sourceVor = finite(player.vor);
    return sourceVor === null ? projectionVor : projectionVor * 0.58 + sourceVor * 0.42;
  }

  function rankSpread(player) {
    const explicit = finite(player.rankSpread);
    if (explicit !== null) return explicit;
    const values = [player.adp, player.valueRank, player.consensusRank]
      .map(finite)
      .filter(value => value !== null);
    if (values.length < 2) return 0;
    const average = mean(values);
    return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
  }

  function statusAdjustment(player) {
    let adjustment = finite(player.adjustment) ?? 0;
    if (player.status === 'MONITOR') adjustment -= 1.5;
    if (player.status === 'MINOR') adjustment -= 0.5;
    if (player.status === 'ROLE BOOST') adjustment += finite(player.upside) ?? 0;
    return adjustment;
  }

  function projectionOutlierPenalty(player) {
    const market = finite(player.adp) ?? 999;
    const value = finite(player.valueRank);
    const consensus = finite(player.consensusRank) ?? finite(player.rotowireRank) ?? market;
    if (value === null) return 0;
    const bullishGap = Math.min(market, consensus) - value;
    return bullishGap > 12 ? Math.min(14, (bullishGap - 12) * 0.45) : 0;
  }

  function baseScore(player, roster, round) {
    if (!Engine.isEligible(player, roster, round)) return { total: -1e9, goneChance: 1 };
    const currentPick = Engine.PICKS[round - 1];
    const nextPick = Engine.PICKS[round] || null;
    const original = originalScorePlayer(player, roster, round);
    const rank = ensembleRank(player);
    const vor = blendedVor(player);
    const adp = finite(player.adp) ?? 999;
    const sd = Math.max(1.5, finite(player.sd) ?? 8);
    const goneChance = Engine.goneBeforeNext(player, currentPick, nextPick);
    const rankValue = -0.82 * rank;
    const vorValue = 0.31 * vor;
    const marketValue = clamp((currentPick - adp) * 0.74, -13, 14);
    const urgency = goneChance * (5 + Math.max(0, 38 - rank) * 0.18);
    const structure = (finite(original.structure) ?? 0) * 0.73;
    const reachAllowance = Math.max(4.5, sd * (round <= 5 ? 0.58 : 0.78));
    const reachPenalty = Math.max(0, adp - currentPick - reachAllowance) * (round <= 5 ? 1.05 : 0.62);
    const disagreementPenalty = Math.max(0, rankSpread(player) - 18) * 0.13;
    const outlierPenalty = projectionOutlierPenalty(player);
    const adjustment = statusAdjustment(player);
    const confidenceBonus = (finite(player.modelConfidence) ?? 0.6) * 1.5;

    return {
      total: rankValue + vorValue + marketValue + urgency + structure - reachPenalty
        - disagreementPenalty - outlierPenalty + adjustment + confidenceBonus,
      rank,
      vor,
      marketValue,
      urgency,
      structure,
      reachPenalty,
      disagreementPenalty,
      outlierPenalty,
      adjustment,
      goneChance
    };
  }

  function starterQuality(player) {
    return projectedPoints(player) * 0.58
      + projectedCeiling(player) * 0.22
      + blendedVor(player) * 0.20;
  }

  function starterContribution(player) {
    return blendedVor(player) * 0.52
      + projectedPoints(player) * 0.20
      + projectedFloor(player) * 0.11
      + projectedCeiling(player) * 0.17
      + statusAdjustment(player) * 1.4;
  }

  function benchContribution(player) {
    const upside = finite(player.upside) ?? 0;
    return Math.max(-8, blendedVor(player)) * 0.15
      + projectedCeiling(player) * 0.055
      + upside * 2.2
      + Math.max(0, statusAdjustment(player)) * 0.8;
  }

  function rosterUtility(roster, stageRound) {
    const groups = { QB: [], RB: [], WR: [], TE: [] };
    for (const player of roster) {
      if (groups[player.pos]) groups[player.pos].push(player);
    }
    for (const values of Object.values(groups)) values.sort((a, b) => starterQuality(b) - starterQuality(a));

    const starters = [];
    const used = new Set();
    const take = (position, amount) => {
      for (const player of groups[position].slice(0, amount)) {
        starters.push(player);
        used.add(player.key);
      }
    };
    take('QB', 1);
    take('RB', 2);
    take('WR', 2);
    take('TE', 1);

    const flex = roster
      .filter(player => ['RB', 'WR', 'TE'].includes(player.pos) && !used.has(player.key))
      .sort((a, b) => starterQuality(b) - starterQuality(a))[0];
    if (flex) {
      starters.push(flex);
      used.add(flex.key);
    }

    const bench = roster
      .filter(player => skillPositions.has(player.pos) && !used.has(player.key))
      .sort((a, b) => benchContribution(b) - benchContribution(a));

    let utility = starters.reduce((sum, player) => sum + starterContribution(player), 0);
    utility += bench.slice(0, 5).reduce((sum, player, index) => sum + benchContribution(player) * (0.92 - index * 0.10), 0);

    const counts = Engine.counts(roster);
    const missingRb = Math.max(0, 2 - counts.RB);
    const missingWr = Math.max(0, 2 - counts.WR);
    if (stageRound >= 4) utility -= (missingRb + missingWr) * 27;
    if (stageRound >= 6) utility -= (missingRb + missingWr) * 22;
    if (stageRound >= 7 && counts.QB < 1) utility -= 15;
    if (stageRound >= 8 && counts.QB < 1) utility -= 30;
    if (stageRound >= 8 && counts.TE < 1) utility -= 13;
    if (stageRound >= 10 && counts.TE < 1) utility -= 34;
    if (stageRound >= 10 && counts.QB < 1) utility -= 35;

    if (stageRound >= 4 && counts.RB >= 2 && counts.WR >= 2) utility += 13;
    if (stageRound >= 8 && counts.QB >= 1 && counts.RB >= 2 && counts.WR >= 2) utility += 9;
    if (stageRound <= 7 && counts.RB >= 4 && counts.WR < 3) utility -= 14;
    if (stageRound <= 7 && counts.WR >= 5 && counts.RB < 3) utility -= 11;
    if (stageRound <= 10 && counts.QB > 1) utility -= 28;
    if (stageRound <= 10 && counts.TE > 1) utility -= 18;

    const startingQb = starters.find(player => player.pos === 'QB');
    if (startingQb) {
      const stackPartners = starters.filter(player => ['WR', 'TE'].includes(player.pos) && player.team === startingQb.team).length;
      utility += Math.min(5, stackPartners * 2.5);
    }

    if (stageRound >= 8) {
      const byeCounts = {};
      for (const player of starters) {
        if (!player.bye) continue;
        byeCounts[player.bye] = (byeCounts[player.bye] || 0) + 1;
      }
      for (const count of Object.values(byeCounts)) {
        if (count >= 4) utility -= (count - 3) * 1.8;
      }
    }

    return utility;
  }

  function eligibleAvailable(players, blocked, roster, round) {
    return players.filter(player => !blocked.has(player.key) && !blocked.has(player.id) && Engine.isEligible(player, roster, round));
  }

  function continuationPick(available, roster, round) {
    const entries = available
      .filter(player => Engine.isEligible(player, roster, round))
      .map(player => ({ player, details: baseScore(player, roster, round) }))
      .filter(entry => entry.details.total > -1e8)
      .sort((a, b) => b.details.total - a.details.total || a.player.adp - b.player.adp)
      .slice(0, round <= 8 ? 28 : 22);

    if (!entries.length) return null;
    const before = rosterUtility(roster, Math.max(1, round - 1));
    let best = entries[0].player;
    let bestScore = -Infinity;
    for (const entry of entries) {
      const delta = rosterUtility([...roster, entry.player], round) - before;
      const score = entry.details.total + delta * 0.34;
      if (score > bestScore) {
        bestScore = score;
        best = entry.player;
      }
    }
    return best;
  }

  function latentDraftSlot(player, currentPick, seed) {
    const random = mulberry32(hashString(`${seed}|${player.key}`));
    const adp = finite(player.adp) ?? 250;
    const sd = Math.max(1.5, finite(player.sd) ?? 8);
    const lower = currentPick + 0.01;
    const upper = Math.max(lower + 1, finite(player.low) ?? adp + sd * 3);
    let sampled = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const value = adp + normalRandom(random) * sd;
      if (value >= lower) {
        sampled = value;
        break;
      }
    }
    if (sampled === null) sampled = lower + (-Math.log(Math.max(0.0001, 1 - random()))) * Math.max(0.8, sd * 0.42);
    return clamp(sampled, lower, upper) + random() * 0.0001;
  }

  function buildBoardOrders(available, currentPick, rolloutCount, seed) {
    const orders = [];
    for (let index = 0; index < rolloutCount; index += 1) {
      const rolloutSeed = hashString(`${seed}|rollout|${index}`);
      orders.push(available
        .map(player => ({ key: player.key, slot: latentDraftSlot(player, currentPick, rolloutSeed) }))
        .sort((a, b) => a.slot - b.slot)
        .map(item => item.key));
    }
    return orders;
  }

  function percentile(sorted, probability) {
    if (!sorted.length) return 0;
    const index = clamp(Math.floor((sorted.length - 1) * probability), 0, sorted.length - 1);
    return sorted[index];
  }

  function rolloutSettings(round) {
    if (round <= 2) return { rollouts: 84, horizon: 3, candidates: 16 };
    if (round <= 4) return { rollouts: 72, horizon: 2, candidates: 14 };
    if (round <= 6) return { rollouts: 58, horizon: 2, candidates: 13 };
    if (round <= 8) return { rollouts: 44, horizon: 1, candidates: 12 };
    if (round <= 12) return { rollouts: 30, horizon: 1, candidates: 11 };
    return { rollouts: 18, horizon: 1, candidates: 10 };
  }

  function optimizeCandidates(available, roster, round, cacheKey) {
    const settings = rolloutSettings(round);
    const baseEntries = available
      .map(player => ({ player, details: baseScore(player, roster, round) }))
      .filter(entry => entry.details.total > -1e8)
      .sort((a, b) => b.details.total - a.details.total || a.player.adp - b.player.adp);

    const shortlist = baseEntries.slice(0, settings.candidates);
    if (round >= 15 || shortlist.length <= 1) {
      return baseEntries.map((entry, index) => ({
        ...entry,
        details: {
          ...entry.details,
          objective: rosterUtility([...roster, entry.player], round),
          optimized: false,
          rollouts: 0,
          horizon: 0,
          commonNextPositions: '',
          confidence: index === 0 ? 'High' : ''
        }
      }));
    }

    const currentPick = Engine.PICKS[round - 1];
    const byKey = new Map(available.map(player => [player.key, player]));
    const boardOrders = buildBoardOrders(available, currentPick, settings.rollouts, cacheKey);
    const optimized = [];

    for (const entry of shortlist) {
      const values = [];
      const nextPaths = new Map();
      for (let rollout = 0; rollout < boardOrders.length; rollout += 1) {
        const remaining = new Set(available.map(player => player.key));
        remaining.delete(entry.player.key);
        const simulatedRoster = [...roster, entry.player];
        const order = boardOrders[rollout];
        let cursor = 0;
        const path = [];
        let previousRound = round;

        for (let step = 1; step <= settings.horizon && previousRound + 1 <= 16; step += 1) {
          const nextRound = previousRound + 1;
          const gap = Math.max(0, Engine.PICKS[nextRound - 1] - Engine.PICKS[previousRound - 1] - 1);
          let removed = 0;
          while (cursor < order.length && removed < gap) {
            const key = order[cursor++];
            if (!remaining.has(key)) continue;
            remaining.delete(key);
            removed += 1;
          }

          const availableAtTurn = [...remaining].map(key => byKey.get(key)).filter(Boolean);
          const choice = continuationPick(availableAtTurn, simulatedRoster, nextRound);
          if (!choice) break;
          simulatedRoster.push(choice);
          remaining.delete(choice.key);
          path.push(choice.pos);
          previousRound = nextRound;
        }

        const stageRound = round + path.length;
        values.push(rosterUtility(simulatedRoster, stageRound));
        const pathKey = path.join(' → ') || 'Draft complete';
        nextPaths.set(pathKey, (nextPaths.get(pathKey) || 0) + 1);
      }

      values.sort((a, b) => a - b);
      const average = mean(values);
      const floorValue = percentile(values, 0.25);
      const ceilingValue = percentile(values, 0.75);
      const variance = mean(values.map(value => (value - average) ** 2));
      const objective = average * 0.74 + floorValue * 0.16 + ceilingValue * 0.10 + entry.details.total * 0.08;
      const commonPath = [...nextPaths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';

      optimized.push({
        player: entry.player,
        details: {
          ...entry.details,
          optimized: true,
          objective,
          rolloutMean: average,
          rolloutFloor: floorValue,
          rolloutCeiling: ceilingValue,
          rolloutStd: Math.sqrt(variance),
          rollouts: settings.rollouts,
          horizon: settings.horizon,
          commonNextPositions: commonPath
        }
      });
    }

    optimized.sort((a, b) => b.details.objective - a.details.objective || b.details.total - a.details.total);
    const topObjective = optimized[0]?.details.objective ?? 0;
    const secondObjective = optimized[1]?.details.objective ?? topObjective;
    for (let index = 0; index < optimized.length; index += 1) {
      const details = optimized[index].details;
      details.behindTop = Math.max(0, topObjective - details.objective);
      details.edge = index === 0 ? Math.max(0, topObjective - secondObjective) : 0;
      if (index === 0) {
        const standardError = details.rolloutStd / Math.sqrt(Math.max(1, details.rollouts));
        details.confidence = details.edge >= Math.max(5, standardError * 2.2)
          ? 'High'
          : details.edge >= Math.max(1.8, standardError * 1.2)
            ? 'Medium'
            : 'Close call';
      } else {
        details.confidence = details.behindTop <= 2.5 ? 'Close alternative' : '';
      }
    }

    const optimizedKeys = new Set(optimized.map(entry => entry.player.key));
    const remainder = baseEntries
      .filter(entry => !optimizedKeys.has(entry.player.key))
      .map(entry => ({
        ...entry,
        details: {
          ...entry.details,
          objective: entry.details.total,
          optimized: false,
          rollouts: 0,
          horizon: 0,
          commonNextPositions: '',
          behindTop: Math.max(0, topObjective - entry.details.total),
          confidence: ''
        }
      }));
    return [...optimized, ...remainder];
  }

  Engine.scorePlayer = function optimizedBaseScore(player, roster, round) {
    return baseScore(player, roster, round);
  };

  Engine.rankPlayers = function optimizedRankPlayers(players, blockedValues, roster, round) {
    const blocked = blockedValues instanceof Set ? new Set(blockedValues) : new Set(blockedValues || []);
    for (const player of players) {
      if (blocked.has(player.key) || blocked.has(player.id)) {
        blocked.add(player.key);
        blocked.add(player.id);
      }
    }

    const currentPick = Engine.PICKS[round - 1];
    const available = eligibleAvailable(players, blocked, roster, round)
      .filter(player => {
        if (round >= 15) return true;
        const adp = finite(player.adp) ?? 999;
        const sd = Math.max(1.5, finite(player.sd) ?? 8);
        const rank = ensembleRank(player);
        if (adp <= currentPick || rank <= currentPick + 14) return true;
        return adp <= currentPick + Math.max(22, sd * 1.7);
      });

    const blockedKey = [...blocked].map(String).sort().join(',');
    const rosterKey = roster.map(player => player.key).join('>');
    const cacheKey = `${meta.generatedAt || 'data'}|${meta.modelVersion || 'model'}|${round}|${rosterKey}|${blockedKey}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const result = optimizeCandidates(available, roster, round, cacheKey);
    cache.set(cacheKey, result);
    if (cache.size > 24) cache.delete(cache.keys().next().value);
    return result;
  };

  Engine.reasons = function optimizedReasons(entry, roster, round, index) {
    const labels = originalReasons(entry, roster, round, index);
    const details = entry.details || {};
    const player = entry.player;

    if (details.optimized && index === 0) labels.unshift(`${details.horizon}-turn lookahead`);
    if (details.confidence === 'High') labels.push('Clear simulated edge');
    else if (details.confidence === 'Medium') labels.push('Moderate simulated edge');
    else if (details.confidence === 'Close call' || details.confidence === 'Close alternative') labels.push('Close call');
    if (details.commonNextPositions) labels.push(`Next: ${details.commonNextPositions}`);
    if (rankSpread(player) >= 18) labels.push('Model disagreement');

    return [...new Set(labels)].slice(0, 4);
  };

  Engine.MODEL_VERSION = 'ensemble-rollout-v3';
  Engine.MODEL_LABEL = 'Deterministic Monte Carlo lookahead';
  Engine.REPLACEMENT_POINTS = replacement;
  Engine.clearOptimizationCache = () => cache.clear();
})();
