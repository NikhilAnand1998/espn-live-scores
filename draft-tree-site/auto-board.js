(() => {
  'use strict';

  const Engine = window.DraftEngine;
  const meta = window.draftMeta || {};
  if (!Engine) return;

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function hashString(value) {
    let hash = 2166136261;
    for (const character of String(value)) {
      hash ^= character.charCodeAt(0);
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

  function ensembleRank(player) {
    const explicit = finite(player.ensembleRank);
    if (explicit !== null && explicit > 0) return explicit;
    const values = [
      player.adp,
      player.valueRank,
      player.consensusRank,
      player.rotowireRank,
      player.marketPropRank
    ]
      .map(finite)
      .filter(value => value !== null && value > 0)
      .sort((a, b) => a - b);
    return values.length ? values[Math.floor(values.length / 2)] : 999;
  }

  function expectedDraftSlot(player) {
    const adp = finite(player.adp);
    const rank = ensembleRank(player);
    if (adp === null) return rank;
    return adp * 0.74 + rank * 0.26;
  }

  function latentDraftSlot(player, currentPick, seed) {
    const random = mulberry32(hashString(`${seed}|${player.key}`));
    const expected = expectedDraftSlot(player);
    const sd = Math.max(1.5, finite(player.sd) ?? 8);
    const lower = currentPick + 0.01;
    const observedLate = finite(player.low);
    const upper = Math.max(lower + 1, observedLate ?? expected + sd * 3.25);

    let sampled = null;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const value = expected + normalRandom(random) * sd;
      if (value >= lower) {
        sampled = value;
        break;
      }
    }

    if (sampled === null) {
      sampled = lower
        + (-Math.log(Math.max(0.0001, 1 - random()))) * Math.max(0.8, sd * 0.42);
    }

    return clamp(sampled, lower, upper) + random() * 0.0001;
  }

  function normalizeBlocked(players, blockedValues) {
    const blocked = blockedValues instanceof Set
      ? new Set(blockedValues)
      : new Set(blockedValues || []);

    for (const player of players) {
      if (blocked.has(player.key) || blocked.has(player.id)) {
        blocked.add(player.key);
        blocked.add(player.id);
      }
    }
    return blocked;
  }

  function opponentPoolEligible(player, nextRound) {
    if (!player || player.excluded) return false;
    if (nextRound <= 12 && (player.pos === 'DEF' || player.pos === 'K')) return false;
    return true;
  }

  Engine.predictOpponentPicks = function predictOpponentPicks(
    players,
    blockedValues,
    round,
    options = {}
  ) {
    const currentPick = Engine.PICKS[round - 1];
    const nextPick = Engine.PICKS[round];
    if (!currentPick || !nextPick) {
      return {
        afterRound: round,
        currentPick: currentPick || null,
        nextPick: nextPick || null,
        count: 0,
        rollouts: 0,
        selected: [],
        reserve: []
      };
    }

    const count = Math.max(0, nextPick - currentPick - 1);
    const extra = clamp(Number(options.extra ?? 12), 4, 24);
    const rollouts = clamp(Number(options.rollouts ?? 180), 60, 360);
    const blocked = normalizeBlocked(players, blockedValues);
    const available = players.filter(player =>
      !blocked.has(player.key)
      && !blocked.has(player.id)
      && opponentPoolEligible(player, round + 1)
    );

    const stats = new Map(available.map(player => [player.key, {
      player,
      hits: 0,
      nearHits: 0,
      positionTotal: 0,
      positionSamples: 0
    }]));

    const blockedKey = [...blocked].map(String).sort().join(',');
    const seedRoot = [
      meta.generatedAt || 'data',
      meta.modelVersion || 'model',
      options.seedKey || '',
      round,
      currentPick,
      nextPick,
      blockedKey
    ].join('|');
    const trackingWindow = Math.min(available.length, count + extra * 2);

    for (let rollout = 0; rollout < rollouts; rollout += 1) {
      const rolloutSeed = hashString(`${seedRoot}|auto-board|${rollout}`);
      const ordered = available
        .map(player => ({
          player,
          slot: latentDraftSlot(player, currentPick, rolloutSeed)
        }))
        .sort((first, second) =>
          first.slot - second.slot
          || expectedDraftSlot(first.player) - expectedDraftSlot(second.player)
        );

      for (let index = 0; index < trackingWindow; index += 1) {
        const stat = stats.get(ordered[index].player.key);
        stat.positionTotal += index + 1;
        stat.positionSamples += 1;
        if (index < count) stat.hits += 1;
        if (index < count + extra) stat.nearHits += 1;
      }
    }

    const ranked = [...stats.values()]
      .map(stat => ({
        player: stat.player,
        probability: stat.hits / rollouts,
        nearProbability: stat.nearHits / rollouts,
        averagePosition: stat.positionSamples
          ? stat.positionTotal / stat.positionSamples
          : Number.POSITIVE_INFINITY
      }))
      .sort((first, second) =>
        second.probability - first.probability
        || second.nearProbability - first.nearProbability
        || first.averagePosition - second.averagePosition
        || expectedDraftSlot(first.player) - expectedDraftSlot(second.player)
        || String(first.player.name).localeCompare(String(second.player.name))
      );

    return {
      afterRound: round,
      currentPick,
      nextPick,
      count,
      rollouts,
      selected: ranked.slice(0, count),
      reserve: ranked.slice(count, count + extra)
    };
  };

  Engine.AUTO_BOARD_VERSION = 'auto-board-v1';
  Engine.AUTO_BOARD_LABEL = 'Estimated opponent-pick auto board';
})();
