import fs from 'node:fs';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

const [dataPath, enginePath, patchPath] = process.argv.slice(2);
if (!dataPath || !enginePath || !patchPath) {
  throw new Error('Usage: node validate-optimizer-performance.mjs <data.js> <engine.js> <engine-patch.js>');
}

const TEAMS = 14;
const USER_INDEX = 8;
const ROUNDS = 16;
const DRAFTS_PER_SCENARIO = Number(process.env.DRAFTS_PER_SCENARIO || 20);
const OUTCOMES_PER_DRAFT = Number(process.env.OUTCOMES_PER_DRAFT || 30);
const MASTER_SEED = Number(process.env.MASTER_SEED || 20260905);
const SCENARIOS = {
  normal: {},
  rb_run: { RB: -5.5 },
  wr_run: { WR: -5.5 },
  volatile: { volatility: 1.45 }
};
const POLICIES = ['optimizer', 'greedy_model', 'market_balanced', 'robust_rb', 'wr_lean', 'holdout_oracle'];
const STATHEAD_URL = 'https://raw.githubusercontent.com/dachhack/stathead/production/public/data/redraft-projections.json';
const IMAGINE_URLS = {
  QB: 'https://imaginefantasyfootball.com/scouting/season-forecast/half/qb/',
  RB: 'https://imaginefantasyfootball.com/scouting/season-forecast/half/rb/',
  WR: 'https://imaginefantasyfootball.com/scouting/season-forecast/half/wr/',
  TE: 'https://imaginefantasyfootball.com/scouting/season-forecast/half/te/'
};

function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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

function standardError(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

async function getText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 Pick9OutOfSampleValidator/1.0',
      accept: 'text/html,application/json,*/*'
    }
  });
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  return response.text();
}

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
for (const path of [dataPath, enginePath, patchPath]) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), sandbox, { filename: path });
}
const players = Array.from(sandbox.players || []);
const Engine = sandbox.DraftEngine;
const meta = sandbox.draftMeta || {};
if (!Engine || players.length < 220) throw new Error(`Bad model load: engine=${Boolean(Engine)} players=${players.length}`);
const playerByKey = new Map(players.map(player => [player.key, player]));
const playerByNamePos = new Map(players.map(player => [`${normalize(player.name)}|${player.pos}`, player]));

function counts(roster) {
  const result = { QB: 0, RB: 0, WR: 0, TE: 0, DEF: 0, K: 0 };
  for (const player of roster) if (result[player.pos] !== undefined) result[player.pos] += 1;
  return result;
}

function parseImaginePage(html, position) {
  const $ = cheerio.load(html);
  const result = new Map();
  const seen = new Set();
  $('a[href*="/scouting/players/"]').each((_, link) => {
    const name = $(link).text().replace(/\s+/g, ' ').trim();
    if (!name || seen.has(normalize(name))) return;
    let container = $(link);
    let text = '';
    for (let depth = 0; depth < 7; depth += 1) {
      container = container.parent();
      text = container.text().replace(/\s+/g, ' ').trim();
      if (/\d+(?:\.\d+)?\s*P50/i.test(text) && /\d+(?:\.\d+)?\s*FLR/i.test(text) && /\d+(?:\.\d+)?\s*CEIL/i.test(text)) break;
    }
    const p50 = text.match(/(\d+(?:\.\d+)?)\s*P50/i);
    const floor = text.match(/(\d+(?:\.\d+)?)\s*FLR/i);
    const ceiling = text.match(/(\d+(?:\.\d+)?)\s*CEIL/i);
    if (!p50 || !floor || !ceiling) return;
    const player = playerByNamePos.get(`${normalize(name)}|${position}`);
    if (!player) return;
    result.set(player.key, {
      expected: Number(p50[1]),
      floor: Number(floor[1]),
      ceiling: Number(ceiling[1]),
      source: 'Imagine Fantasy Football'
    });
    seen.add(normalize(name));
  });
  return result;
}

