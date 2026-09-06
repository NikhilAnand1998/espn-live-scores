import fs from 'node:fs';
import vm from 'node:vm';

const [dataPath, enginePath, availabilityPath, outputPath] = process.argv.slice(2);
if (!dataPath || !enginePath || !availabilityPath || !outputPath) {
  throw new Error('Usage: node generate-best-simulated-drafts.mjs <data.js> <engine.js> <availability.js> <output.js>');
}

const ROOMS = Math.max(250, Number(process.env.SIMULATION_ROOMS || 5000));
const MASTER_SEED = Number(process.env.SIMULATION_SEED || 20260906);
const KEEP_PER_STRATEGY = 18;
const KEEP_OVERALL = 100;
const DISPLAY_PER_STRATEGY = 3;
const DISPLAY_OVERALL = 12;

const sandbox = {
  console,
  Math,
  Date,
  JSON,
  Set,
  Map,
  Number,
  String,
  Array,
  Object,
  Boolean,
  performance: { now: () => Date.now() }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const path of [dataPath, enginePath, availabilityPath]) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), sandbox, { filename: path });
}

const players = Array.from(sandbox.players || []).filter(player => !player.excluded);
const meta = sandbox.draftMeta || {};
const Engine = sandbox.DraftEngine;
const Availability = sandbox.DraftAvailability;
if (!Engine || !Availability || players.length < 180) {
  throw new Error(`Incomplete simulation inputs: engine=${Boolean(Engine)} availability=${Boolean(Availability)} players=${players.length}`);
}

const PICKS = Array.from(Engine.PICKS);
const ROUNDS = PICKS.length;
const positions = ['QB', 'RB', 'WR', 'TE', 'DEF', 'K'];
const skillPositions = new Set(['QB', 'RB', 'WR', 'TE']);
const flexPositions = new Set(['RB', 'WR', 'TE']);

const STRATEGIES = [
  {
    id: 'balanced',
    label: 'Balanced value',
    shortLabel: 'Balanced',
    description: 'Takes the strongest risk-adjusted value while completing two RBs, two WRs, FLEX, QB, and TE on schedule.'
  },
  {
    id: 'hero_rb',
    label: 'Hero RB',
    shortLabel: 'Hero RB',
    description: 'Builds around one premium early running back, attacks wide receiver depth, then adds RB2 in the middle rounds.'
  },
  {
    id: 'robust_rb',
    label: 'Robust RB',
    shortLabel: 'Robust RB',
    description: 'Prioritizes two early running backs and often a third before shifting aggressively toward wide receiver.'
  },
  {
    id: 'wr_avalanche',
    label: 'WR avalanche',
    shortLabel: 'WR heavy',
    description: 'Loads up on three early receivers, then uses the middle rounds to solve both starting running-back spots.'
  },
  {
    id: 'elite_te',
    label: 'Elite TE',
    shortLabel: 'Elite TE',
    description: 'Starts with RB/WR value, then targets a difference-making tight end near the Round 3–5 tier break.'
  },
  {
    id: 'elite_qb',
    label: 'Elite QB',
    shortLabel: 'Elite QB',
    description: 'Builds an early skill-position base and targets a top-five quarterback when the Round 3–5 price is justified.'
  },
  {
    id: 'late_qb',
    label: 'Late QB',
    shortLabel: 'Late QB',
    description: 'Pushes quarterback into Rounds 8–10 so the first seven picks can concentrate on RB, WR, FLEX, and TE.'
  }
];

const SCENARIOS = [
  { id: 'balanced', label: 'Balanced room', shifts: {}, volatility: 1 },
  { id: 'balanced_2', label: 'Balanced room', shifts: {}, volatility: 0.92 },
  { id: 'rb_run', label: 'RB-heavy room', shifts: { RB: -5.5 }, volatility: 1.02 },
  { id: 'wr_run', label: 'WR-heavy room', shifts: { WR: -5.5 }, volatility: 1.02 },
  { id: 'qb_push', label: 'Early-QB room', shifts: { QB: -7.5 }, volatility: 1.04 },
  { id: 'te_push', label: 'Early-TE room', shifts: { TE: -7 }, volatility: 1.04 },
  { id: 'volatile', label: 'Volatile room', shifts: {}, volatility: 1.45 }
];

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.floor((sorted.length - 1) * probability), 0, sorted.length - 1);
  return sorted[index];
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

