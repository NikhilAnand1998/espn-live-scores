import vm from 'node:vm';

const SITE_URL = 'https://nikhilanand1998.github.io/espn-live-scores/';
const PROJECTION_URL = 'https://raw.githubusercontent.com/dachhack/stathead/production/public/data/redraft-projections.json';
const SIMULATIONS = Number(process.env.SIMULATIONS || 5000);
const SEED = Number(process.env.SEED || 20260905);
const PICKS = [9,20,37,48,65,76,93,104,121,132,149,160,177,188,205,216];

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
function normal() {
  let u = 0, v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\b(defense|dst|d st)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function playerKey(name, pos) {
  return `${normalize(name)}|${pos === 'DST' ? 'DEF' : pos}`;
}
async function getText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 Pick9IndependentAudit/1.0', accept: '*/*' }
  });
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  return response.text();
}

const [dataText, engineText, patchText, projectionText] = await Promise.all([
  getText(`${SITE_URL}data.js?audit=${Date.now()}`),
  getText(`${SITE_URL}engine.js?audit=${Date.now()}`),
  getText(`${SITE_URL}engine-patch.js?audit=${Date.now()}`),
  getText(PROJECTION_URL)
]);

const sandbox = { console, Math, Date, JSON, Set, Map, Number, String, Array, Object, Boolean };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(dataText, sandbox, { filename: 'data.js' });
vm.runInContext(engineText, sandbox, { filename: 'engine.js' });
vm.runInContext(patchText, sandbox, { filename: 'engine-patch.js' });
const players = Array.from(sandbox.players || []);
const Engine = sandbox.DraftEngine;
if (!Engine || players.length < 220) throw new Error(`Deployed engine/data incomplete: engine=${Boolean(Engine)} players=${players.length}`);

const projectionPayload = JSON.parse(projectionText);
const independentRows = projectionPayload.players || [];
const independentByKey = new Map(independentRows.map(player => [
  playerKey(player.name, player.position),
  {
    ppgPpr: Number(player.ppg),
    recPG: Number(player.recPG || 0),
    ppgHalf: Number(player.ppg) - 0.5 * Number(player.recPG || 0)
  }
]));

const enriched = players.map(player => {
  const independent = independentByKey.get(playerKey(player.name, player.pos));
  return {
    ...player,
    independentExact: Boolean(independent),
    independentPpg: independent?.ppgHalf ?? null,
    independentPoints: independent ? independent.ppgHalf * 17 : null
  };
});

for (const pos of ['QB','RB','WR','TE']) {
  const known = enriched.filter(player => player.pos === pos && Number.isFinite(player.independentPoints)).sort((a,b) => a.adp - b.adp);
  const missing = enriched.filter(player => player.pos === pos && !Number.isFinite(player.independentPoints));
  for (const player of missing) {
    if (!known.length) {
      player.independentPpg = 0;
      player.independentPoints = 0;
      continue;
    }
    let before = known[0], after = known.at(-1);
    for (const candidate of known) {
      if (candidate.adp <= player.adp) before = candidate;
      if (candidate.adp >= player.adp) { after = candidate; break; }
    }
    const weight = clamp((player.adp - before.adp) / Math.max(1, after.adp - before.adp), 0, 1);
    player.independentPoints = before.independentPoints + (after.independentPoints - before.independentPoints) * weight;
    player.independentPpg = player.independentPoints / 17;
  }
}
for (const player of enriched) {
  if (!Number.isFinite(player.independentPoints)) {
    player.independentPoints = 0;
    player.independentPpg = 0;
  }
}

const replacementRank = { QB: 14, RB: 35, WR: 42, TE: 14 };
const independentReplacement = {};
for (const [pos, rank] of Object.entries(replacementRank)) {
  const sorted = enriched.filter(player => player.pos === pos).sort((a,b) => b.independentPoints - a.independentPoints);
  independentReplacement[pos] = sorted[Math.min(rank - 1, sorted.length - 1)]?.independentPoints || 0;
}
for (const player of enriched) {
  player.independentVor = independentReplacement[player.pos] == null ? 0 : player.independentPoints - independentReplacement[player.pos];
}

function counts(roster) {
  const result = { QB:0, RB:0, WR:0, TE:0, DEF:0, K:0 };
  for (const player of roster) if (result[player.pos] != null) result[player.pos] += 1;
  return result;
}
function isLegal(player, roster, round) {
  const c = counts(roster);
  if (!player || player.excluded) return false;
  if (round === 15) return player.pos === 'DEF';
  if (round === 16) return player.pos === 'K';
  if (player.pos === 'DEF' || player.pos === 'K') return false;
  if (round <= 2 && !['RB','WR'].includes(player.pos)) return false;
  if (c.QB >= 1 && player.pos === 'QB' && round < 13) return false;
  if (c.TE >= 1 && player.pos === 'TE' && round < 12) return false;
  if (c.QB >= 2 && player.pos === 'QB') return false;
  if (c.TE >= 2 && player.pos === 'TE') return false;
  return true;
}
function independentScore(player, roster, round) {
  if (!isLegal(player, roster, round)) return -1e9;
  const c = counts(roster);
  const pick = PICKS[round - 1];
  let score = player.independentVor + clamp((pick - player.adp) * 0.2, -8, 8);

  if (round <= 4) {
    if (c.RB === 0 && player.pos === 'RB') score += 30;
    else if (c.RB < 2 && player.pos === 'RB') score += 16;
    if (c.WR === 0 && player.pos === 'WR') score += 28;
    else if (c.WR < 2 && player.pos === 'WR') score += 16;
    if (c.RB >= 2 && c.WR < 2 && player.pos === 'RB') score -= 26;
    if (c.WR >= 2 && c.RB < 2 && player.pos === 'WR') score -= 24;
    if (c.RB >= 3 && player.pos === 'RB') score -= 45;
    if (c.WR >= 3 && player.pos === 'WR') score -= 38;
  }
  if (round >= 5 && c.RB < 2 && player.pos === 'RB') score += 28 + (round - 5) * 5;
  if (round >= 5 && c.WR < 2 && player.pos === 'WR') score += 26 + (round - 5) * 5;
  if (round >= 5 && c.WR < 3 && player.pos === 'WR') score += 5;
  if (c.QB === 0 && player.pos === 'QB') {
    if (round === 4) score += 5;
    if (round >= 5) score += 6 + (round - 5) * 8;
  }
  if (c.TE === 0 && player.pos === 'TE') {
    if (round === 4) score += 4;
    if (round >= 5) score += 5 + (round - 5) * 6;
  }
  if (round >= 10 && ['RB','WR'].includes(player.pos)) score += Math.min(4, Number(player.sd || 8) * 0.12);
  if (player.status === 'UNAVAILABLE') score -= 1000;
  if (player.status === 'MONITOR') score -= 2;
  return score;
}
function chooseIndependent(available, roster, round) {
  return available.filter(player => isLegal(player, roster, round)).sort((a,b) => independentScore(b,roster,round) - independentScore(a,roster,round) || a.adp - b.adp)[0] || null;
}
function chooseMarket(available, roster, round) {
  const c = counts(roster);
  const legal = available.filter(player => isLegal(player, roster, round)).filter(player => {
    if (round >= 8 && c.QB === 0) return player.pos === 'QB';
    if (round >= 10 && c.TE === 0) return player.pos === 'TE';
    if (round >= 6 && c.RB < 2) return player.pos === 'RB';
    if (round >= 6 && c.WR < 2) return player.pos === 'WR';
    return true;
  });
  return (legal.length ? legal : available.filter(player => isLegal(player, roster, round))).sort((a,b) => a.adp - b.adp)[0] || null;
}
function chooseEngine(available, roster, round) {
  const availableKeys = new Set(available.map(player => player.key));
  const unavailable = new Set(enriched.filter(player => !availableKeys.has(player.key)).map(player => player.key));
  return Engine.rankPlayers(enriched, unavailable, roster, round)[0]?.player || null;
}

function sampledBoard(volatility) {
  return enriched.map(player => ({
    player,
    slot: clamp(
      Number(player.adp) + normal() * Math.max(1.5, Number(player.sd || 8)) * volatility,
      Number.isFinite(Number(player.high)) ? Number(player.high) : 1,
      Number.isFinite(Number(player.low)) ? Number(player.low) : Number(player.adp) + 40
    ) + rng() * 0.0001
  })).sort((a,b) => a.slot - b.slot);
}

function lineupScore(roster) {
  const skill = roster.filter(player => ['QB','RB','WR','TE'].includes(player.pos));
  const used = new Set();
  const take = (pos, amount) => skill.filter(player => player.pos === pos).sort((a,b) => b.independentPoints - a.independentPoints).slice(0, amount);
  const qb = take('QB',1), rb = take('RB',2), wr = take('WR',2), te = take('TE',1);
  for (const player of [...qb,...rb,...wr,...te]) used.add(player.key);
  const flex = skill.filter(player => ['RB','WR','TE'].includes(player.pos) && !used.has(player.key)).sort((a,b) => b.independentPoints - a.independentPoints).slice(0,1);
  for (const player of flex) used.add(player.key);
  const starters = [...qb,...rb,...wr,...te,...flex];
  const bench = skill.filter(player => !used.has(player.key));
  const starterPoints = starters.reduce((sum,player) => sum + player.independentPoints,0);
  const benchInsurance = bench.reduce((sum,player) => sum + Math.max(0,player.independentVor) * 0.12,0);
  return { starterPoints, weekly: starterPoints / 17, objective: starterPoints + benchInsurance, starters };
}
function fallback(round) {
  return {
    id: `fallback-${round}`,
    key: `fallback-${round}`,
    name: round === 15 ? 'Streaming Defense' : 'Streaming Kicker',
    pos: round === 15 ? 'DEF' : 'K',
    adp: PICKS[round-1], sd: 99, high: PICKS[round-1], low: PICKS[round-1],
    independentPoints: 0, independentPpg: 0, independentVor: 0, vor: 0, excluded: false
  };
}
function simulate(policy, board) {
  const available = new Map(enriched.map(player => [player.key, player]));
  const roster = [];
  const selections = [];
  let cursor = 0;

  for (let overall = 1; overall <= 224; overall += 1) {
    const round = PICKS.indexOf(overall) + 1;
    if (round) {
      const list = [...available.values()];
      let chosen;
      if (policy === 'engine') chosen = chooseEngine(list, roster, round);
      else if (policy === 'independent') chosen = chooseIndependent(list, roster, round);
      else chosen = chooseMarket(list, roster, round);
      if (!chosen && round >= 15) chosen = fallback(round);
      if (!chosen) throw new Error(`No ${policy} selection at Round ${round}`);
      const independentBoard = list.filter(player => isLegal(player, roster, round)).sort((a,b) => independentScore(b,roster,round)-independentScore(a,roster,round));
      const independentRank = Math.max(1, independentBoard.findIndex(player => player.key === chosen.key) + 1);
      roster.push(chosen);
      selections.push({
        round,
        overall,
        name: chosen.name,
        pos: chosen.pos,
        adp: chosen.adp,
        independentRank,
        independentPpg: chosen.independentPpg
      });
      available.delete(chosen.key);
    } else {
      while (cursor < board.length && !available.has(board[cursor].player.key)) cursor += 1;
      if (cursor < board.length) {
        const opponent = board[cursor].player;
        available.delete(opponent.key);
        cursor += 1;
      }
    }
  }

  const c = counts(roster);
  const score = lineupScore(roster);
  return {
    roster,
    selections,
    counts: c,
    score,
    complete: c.QB >= 1 && c.RB >= 2 && c.WR >= 2 && c.TE >= 1 && c.DEF >= 1 && c.K >= 1,
    duplicate: new Set(roster.map(player => player.key)).size !== roster.length,
    jacobs: roster.some(player => normalize(player.name) === normalize('Josh Jacobs')),
    opening: roster.slice(0,4).map(player => player.pos).join('-'),
    openingNames: roster.slice(0,4).map(player => player.name).join(' > '),
    reaches: selections.filter(selection => selection.adp - selection.overall > 12).length
  };
}

const policies = ['engine','independent','market'];
const aggregate = Object.fromEntries(policies.map(policy => [policy, {
  simulations: 0, complete: 0, duplicate: 0, jacobs: 0, starterPoints: 0, weekly: 0, objective: 0, reaches: 0,
  top1: 0, top3: 0, top5: 0,
  rounds: Array.from({length:16}, () => ({n:0, rank:0, top3:0, top5:0})),
  openings: new Map(), openingNames: new Map(), firstRound: new Map(), examples: []
}]));

for (let simulation = 0; simulation < SIMULATIONS; simulation += 1) {
  const board = sampledBoard(simulation % 2 ? 0.8 : 1.2);
  for (const policy of policies) {
    const result = simulate(policy, board);
    const a = aggregate[policy];
    a.simulations += 1;
    a.complete += result.complete ? 1 : 0;
    a.duplicate += result.duplicate ? 1 : 0;
    a.jacobs += result.jacobs ? 1 : 0;
    a.starterPoints += result.score.starterPoints;
    a.weekly += result.score.weekly;
    a.objective += result.score.objective;
    a.reaches += result.reaches;
    result.selections.forEach((selection,index) => {
      const round = a.rounds[index];
      round.n += 1;
      round.rank += selection.independentRank;
      if (selection.independentRank === 1) a.top1 += 1;
      if (selection.independentRank <= 3) { a.top3 += 1; round.top3 += 1; }
      if (selection.independentRank <= 5) { a.top5 += 1; round.top5 += 1; }
    });
    a.openings.set(result.opening, (a.openings.get(result.opening) || 0) + 1);
    a.openingNames.set(result.openingNames, (a.openingNames.get(result.openingNames) || 0) + 1);
    const first = result.selections[0]?.name || 'Unknown';
    const firstStats = a.firstRound.get(first) || {n:0,starter:0,objective:0};
    firstStats.n += 1;
    firstStats.starter += result.score.starterPoints;
    firstStats.objective += result.score.objective;
    a.firstRound.set(first, firstStats);
    if (a.examples.length < 8 && simulation % Math.max(1,Math.floor(SIMULATIONS/8)) === 0) {
      a.examples.push(result.selections.map(selection => `R${selection.round} ${selection.name} (${selection.pos})`).join(' | '));
    }
  }
}

function mapTop(map,total,limit=12) {
  return [...map.entries()].map(([key,n]) => ({key,n,pct:+(100*n/total).toFixed(1)})).sort((a,b)=>b.n-a.n).slice(0,limit);
}
function summarize(a) {
  const totalSelections = a.simulations * 16;
  return {
    simulations: a.simulations,
    completePct: +(100*a.complete/a.simulations).toFixed(2),
    duplicatePct: +(100*a.duplicate/a.simulations).toFixed(2),
    joshJacobsPct: +(100*a.jacobs/a.simulations).toFixed(2),
    avgIndependentWeeklyStarterPoints: +(a.weekly/a.simulations).toFixed(2),
    avgIndependentSeasonStarterPoints: +(a.starterPoints/a.simulations).toFixed(1),
    avgIndependentRosterObjective: +(a.objective/a.simulations).toFixed(1),
    avgReachesOver12Picks: +(a.reaches/a.simulations).toFixed(2),
    top1IndependentPct: +(100*a.top1/totalSelections).toFixed(1),
    top3IndependentPct: +(100*a.top3/totalSelections).toFixed(1),
    top5IndependentPct: +(100*a.top5/totalSelections).toFixed(1),
    byRound: a.rounds.map((round,index) => ({
      round:index+1,
      avgIndependentRank:+(round.rank/round.n).toFixed(2),
      top3Pct:+(100*round.top3/round.n).toFixed(1),
      top5Pct:+(100*round.top5/round.n).toFixed(1)
    })),
    openingStructures: mapTop(a.openings,a.simulations),
    commonOpenings: mapTop(a.openingNames,a.simulations),
    firstRound: [...a.firstRound.entries()].map(([name,stats]) => ({
      name,n:stats.n,pct:+(100*stats.n/a.simulations).toFixed(1),
      avgStarter:+(stats.starter/stats.n).toFixed(1),avgObjective:+(stats.objective/stats.n).toFixed(1)
    })).sort((x,y)=>y.n-x.n).slice(0,12),
    examples:a.examples
  };
}

const exactIndependent = enriched.filter(player => ['QB','RB','WR','TE'].includes(player.pos) && player.independentExact).length;
const totalSkill = enriched.filter(player => ['QB','RB','WR','TE'].includes(player.pos)).length;
const report = {
  generatedAt:new Date().toISOString(),
  seed:SEED,
  simulationsPerPolicy:SIMULATIONS,
  totalMockDrafts:SIMULATIONS*policies.length,
  sources:{deployedSite:SITE_URL,independentProjection:PROJECTION_URL},
  data:{
    deployedPlayers:enriched.length,
    exactIndependentProjectionMatches:exactIndependent,
    skillPlayers:totalSkill,
    independentProjectionMatchPct:+(100*exactIndependent/totalSkill).toFixed(1),
    independentProjectionGeneratedAt:projectionPayload.generatedAt,
    independentProjectionScoring:projectionPayload.scoring,
    excludedPlayers:enriched.filter(player=>player.excluded).map(player=>player.name)
  },
  results:Object.fromEntries(policies.map(policy=>[policy,summarize(aggregate[policy])]))
};
console.log('MOCK_DRAFT_VALIDATION_START');
console.log(JSON.stringify(report,null,2));
console.log('MOCK_DRAFT_VALIDATION_END');