async function loadIndependentModels() {
  const [statheadText, ...imaginePages] = await Promise.all([
    getText(STATHEAD_URL),
    ...Object.values(IMAGINE_URLS).map(getText)
  ]);
  const statheadPayload = JSON.parse(statheadText);
  const stathead = new Map();
  for (const row of statheadPayload.players || []) {
    const position = row.position === 'DST' ? 'DEF' : row.position;
    const player = playerByNamePos.get(`${normalize(row.name)}|${position}`);
    if (!player) continue;
    const ppg = Number(row.ppg) - (position === 'QB' ? 0 : 0.5 * Number(row.recPG || 0));
    if (!Number.isFinite(ppg) || ppg <= 0) continue;
    const expected = ppg * 17;
    const cv = { QB: 0.16, RB: 0.28, WR: 0.25, TE: 0.27 }[position] || 0.24;
    stathead.set(player.key, {
      expected,
      floor: Math.max(0, expected * (1 - cv * 1.12)),
      ceiling: expected * (1 + cv * 1.30),
      source: 'Stathead projection snapshot'
    });
  }

  const imagine = new Map();
  Object.keys(IMAGINE_URLS).forEach((position, index) => {
    for (const [key, projection] of parseImaginePage(imaginePages[index], position)) imagine.set(key, projection);
  });

  const byPositionKnown = { QB: [], RB: [], WR: [], TE: [] };
  for (const player of players) {
    const projection = imagine.get(player.key) || stathead.get(player.key);
    if (projection && byPositionKnown[player.pos]) byPositionKnown[player.pos].push({ adp: player.adp, ...projection });
  }
  for (const values of Object.values(byPositionKnown)) values.sort((a, b) => a.adp - b.adp);

  const composite = new Map();
  for (const player of players) {
    const primary = imagine.get(player.key);
    const secondary = stathead.get(player.key);
    if (primary && secondary) {
      composite.set(player.key, {
        expected: primary.expected * 0.74 + secondary.expected * 0.26,
        floor: primary.floor * 0.78 + secondary.floor * 0.22,
        ceiling: primary.ceiling * 0.78 + secondary.ceiling * 0.22,
        source: 'Imagine + Stathead holdout'
      });
      continue;
    }
    if (primary || secondary) {
      composite.set(player.key, primary || secondary);
      continue;
    }
    if (!byPositionKnown[player.pos]?.length) {
      composite.set(player.key, { expected: 0, floor: 0, ceiling: 0, source: 'No holdout projection' });
      continue;
    }
    const values = byPositionKnown[player.pos];
    let before = values[0];
    let after = values.at(-1);
    for (const value of values) {
      if (value.adp <= player.adp) before = value;
      if (value.adp >= player.adp) {
        after = value;
        break;
      }
    }
    const weight = clamp((player.adp - before.adp) / Math.max(1, after.adp - before.adp), 0, 1);
    composite.set(player.key, {
      expected: before.expected + (after.expected - before.expected) * weight,
      floor: before.floor + (after.floor - before.floor) * weight,
      ceiling: before.ceiling + (after.ceiling - before.ceiling) * weight,
      source: 'ADP-interpolated holdout'
    });
  }

  return {
    composite,
    imagine,
    stathead,
    metadata: {
      imagineMatches: imagine.size,
      statheadMatches: stathead.size,
      compositePlayers: composite.size,
      statheadGeneratedAt: statheadPayload.generatedAt || null,
      statheadScoring: statheadPayload.scoring || null
    }
  };
}

const independent = await loadIndependentModels();
const HOLDOUT_REPLACEMENT_RANK = { QB: 14, RB: 35, WR: 42, TE: 14 };
const replacement = {};
for (const [position, rank] of Object.entries(HOLDOUT_REPLACEMENT_RANK)) {
  const values = players
    .filter(player => player.pos === position)
    .map(player => independent.composite.get(player.key)?.expected)
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  replacement[position] = values[Math.min(rank - 1, values.length - 1)] || 0;
}

function holdoutVor(player) {
  const projection = independent.composite.get(player.key);
  if (!projection || replacement[player.pos] === undefined) return 0;
  return projection.expected - replacement[player.pos];
}

function userEligible(player, roster, round) {
  if (!player || player.excluded) return false;
  const c = counts(roster);
  if (round === 15) return player.pos === 'DEF';
  if (round === 16) return player.pos === 'K';
  if (['DEF', 'K'].includes(player.pos)) return false;
  if (round <= 2 && !['RB', 'WR'].includes(player.pos)) return false;
  if (c.QB >= 1 && player.pos === 'QB' && round < 13) return false;
  if (c.TE >= 1 && player.pos === 'TE' && round < 12) return false;
  if (c.QB >= 2 && player.pos === 'QB') return false;
  if (c.TE >= 2 && player.pos === 'TE') return false;
  return true;
}