function counts(roster) {
  const result = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0, K: 0 };
  for (const player of roster) {
    if (Object.prototype.hasOwnProperty.call(result, player.pos)) result[player.pos] += 1;
  }
  return result;
}

function projection(player) {
  return finite(player.projectionEnsemble, finite(player.projection, 0));
}

function floorProjection(player) {
  const expected = projection(player);
  const cv = { QB: 0.15, RB: 0.26, WR: 0.23, TE: 0.25, DEF: 0.16, K: 0.14 }[player.pos] || 0.24;
  return finite(player.projectionFloor, Math.max(0, expected * (1 - cv * 1.18)));
}

function ceilingProjection(player) {
  const expected = projection(player);
  const cv = { QB: 0.15, RB: 0.26, WR: 0.23, TE: 0.25, DEF: 0.16, K: 0.14 }[player.pos] || 0.24;
  return finite(player.projectionCeiling, expected * (1 + cv * 1.28));
}

function ensembleRank(player) {
  const explicit = finite(player.ensembleRank);
  if (explicit !== null) return explicit;
  const ranks = [player.adp, player.valueRank, player.consensusRank, player.rotowireRank]
    .map(value => finite(value))
    .filter(value => value !== null)
    .sort((a, b) => a - b);
  return ranks.length ? ranks[Math.floor(ranks.length / 2)] : 999;
}

const replacementRank = { QB: 14, RB: 35, WR: 42, TE: 14 };
const replacement = {};
for (const [position, rank] of Object.entries(replacementRank)) {
  const values = players
    .filter(player => player.pos === position)
    .map(projection)
    .sort((a, b) => b - a);
  replacement[position] = values[Math.min(rank - 1, values.length - 1)] || 0;
}

const metrics = new Map();
for (const player of players) {
  const expected = projection(player);
  const floor = floorProjection(player);
  const ceiling = ceilingProjection(player);
  const projectionVor = skillPositions.has(player.pos) ? expected - (replacement[player.pos] || 0) : finite(player.vor, 0);
  const sourceVor = finite(player.vor, projectionVor);
  const blendedVor = skillPositions.has(player.pos) ? projectionVor * 0.58 + sourceVor * 0.42 : sourceVor;
  metrics.set(player.key, {
    expected,
    floor,
    ceiling,
    rank: ensembleRank(player),
    vor: blendedVor,
    confidence: finite(player.modelConfidence, 0.62),
    upsideDelta: Math.max(0, ceiling - expected),
    floorDelta: Math.max(0, expected - floor)
  });
}

function goneBeforeNext(player, round) {
  const currentPick = PICKS[round - 1];
  const nextPick = PICKS[round];
  if (!nextPick) return 1;
  const currentAvailable = Availability.probabilityAtPick(player, currentPick);
  const nextAvailable = Availability.probabilityAtPick(player, nextPick);
  return clamp((currentAvailable - nextAvailable) / Math.max(0.001, currentAvailable), 0, 1);
}

const roundBase = new Map();
for (const player of players) {
  const metric = metrics.get(player.key);
  const values = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const pick = PICKS[round - 1];
    const adp = finite(player.adp, 250);
    const sd = Math.max(1.5, finite(player.sd, 8));
    const marketValue = clamp((pick - adp) * 0.70, -13, 14);
    const reachAllowance = Math.max(4.5, sd * (round <= 5 ? 0.60 : 0.80));
    const reachPenalty = Math.max(0, adp - pick - reachAllowance) * (round <= 5 ? 1.02 : 0.62);
    const urgency = goneBeforeNext(player, round) * (5 + Math.max(0, 38 - metric.rank) * 0.18);
    const statusAdjustment = finite(player.adjustment, 0)
      + (player.status === 'ROLE BOOST' ? finite(player.upside, 0) : 0)
      - (player.status === 'MONITOR' ? 1.5 : 0)
      - (player.status === 'MINOR' ? 0.5 : 0);
    values.push(
      -0.82 * metric.rank
      + 0.31 * metric.vor
      + marketValue
      + urgency
      - reachPenalty
      + statusAdjustment
      + metric.confidence * 1.5
    );
  }
  roundBase.set(player.key, values);
}

function isEligible(player, c, round) {
  if (!player) return false;
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

function structureAdjustment(player, c, round) {
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
  }
  return score;
}