function holdoutNeed(player, roster, round) {
  const c = counts(roster);
  let score = 0;
  if (round <= 4) {
    if (c.RB < 2 && player.pos === 'RB') score += 24;
    if (c.WR < 2 && player.pos === 'WR') score += 23;
    if (c.RB >= 2 && c.WR < 2 && player.pos === 'RB') score -= 24;
    if (c.WR >= 2 && c.RB < 2 && player.pos === 'WR') score -= 22;
  }
  if (round >= 5 && c.RB < 2 && player.pos === 'RB') score += 30 + (round - 5) * 4;
  if (round >= 5 && c.WR < 2 && player.pos === 'WR') score += 29 + (round - 5) * 4;
  if (round >= 5 && c.WR < 3 && player.pos === 'WR') score += 6;
  if (round >= 6 && c.QB < 1 && player.pos === 'QB') score += 9 + (round - 6) * 9;
  if (round >= 7 && c.TE < 1 && player.pos === 'TE') score += 6 + (round - 7) * 8;
  if (round >= 9 && ['RB', 'WR'].includes(player.pos)) score += 6;
  if (round >= 11 && player.pos === 'RB') score += 3;
  return score;
}

function chooseUser(policy, available, roster, round, latent) {
  const candidates = [...available]
    .map(key => playerByKey.get(key))
    .filter(player => userEligible(player, roster, round));
  if (!candidates.length) return null;

  if (policy === 'optimizer') {
    const blocked = new Set(players.filter(player => !available.has(player.key)).map(player => player.key));
    return Engine.rankPlayers(players, blocked, roster, round)[0]?.player || null;
  }

  if (policy === 'greedy_model') {
    return candidates
      .map(player => ({ player, score: Engine.scorePlayer(player, roster, round).total }))
      .sort((a, b) => b.score - a.score || a.player.adp - b.player.adp)[0]?.player || null;
  }

  if (policy === 'market_balanced') {
    return candidates.sort((a, b) => {
      const score = player => -latent.get(player.key) + holdoutNeed(player, roster, round) * 0.16;
      return score(b) - score(a) || a.adp - b.adp;
    })[0];
  }

  if (policy === 'robust_rb' && round <= 2) {
    const backs = candidates.filter(player => player.pos === 'RB' && player.adp <= Engine.PICKS[round - 1] + 13);
    if (backs.length) return backs.sort((a, b) => latent.get(a.key) - latent.get(b.key))[0];
  }

  if (policy === 'wr_lean' && round <= 2) {
    const receivers = candidates.filter(player => player.pos === 'WR' && player.adp <= Engine.PICKS[round - 1] + 11);
    if (receivers.length) return receivers.sort((a, b) => latent.get(a.key) - latent.get(b.key))[0];
  }

  return candidates.sort((a, b) => {
    const score = player => holdoutVor(player) + holdoutNeed(player, roster, round)
      + clamp((Engine.PICKS[round - 1] - player.adp) * 0.45, -10, 10)
      - Math.max(0, player.adp - Engine.PICKS[round - 1] - Math.max(7, player.sd * 0.65));
    return score(b) - score(a) || a.adp - b.adp;
  })[0];
}

function opponentEligible(player, roster, round) {
  if (!player || player.excluded) return false;
  const c = counts(roster);
  if (round <= 2 && !['RB', 'WR'].includes(player.pos)) return false;
  if (round < 13 && ['DEF', 'K'].includes(player.pos)) return false;
  if (round === 13 && player.pos === 'K') return false;
  if (c.QB >= 2 && player.pos === 'QB') return false;
  if (c.TE >= 2 && player.pos === 'TE') return false;
  if (c.DEF >= 1 && player.pos === 'DEF') return false;
  if (c.K >= 1 && player.pos === 'K') return false;
  if (round <= 8 && c.QB >= 1 && player.pos === 'QB') return false;
  if (round <= 10 && c.TE >= 1 && player.pos === 'TE') return false;
  return true;
}