function strategyAdjustment(strategyId, player, c, round) {
  const pos = player.pos;
  const posRank = finite(player.posRank, 99);
  let score = 0;

  if (strategyId === 'balanced') return 0;

  if (strategyId === 'hero_rb') {
    if (round === 1) score += pos === 'RB' ? 38 : -18;
    if (round >= 2 && round <= 5) {
      if (pos === 'WR' && c.WR < 3) score += 22;
      if (pos === 'RB' && c.RB >= 1) score -= 14;
    }
    if (round >= 6 && round <= 8 && c.RB < 2 && pos === 'RB') score += 38;
    if (round <= 7 && pos === 'QB') score -= 12;
    return score;
  }

  if (strategyId === 'robust_rb') {
    if (round <= 3 && c.RB < 2 && pos === 'RB') score += 30;
    if (round <= 3 && c.RB === 0 && pos === 'WR') score -= 9;
    if (round >= 3 && c.RB >= 2 && c.WR < 2 && pos === 'WR') score += 25;
    if (round >= 4 && round <= 6 && c.RB < 3 && pos === 'RB') score += 9;
    if (round <= 6 && c.RB >= 3 && pos === 'RB') score -= 18;
    return score;
  }

  if (strategyId === 'wr_avalanche') {
    if (round <= 4 && c.WR < 3 && pos === 'WR') score += 31;
    if (round <= 3 && c.WR < 2 && pos === 'RB') score -= 12;
    if (round >= 4 && round <= 7 && c.RB < 2 && pos === 'RB') score += 38;
    if (round <= 6 && c.WR >= 4 && pos === 'WR') score -= 18;
    return score;
  }

  if (strategyId === 'elite_te') {
    if (round >= 3 && round <= 5 && c.TE === 0 && pos === 'TE') {
      score += posRank <= 2 ? 40 : posRank <= 4 ? 31 : 12;
    }
    if (round === 2 && pos === 'TE') score -= 12;
    if (round >= 6 && c.TE === 0 && pos === 'TE') score += 18;
    return score;
  }

  if (strategyId === 'elite_qb') {
    if (round >= 3 && round <= 5 && c.QB === 0 && pos === 'QB') {
      score += posRank <= 2 ? 41 : posRank <= 5 ? 32 : 12;
    }
    if (round >= 6 && c.QB === 0 && pos === 'QB') score += 18;
    if (round <= 2 && pos === 'QB') score -= 100;
    return score;
  }

  if (strategyId === 'late_qb') {
    if (round <= 7 && pos === 'QB') score -= 46;
    if (round <= 7 && (pos === 'RB' || pos === 'WR')) score += 6;
    if (round >= 8 && round <= 10 && c.QB === 0 && pos === 'QB') score += 58;
    if (round >= 11 && c.QB === 0 && pos === 'QB') score += 85;
    return score;
  }

  return score;
}

function chooseUser(strategy, available, roster, round, random, riskTolerance) {
  const pick = PICKS[round - 1];
  const rosterCounts = counts(roster);
  let best = null;
  let bestScore = -Infinity;
  const finalists = [];

  for (const player of players) {
    if (!available.has(player.key) || !isEligible(player, rosterCounts, round)) continue;
    const adp = finite(player.adp, 250);
    const sd = Math.max(1.5, finite(player.sd, 8));
    const rank = metrics.get(player.key).rank;
    if (round < 15 && adp > pick + Math.max(22, sd * 1.7) && rank > pick + 14) continue;

    const metric = metrics.get(player.key);
    const profileTilt = (riskTolerance - 0.5) * metric.upsideDelta * 0.025
      - (0.5 - riskTolerance) * metric.floorDelta * 0.018;
    const jitter = (random() - 0.5) * 1.6;
    const score = roundBase.get(player.key)[round - 1]
      + structureAdjustment(player, rosterCounts, round) * 0.73
      + strategyAdjustment(strategy.id, player, rosterCounts, round)
      + profileTilt
      + jitter;

    if (score > bestScore) {
      bestScore = score;
      best = player;
    }
    finalists.push({ player, score });
  }

  if (!best) return null;
  finalists.sort((a, b) => b.score - a.score || finite(a.player.adp, 999) - finite(b.player.adp, 999));

  if (finalists.length > 1 && random() < 0.12) {
    const close = finalists.filter(entry => finalists[0].score - entry.score <= 3.3).slice(0, 3);
    if (close.length > 1) {
      const weights = close.map(entry => Math.exp((entry.score - close[0].score) / 2.2));
      const total = weights.reduce((sum, value) => sum + value, 0);
      let draw = random() * total;
      for (let index = 0; index < close.length; index += 1) {
        draw -= weights[index];
        if (draw <= 0) return close[index].player;
      }
    }
  }
  return best;
}