function chooseOpponent(available, roster, round, latent, style) {
  const c = counts(roster);
  const candidates = [...available]
    .map(key => playerByKey.get(key))
    .filter(player => opponentEligible(player, roster, round))
    .sort((a, b) => latent.get(a.key) - latent.get(b.key))
    .slice(0, 24);
  if (!candidates.length) return null;

  const score = player => {
    let value = -latent.get(player.key);
    if (c.RB < 2 && player.pos === 'RB') value += round <= 6 ? 7.8 : 13;
    if (c.WR < 2 && player.pos === 'WR') value += round <= 6 ? 7.4 : 13;
    if (round >= 6 && c.QB < 1 && player.pos === 'QB') value += 5 + (round - 6) * 2.5;
    if (round >= 8 && c.TE < 1 && player.pos === 'TE') value += 4 + (round - 8) * 2.3;
    if (round >= 14 && c.DEF < 1 && player.pos === 'DEF') value += 11;
    if (round >= 15 && c.K < 1 && player.pos === 'K') value += 13;
    if (round <= 3 && player.pos === style) value += 2.2;
    if (round >= 9 && player.pos === 'RB') value += 1.2;
    return value;
  };
  return candidates.sort((a, b) => score(b) - score(a) || latent.get(a.key) - latent.get(b.key))[0];
}

function buildLatentBoard(scenarioName, draftIndex) {
  const scenario = SCENARIOS[scenarioName];
  const latent = new Map();
  for (const player of players) {
    const random = mulberry32(hashString(`${MASTER_SEED}|${scenarioName}|${draftIndex}|${player.key}`));
    const volatility = scenario.volatility || 1;
    const shift = Number(scenario[player.pos] || 0) * (player.adp <= 95 ? 1 : 0.35);
    const sampled = player.adp + shift + normalRandom(random) * Math.max(1.5, Number(player.sd || 8)) * volatility;
    latent.set(player.key, clamp(sampled, Math.max(1, Number(player.high || 1)), Math.max(Number(player.high || 1) + 0.1, Number(player.low || player.adp + 35))));
  }
  return latent;
}

function simulateDraft(policy, scenarioName, draftIndex) {
  const latent = buildLatentBoard(scenarioName, draftIndex);
  const available = new Set(players.filter(player => !player.excluded).map(player => player.key));
  const rosters = Array.from({ length: TEAMS }, () => []);
  const userPicks = [];
  const styleRandom = mulberry32(hashString(`${MASTER_SEED}|styles|${scenarioName}|${draftIndex}`));
  const styles = Array.from({ length: TEAMS }, () => styleRandom() < 0.33 ? 'RB' : styleRandom() < 0.5 ? 'WR' : 'BPA');
  const start = Date.now();

  for (let round = 1; round <= ROUNDS; round += 1) {
    const order = round % 2 ? [...Array(TEAMS).keys()] : [...Array(TEAMS).keys()].reverse();
    for (const teamIndex of order) {
      let player;
      if (teamIndex === USER_INDEX) {
        player = chooseUser(policy, available, rosters[teamIndex], round, latent);
      } else {
        player = chooseOpponent(available, rosters[teamIndex], round, latent, styles[teamIndex]);
      }
      if (!player) {
        player = [...available].map(key => playerByKey.get(key)).sort((a, b) => latent.get(a.key) - latent.get(b.key))[0];
      }
      if (!player) throw new Error(`No player available: policy=${policy} scenario=${scenarioName} draft=${draftIndex} round=${round}`);
      rosters[teamIndex].push(player);
      available.delete(player.key);
      if (teamIndex === USER_INDEX) userPicks.push(player);
    }
  }

  return { rosters, userPicks, elapsedMs: Date.now() - start };
}

function lineupScore(roster, pointMap) {
  const groups = { QB: [], RB: [], WR: [], TE: [] };
  for (const player of roster) {
    if (groups[player.pos]) groups[player.pos].push({ player, points: pointMap.get(player.key) || 0 });
  }
  for (const values of Object.values(groups)) values.sort((a, b) => b.points - a.points);
  const used = new Set();
  const starters = [];
  const take = (position, amount) => {
    for (const item of groups[position].slice(0, amount)) {
      starters.push(item);
      used.add(item.player.key);
    }
  };
  take('QB', 1);
  take('RB', 2);
  take('WR', 2);
  take('TE', 1);
  const flex = roster
    .filter(player => ['RB', 'WR', 'TE'].includes(player.pos) && !used.has(player.key))
    .map(player => ({ player, points: pointMap.get(player.key) || 0 }))
    .sort((a, b) => b.points - a.points)[0];
  if (flex) {
    starters.push(flex);
    used.add(flex.player.key);
  }
  const bench = roster
    .filter(player => ['QB', 'RB', 'WR', 'TE'].includes(player.pos) && !used.has(player.key))
    .map(player => ({ player, points: pointMap.get(player.key) || 0 }))
    .sort((a, b) => b.points - a.points);
  const starterPoints = starters.reduce((sum, item) => sum + item.points, 0);
  const benchInsurance = bench.slice(0, 5).reduce((sum, item, index) => sum + item.points * (0.045 - index * 0.006), 0);
  return starterPoints + benchInsurance;
}