function buildBoard(roomIndex, scenario) {
  const random = mulberry32(hashString(`${MASTER_SEED}|board|${roomIndex}|${scenario.id}`));
  const board = players.map(player => {
    const adp = finite(player.adp, 250);
    const sd = Math.max(1.5, finite(player.sd, 8));
    const shift = finite(scenario.shifts[player.pos], 0) * (adp <= 95 ? 1 : 0.35);
    const early = finite(player.high, 1);
    const late = Math.max(early + 0.1, finite(player.low, adp + 35));
    const sampled = adp + shift + normalRandom(random) * sd * scenario.volatility;
    return {
      player,
      slot: clamp(sampled, early, late) + random() * 0.0001
    };
  }).sort((a, b) => a.slot - b.slot);
  return board;
}

function reserveSpecialist(board, position) {
  for (let index = board.length - 1; index >= 0; index -= 1) {
    if (board[index].player.pos === position) return board[index].player.key;
  }
  return null;
}

function simulateStrategy(strategy, roomIndex, scenario, board) {
  const available = new Set(players.map(player => player.key));
  const roster = [];
  const selections = [];
  const random = mulberry32(hashString(`${MASTER_SEED}|decision|${roomIndex}|${strategy.id}`));
  const riskTolerance = 0.22 + random() * 0.68;
  const reserved = new Set([
    reserveSpecialist(board, 'DEF'),
    reserveSpecialist(board, 'K')
  ].filter(Boolean));
  let cursor = 0;

  for (let overall = 1; overall <= PICKS.at(-1); overall += 1) {
    const userRoundIndex = PICKS.indexOf(overall);
    if (userRoundIndex >= 0) {
      const round = userRoundIndex + 1;
      let selected = chooseUser(strategy, available, roster, round, random, riskTolerance);
      if (!selected) {
        const fallbackCounts = counts(roster);
        selected = players
          .filter(player => available.has(player.key) && isEligible(player, fallbackCounts, round))
          .sort((a, b) => metrics.get(a.key).rank - metrics.get(b.key).rank)[0] || null;
      }
      if (!selected) throw new Error(`No selection for ${strategy.id}, room ${roomIndex}, round ${round}`);
      roster.push(selected);
      available.delete(selected.key);
      selections.push({
        round,
        overall,
        player: selected,
        availability: Availability.probabilityAtPick(selected, overall)
      });
      continue;
    }

    while (cursor < board.length) {
      const candidate = board[cursor++].player;
      if (!available.has(candidate.key)) continue;
      if (reserved.has(candidate.key)) continue;
      available.delete(candidate.key);
      break;
    }
  }

  return { roster, selections, riskTolerance };
}

function starterQuality(player) {
  const metric = metrics.get(player.key);
  return metric.expected * 0.62 + metric.floor * 0.20 + metric.ceiling * 0.18;
}

function allocateLineup(roster) {
  const grouped = Object.fromEntries(positions.map(position => [position, []]));
  for (const player of roster) grouped[player.pos]?.push(player);
  for (const group of Object.values(grouped)) group.sort((a, b) => starterQuality(b) - starterQuality(a));

  const used = new Set();
  const starters = [];
  const add = (position, amount, labels) => {
    grouped[position].slice(0, amount).forEach((player, index) => {
      used.add(player.key);
      starters.push({ player, role: labels[index] || position });
    });
  };
  add('QB', 1, ['QB']);
  add('RB', 2, ['RB1', 'RB2']);
  add('WR', 2, ['WR1', 'WR2']);
  add('TE', 1, ['TE']);
  const flex = roster
    .filter(player => flexPositions.has(player.pos) && !used.has(player.key))
    .sort((a, b) => starterQuality(b) - starterQuality(a))[0];
  if (flex) {
    used.add(flex.key);
    starters.push({ player: flex, role: 'FLEX' });
  }
  add('DEF', 1, ['DEF']);
  add('K', 1, ['K']);

  const bench = roster
    .filter(player => !used.has(player.key))
    .sort((a, b) => starterQuality(b) - starterQuality(a));
  return { starters, bench };
}