const expectedMap = new Map(players.map(player => [player.key, independent.composite.get(player.key)?.expected || 0]));
const floorMap = new Map(players.map(player => [player.key, independent.composite.get(player.key)?.floor || 0]));
const ceilingMap = new Map(players.map(player => [player.key, independent.composite.get(player.key)?.ceiling || 0]));

function sampleOutcomePoints(scenarioName, draftIndex, outcomeIndex) {
  const result = new Map();
  for (const player of players) {
    const model = independent.composite.get(player.key) || { expected: 0, floor: 0, ceiling: 0 };
    const random = mulberry32(hashString(`${MASTER_SEED}|outcome|${scenarioName}|${draftIndex}|${outcomeIndex}|${player.key}`));
    const sigma = Math.max(3, (model.ceiling - model.floor) / 3.29);
    const sampled = model.expected + normalRandom(random) * sigma;
    result.set(player.key, clamp(sampled, Math.max(0, model.floor * 0.55), model.ceiling * 1.18));
  }
  return result;
}

function rosterCompleteness(roster) {
  const c = counts(roster);
  return c.QB >= 1 && c.RB >= 2 && c.WR >= 2 && c.TE >= 1 && c.DEF >= 1 && c.K >= 1;
}

const aggregates = {};
for (const scenario of Object.keys(SCENARIOS)) {
  aggregates[scenario] = {};
  for (const policy of POLICIES) {
    aggregates[scenario][policy] = {
      expected: [],
      riskAdjusted: [],
      rank: [],
      top4: 0,
      champion: 0,
      outcomes: 0,
      complete: 0,
      elapsed: [],
      openings: new Map(),
      rosters: []
    };
  }
}

for (const scenario of Object.keys(SCENARIOS)) {
  for (let draftIndex = 0; draftIndex < DRAFTS_PER_SCENARIO; draftIndex += 1) {
    const results = {};
    for (const policy of POLICIES) {
      const result = simulateDraft(policy, scenario, draftIndex);
      results[policy] = result;
      const aggregate = aggregates[scenario][policy];
      const expectedScores = result.rosters.map(roster => lineupScore(roster, expectedMap));
      const floorScores = result.rosters.map(roster => lineupScore(roster, floorMap));
      const ceilingScores = result.rosters.map(roster => lineupScore(roster, ceilingMap));
      const userExpected = expectedScores[USER_INDEX];
      aggregate.expected.push(userExpected);
      aggregate.riskAdjusted.push(userExpected * 0.68 + floorScores[USER_INDEX] * 0.20 + ceilingScores[USER_INDEX] * 0.12);
      const expectedRank = 1 + expectedScores.filter((score, index) => index !== USER_INDEX && score > userExpected).length;
      aggregate.rank.push(expectedRank);
      aggregate.complete += rosterCompleteness(result.rosters[USER_INDEX]) ? 1 : 0;
      aggregate.elapsed.push(result.elapsedMs);
      const opening = result.userPicks.slice(0, 6).map(player => `${player.name} (${player.pos})`).join(' > ');
      aggregate.openings.set(opening, (aggregate.openings.get(opening) || 0) + 1);
      if (aggregate.rosters.length < 4) aggregate.rosters.push(result.userPicks.map(player => `${player.name} (${player.pos})`));
    }

    for (let outcomeIndex = 0; outcomeIndex < OUTCOMES_PER_DRAFT; outcomeIndex += 1) {
      const sampled = sampleOutcomePoints(scenario, draftIndex, outcomeIndex);
      for (const policy of POLICIES) {
        const aggregate = aggregates[scenario][policy];
        const scores = results[policy].rosters.map(roster => lineupScore(roster, sampled));
        const userScore = scores[USER_INDEX];
        const rank = 1 + scores.filter((score, index) => index !== USER_INDEX && score > userScore).length;
        aggregate.outcomes += 1;
        if (rank <= 4) aggregate.top4 += 1;
        if (rank === 1) aggregate.champion += 1;
      }
    }
    console.log(`Completed ${scenario} draft ${draftIndex + 1}/${DRAFTS_PER_SCENARIO}`);
  }
}

function summarize(aggregate) {
  const openingRows = [...aggregate.openings.entries()]
    .map(([opening, count]) => ({ opening, count, rate: count / aggregate.expected.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return {
    drafts: aggregate.expected.length,
    meanExpected: mean(aggregate.expected),
    expectedSe: standardError(aggregate.expected),
    expectedP25: percentile(aggregate.expected, 0.25),
    expectedMedian: percentile(aggregate.expected, 0.5),
    expectedP75: percentile(aggregate.expected, 0.75),
    meanRiskAdjusted: mean(aggregate.riskAdjusted),
    meanExpectedRank: mean(aggregate.rank),
    top4Rate: aggregate.top4 / Math.max(1, aggregate.outcomes),
    championRate: aggregate.champion / Math.max(1, aggregate.outcomes),
    completeRate: aggregate.complete / Math.max(1, aggregate.expected.length),
    meanElapsedMs: mean(aggregate.elapsed),
    p90ElapsedMs: percentile(aggregate.elapsed, 0.9),
    commonOpenings: openingRows,
    sampleRosters: aggregate.rosters
  };
}

const summary = {};
for (const scenario of Object.keys(SCENARIOS)) {
  summary[scenario] = {};
  for (const policy of POLICIES) summary[scenario][policy] = summarize(aggregates[scenario][policy]);
}

const paired = {};
for (const scenario of Object.keys(SCENARIOS)) {
  paired[scenario] = {};
  const optimizer = aggregates[scenario].optimizer.expected;
  for (const policy of POLICIES.filter(policy => policy !== 'optimizer')) {
    const comparison = aggregates[scenario][policy].expected;
    const differences = optimizer.map((value, index) => value - comparison[index]);
    paired[scenario][policy] = {
      meanDifference: mean(differences),
      differenceSe: standardError(differences),
      winRate: differences.filter(value => value > 0).length / differences.length,
      tieRate: differences.filter(value => value === 0).length / differences.length
    };
  }
}

const optimizerScenarios = Object.keys(SCENARIOS).map(scenario => summary[scenario].optimizer);
const marketDifferences = Object.keys(SCENARIOS).map(scenario => paired[scenario].market_balanced.meanDifference);
const greedyDifferences = Object.keys(SCENARIOS).map(scenario => paired[scenario].greedy_model.meanDifference);
const oracleRatios = Object.keys(SCENARIOS).map(scenario => summary[scenario].optimizer.meanExpected / summary[scenario].holdout_oracle.meanExpected);
const checks = {
  completeRosterEveryScenario: optimizerScenarios.every(result => result.completeRate === 1),
  beatsMarketOnAverage: mean(marketDifferences) > 0,
  lookaheadNotWorseThanGreedyOnAverage: mean(greedyDifferences) >= -2.5,
  withinThreePercentOfHoldoutOracleEveryScenario: oracleRatios.every(ratio => ratio >= 0.97),
  topFourRateAtLeastMarketOverall: mean(Object.keys(SCENARIOS).map(scenario => summary[scenario].optimizer.top4Rate)) >= mean(Object.keys(SCENARIOS).map(scenario => summary[scenario].market_balanced.top4Rate)) - 0.005,
  championRateAtLeastMarketOverall: mean(Object.keys(SCENARIOS).map(scenario => summary[scenario].optimizer.championRate)) >= mean(Object.keys(SCENARIOS).map(scenario => summary[scenario].market_balanced.championRate)) - 0.003,
  optimizerRuntimePractical: optimizerScenarios.every(result => result.p90ElapsedMs <= 12000),
  independentImagineCoverageAtLeastOneHundred: independent.metadata.imagineMatches >= 100,
  independentStatheadCoverageAtLeastOneHundredFifty: independent.metadata.statheadMatches >= 150
};
const validated = Object.values(checks).every(Boolean);

const report = {
  generatedAt: new Date().toISOString(),
  modelVersion: meta.modelVersion || Engine.MODEL_VERSION,
  format: '14-team half-PPR; pick 9; 1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX, DEF, K; 16 rounds',
  draftsPerScenario: DRAFTS_PER_SCENARIO,
  outcomesPerDraft: OUTCOMES_PER_DRAFT,
  totalOptimizerDrafts: DRAFTS_PER_SCENARIO * Object.keys(SCENARIOS).length,
  totalPolicyDrafts: DRAFTS_PER_SCENARIO * Object.keys(SCENARIOS).length * POLICIES.length,
  totalSeasonOutcomeEvaluations: DRAFTS_PER_SCENARIO * Object.keys(SCENARIOS).length * OUTCOMES_PER_DRAFT * POLICIES.length,
  scenarios: Object.keys(SCENARIOS),
  policies: POLICIES,
  independentModels: independent.metadata,
  replacement,
  summary,
  paired,
  checks,
  validated,
  limitations: [
    'Validation uses paired simulated draft rooms based on current 14-team half-PPR ADP distributions; actual league mates may draft differently.',
    'Roster outcomes use independent preseason projection distributions, not future observed NFL results.',
    'The holdout oracle sees the validation projection model and is intentionally an optimistic benchmark.',
    'A passing result supports the recommendation policy under tested assumptions; it does not prove universal mathematical optimality.'
  ]
};

fs.mkdirSync('optimizer-validation', { recursive: true });
fs.writeFileSync('optimizer-validation/report.json', JSON.stringify(report, null, 2));
const rows = Object.keys(SCENARIOS).map(scenario => {
  const optimizer = summary[scenario].optimizer;
  const market = summary[scenario].market_balanced;
  const oracle = summary[scenario].holdout_oracle;
  return `<tr><td>${scenario.replaceAll('_', ' ')}</td><td>${optimizer.meanExpected.toFixed(1)}</td><td>${market.meanExpected.toFixed(1)}</td><td>${oracle.meanExpected.toFixed(1)}</td><td>${(optimizer.top4Rate * 100).toFixed(1)}%</td><td>${(optimizer.championRate * 100).toFixed(1)}%</td><td>${optimizer.meanExpectedRank.toFixed(2)}</td></tr>`;
}).join('');
const checksHtml = Object.entries(checks).map(([name, passed]) => `<li class="${passed ? 'pass' : 'fail'}">${passed ? 'PASS' : 'FAIL'} — ${name.replace(/([A-Z])/g, ' $1')}</li>`).join('');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pick 9 Optimizer Validation</title><style>body{font:15px -apple-system,sans-serif;background:#050b08;color:#f4faf6;max-width:960px;margin:auto;padding:24px}a{color:#79f2a3}.card{background:#0d1d14;border:1px solid #28513b;border-radius:14px;padding:16px;margin:14px 0}table{border-collapse:collapse;width:100%;min-width:720px}th,td{padding:9px;border-bottom:1px solid #28513b;text-align:left}th,.pass{color:#79f2a3}.fail{color:#ff929b}.scroll{overflow:auto}.muted{color:#9db2a4}</style><a href="./">← Draft optimizer</a><h1>Out-of-sample optimizer validation</h1><p class="muted">${report.format}<br>${report.totalOptimizerDrafts} exact optimizer drafts · ${report.totalPolicyDrafts} paired policy drafts · ${report.totalSeasonOutcomeEvaluations.toLocaleString()} simulated season evaluations</p><div class="card"><h2>${validated ? 'VALIDATED' : 'NEEDS MORE TUNING'}</h2><ul>${checksHtml}</ul></div><div class="card scroll"><h2>Results</h2><table><thead><tr><th>Room</th><th>Optimizer expected</th><th>Market baseline</th><th>Holdout oracle</th><th>Top-4 rate</th><th>Champion rate</th><th>Expected rank</th></tr></thead><tbody>${rows}</tbody></table></div><div class="card"><h2>Independent data</h2><p>${independent.metadata.imagineMatches} Imagine Fantasy Football floor/median/ceiling matches and ${independent.metadata.statheadMatches} Stathead projection matches. Neither source is used to rank the live optimizer.</p></div><div class="card"><h2>Interpretation</h2><p>${report.limitations.join(' ')}</p></div>`;
fs.writeFileSync('optimizer-validation/index.html', html);

console.log('OPTIMIZER_VALIDATION_REPORT_START');
console.log(JSON.stringify(report, null, 2));
console.log('OPTIMIZER_VALIDATION_REPORT_END');
if (!validated) process.exitCode = 2;