function scoreDraft(strategy, roomIndex, scenario, simulation) {
  const { roster, selections } = simulation;
  const allocation = allocateLineup(roster);
  const expectedStarter = allocation.starters.reduce((sum, item) => sum + metrics.get(item.player.key).expected, 0);
  const floorStarter = allocation.starters.reduce((sum, item) => sum + metrics.get(item.player.key).floor, 0);
  const ceilingStarter = allocation.starters.reduce((sum, item) => sum + metrics.get(item.player.key).ceiling, 0);
  const benchWeights = [0.060, 0.050, 0.041, 0.033, 0.026, 0.020, 0.015];
  const benchValue = allocation.bench.slice(0, benchWeights.length).reduce((sum, player, index) => {
    const metric = metrics.get(player.key);
    return sum + Math.max(0, metric.expected - (replacement[player.pos] || 0) * 0.82) * benchWeights[index]
      + metric.ceiling * benchWeights[index] * 0.16;
  }, 0);

  const c = counts(roster);
  const complete = c.QB >= 1 && c.RB >= 2 && c.WR >= 2 && c.TE >= 1 && c.DEF >= 1 && c.K >= 1;
  const probabilities = selections
    .filter(selection => selection.round <= 14)
    .map(selection => clamp(selection.availability, 0.01, 0.99));
  const plausibility = probabilities.length
    ? Math.exp(mean(probabilities.map(value => Math.log(value))))
    : 0;
  const longShotCount = probabilities.filter(value => value < 0.10).length;
  const fallerCount = probabilities.filter(value => value < 0.30).length;
  const reachCount = selections.filter(selection => {
    const player = selection.player;
    const allowance = Math.max(7, finite(player.sd, 8) * 0.62);
    return finite(player.adp, 999) - selection.overall > allowance;
  }).length;
  const reachPenalty = selections.reduce((sum, selection) => {
    const player = selection.player;
    const allowance = Math.max(7, finite(player.sd, 8) * 0.62);
    return sum + Math.max(0, finite(player.adp, 999) - selection.overall - allowance) * 1.25;
  }, 0);
  const realismPenalty = Math.max(0, 0.30 - plausibility) * 65
    + longShotCount * 9
    + probabilities.filter(value => value < 0.03).length * 8;
  const completenessPenalty = complete ? 0 : 180;
  const riskAdjusted = expectedStarter * 0.62 + floorStarter * 0.23 + ceilingStarter * 0.15 + benchValue;
  const modelScore = riskAdjusted - reachPenalty - realismPenalty - completenessPenalty;
  const realism = plausibility >= 0.43 && longShotCount === 0
    ? 'Realistic'
    : plausibility >= 0.30 && longShotCount <= 1
      ? 'Aggressive'
      : 'Dream outcome';
  const opening = selections.slice(0, 6).map(selection => selection.player.pos).join('-');
  const rosterKey = selections.map(selection => selection.player.key).join('>');

  const roleByKey = new Map(allocation.starters.map(item => [item.player.key, item.role]));
  allocation.bench.forEach((player, index) => roleByKey.set(player.key, `BN${index + 1}`));

  return {
    id: `${strategy.id}-${roomIndex}`,
    rosterKey,
    strategy: strategy.id,
    strategyLabel: strategy.label,
    scenario: scenario.id,
    scenarioLabel: scenario.label,
    modelScore,
    riskAdjusted,
    expectedStarter,
    floorStarter,
    ceilingStarter,
    weeklyExpected: expectedStarter / 17,
    weeklyFloor: floorStarter / 17,
    weeklyCeiling: ceilingStarter / 17,
    benchValue,
    plausibility,
    realism,
    longShotCount,
    fallerCount,
    reachCount,
    complete,
    opening,
    picks: selections.map(selection => {
      const player = selection.player;
      return {
        round: selection.round,
        overall: selection.overall,
        name: player.name,
        pos: player.pos,
        team: player.team || '',
        bye: player.bye || null,
        adp: finite(player.adp, null),
        availability: selection.availability,
        role: roleByKey.get(player.key) || 'BN'
      };
    })
  };
}

function insertTop(list, draft, limit) {
  const existing = list.findIndex(item => item.rosterKey === draft.rosterKey);
  if (existing >= 0) {
    if (list[existing].modelScore >= draft.modelScore) return;
    list.splice(existing, 1);
  }
  list.push(draft);
  list.sort((a, b) => b.modelScore - a.modelScore || b.expectedStarter - a.expectedStarter);
  if (list.length > limit) list.length = limit;
}

function similarity(first, second) {
  const firstKeys = new Set(first.picks.map(pick => `${pick.name}|${pick.pos}`));
  const secondKeys = new Set(second.picks.map(pick => `${pick.name}|${pick.pos}`));
  let shared = 0;
  for (const key of firstKeys) if (secondKeys.has(key)) shared += 1;
  return shared / Math.max(firstKeys.size, secondKeys.size, 1);
}

function diverseTop(list, amount, maxPerStrategy = Infinity) {
  const selected = [];
  const strategyCounts = new Map();
  for (const draft of list) {
    if ((strategyCounts.get(draft.strategy) || 0) >= maxPerStrategy) continue;
    if (selected.some(existing => similarity(existing, draft) >= 0.875)) continue;
    selected.push(draft);
    strategyCounts.set(draft.strategy, (strategyCounts.get(draft.strategy) || 0) + 1);
    if (selected.length >= amount) break;
  }
  if (selected.length < amount) {
    for (const draft of list) {
      if (selected.some(existing => existing.rosterKey === draft.rosterKey)) continue;
      selected.push(draft);
      if (selected.length >= amount) break;
    }
  }
  return selected;
}

const aggregate = Object.fromEntries(STRATEGIES.map(strategy => [strategy.id, {
  scores: [],
  expected: [],
  plausibility: [],
  ranks: [],
  wins: 0,
  topThree: 0,
  openings: new Map(),
  top: []
}]));
const overallTop = [];
const globalScores = [];
const startedAt = Date.now();

for (let roomIndex = 0; roomIndex < ROOMS; roomIndex += 1) {
  const scenario = SCENARIOS[roomIndex % SCENARIOS.length];
  const board = buildBoard(roomIndex, scenario);
  const roomResults = [];

  for (const strategy of STRATEGIES) {
    const simulation = simulateStrategy(strategy, roomIndex, scenario, board);
    const draft = scoreDraft(strategy, roomIndex, scenario, simulation);
    const stats = aggregate[strategy.id];
    stats.scores.push(draft.modelScore);
    stats.expected.push(draft.expectedStarter);
    stats.plausibility.push(draft.plausibility);
    stats.openings.set(draft.opening, (stats.openings.get(draft.opening) || 0) + 1);
    insertTop(stats.top, draft, KEEP_PER_STRATEGY);
    insertTop(overallTop, draft, KEEP_OVERALL);
    globalScores.push(draft.modelScore);
    roomResults.push(draft);
  }

  roomResults.sort((a, b) => b.modelScore - a.modelScore);
  roomResults.forEach((draft, index) => {
    aggregate[draft.strategy].ranks.push(index + 1);
    if (index === 0) aggregate[draft.strategy].wins += 1;
    if (index < 3) aggregate[draft.strategy].topThree += 1;
  });

  if ((roomIndex + 1) % 500 === 0 || roomIndex + 1 === ROOMS) {
    console.log(`Simulated ${roomIndex + 1}/${ROOMS} rooms (${(roomIndex + 1) * STRATEGIES.length} completed strategy drafts)`);
  }
}

globalScores.sort((a, b) => a - b);
function scorePercentile(score) {
  let low = 0;
  let high = globalScores.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (globalScores[middle] <= score) low = middle + 1;
    else high = middle;
  }
  return low / Math.max(1, globalScores.length);
}

function cleanDraft(draft) {
  return {
    id: draft.id,
    strategy: draft.strategy,
    strategyLabel: draft.strategyLabel,
    scenario: draft.scenario,
    scenarioLabel: draft.scenarioLabel,
    modelScore: Number(draft.modelScore.toFixed(1)),
    percentile: Number((scorePercentile(draft.modelScore) * 100).toFixed(1)),
    expectedStarter: Number(draft.expectedStarter.toFixed(1)),
    floorStarter: Number(draft.floorStarter.toFixed(1)),
    ceilingStarter: Number(draft.ceilingStarter.toFixed(1)),
    weeklyExpected: Number(draft.weeklyExpected.toFixed(1)),
    weeklyFloor: Number(draft.weeklyFloor.toFixed(1)),
    weeklyCeiling: Number(draft.weeklyCeiling.toFixed(1)),
    benchValue: Number(draft.benchValue.toFixed(1)),
    plausibility: Number((draft.plausibility * 100).toFixed(1)),
    realism: draft.realism,
    longShotCount: draft.longShotCount,
    fallerCount: draft.fallerCount,
    reachCount: draft.reachCount,
    opening: draft.opening,
    picks: draft.picks.map(pick => ({
      ...pick,
      adp: pick.adp === null ? null : Number(pick.adp.toFixed(1)),
      availability: Number((pick.availability * 100).toFixed(1))
    }))
  };
}

const strategySummary = STRATEGIES.map(strategy => {
  const stats = aggregate[strategy.id];
  const commonOpenings = [...stats.openings.entries()]
    .map(([opening, count]) => ({ opening, count, rate: count / ROOMS }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    id: strategy.id,
    label: strategy.label,
    shortLabel: strategy.shortLabel,
    description: strategy.description,
    drafts: ROOMS,
    meanScore: Number(mean(stats.scores).toFixed(1)),
    medianScore: Number(percentile(stats.scores, 0.5).toFixed(1)),
    p90Score: Number(percentile(stats.scores, 0.9).toFixed(1)),
    bestScore: Number(Math.max(...stats.scores).toFixed(1)),
    averageExpectedStarter: Number(mean(stats.expected).toFixed(1)),
    averageWeeklyStarter: Number((mean(stats.expected) / 17).toFixed(1)),
    averagePlausibility: Number((mean(stats.plausibility) * 100).toFixed(1)),
    averageRank: Number(mean(stats.ranks).toFixed(2)),
    bestInRoomRate: Number((stats.wins / ROOMS * 100).toFixed(1)),
    topThreeRate: Number((stats.topThree / ROOMS * 100).toFixed(1)),
    commonOpenings: commonOpenings.map(row => ({
      opening: row.opening,
      rate: Number((row.rate * 100).toFixed(1))
    }))
  };
}).sort((a, b) => a.averageRank - b.averageRank || b.meanScore - a.meanScore);

const cleanedByStrategy = {};
for (const strategy of STRATEGIES) {
  cleanedByStrategy[strategy.id] = diverseTop(aggregate[strategy.id].top, DISPLAY_PER_STRATEGY).map(cleanDraft);
}
const cleanedOverall = diverseTop(overallTop, DISPLAY_OVERALL, 3).map(cleanDraft);
cleanedOverall.forEach((draft, index) => { draft.overallRank = index + 1; });
for (const strategy of STRATEGIES) {
  cleanedByStrategy[strategy.id].forEach((draft, index) => { draft.strategyRank = index + 1; });
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    dataGeneratedAt: meta.generatedAt || null,
    modelVersion: meta.modelVersion || null,
    simulationVersion: 'pick9-strategy-lab-v1',
    scoring: meta.scoring || 'Half-PPR',
    teams: 14,
    slot: 9,
    rounds: ROUNDS,
    picks: PICKS,
    rooms: ROOMS,
    strategies: STRATEGIES.length,
    totalCompletedDrafts: ROOMS * STRATEGIES.length,
    scenarios: SCENARIOS.map(scenario => scenario.label),
    seed: MASTER_SEED,
    marketPropPlayers: finite(meta.finalization?.marketPropPlayers, finite(meta.marketPropPlayers, 0)),
    rankingMethod: '62% expected starter points, 23% floor, 15% ceiling, weighted bench value, then penalties for implausible falls and material reaches.',
    simulationMethod: 'Every room samples a complete 14-team board from exact-format ADP and draft-position variance. The user drafts from slot 9 at all 16 snake picks under each strategy.',
    elapsedMs: Date.now() - startedAt
  },
  strategySummary,
  overall: cleanedOverall,
  byStrategy: cleanedByStrategy
};

fs.writeFileSync(outputPath, `window.simulatedDrafts=${JSON.stringify(payload)};\n`);

console.log('BEST_SIMULATED_DRAFTS_START');
console.log(JSON.stringify({
  meta: payload.meta,
  strategySummary: payload.strategySummary,
  overall: payload.overall.slice(0, 5).map(draft => ({
    rank: draft.overallRank,
    strategy: draft.strategyLabel,
    score: draft.modelScore,
    percentile: draft.percentile,
    realism: draft.realism,
    opening: draft.opening,
    roster: draft.picks.map(pick => `${pick.round}. ${pick.name} (${pick.pos})`)
  }))
}, null, 2));
console.log('BEST_SIMULATED_DRAFTS_END');
