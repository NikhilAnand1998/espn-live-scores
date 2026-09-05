import fs from 'node:fs';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

const dataPath = process.argv[2] || 'data.js';
const URLS = {
  QB: 'https://lineupbeat.com/nfl/projections/qb/',
  RB: 'https://lineupbeat.com/nfl/projections/rb/',
  WR: 'https://lineupbeat.com/nfl/projections/wr/',
  TE: 'https://lineupbeat.com/nfl/projections/te/'
};
const REPLACEMENT_RANK = { QB: 14, RB: 35, WR: 42, TE: 14 };

function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function finite(value) {
  const number = Number(String(value ?? '').replace(/,/g, '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(number) ? number : null;
}

function mean(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function standardDeviation(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  if (usable.length < 2) return 0;
  const average = mean(usable);
  return Math.sqrt(mean(usable.map(value => (value - average) ** 2)));
}

async function getText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,*/*',
      'accept-language': 'en-US,en;q=0.9'
    }
  });
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  return response.text();
}

const source = fs.readFileSync(dataPath, 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: dataPath });
const players = Array.from(sandbox.window.players || []);
const meta = { ...(sandbox.window.draftMeta || {}) };
if (players.length < 200) throw new Error(`Only ${players.length} players found in ${dataPath}`);

const playerByNamePos = new Map(players.map(player => [`${normalize(player.name)}|${player.pos}`, player]));
const projections = new Map();
const sourceCounts = {};

for (const [position, url] of Object.entries(URLS)) {
  const html = await getText(url);
  const $ = cheerio.load(html);
  let matched = 0;
  let parsed = 0;

  $('table').each((_, table) => {
    const headerCells = $(table).find('thead tr').first().find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (!headerCells.length) {
      $(table).find('tr').first().find('th,td').each((__, cell) => headerCells.push($(cell).text().replace(/\s+/g, ' ').trim()));
    }
    const normalizedHeaders = headerCells.map(header => header.toLowerCase());
    const playerIndex = normalizedHeaders.findIndex(header => header.includes('player'));
    const halfIndex = normalizedHeaders.findIndex(header => header === 'half' || header.includes('half ppr') || header.includes('half-ppr'));
    const rankIndex = normalizedHeaders.findIndex(header => header === '#' || header.includes('rank'));
    if (playerIndex < 0 || halfIndex < 0) return;

    $(table).find('tbody tr').each((__, row) => {
      const cells = $(row).find('td').map((___, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
      if (cells.length <= Math.max(playerIndex, halfIndex)) return;
      const name = cells[playerIndex];
      const projection = finite(cells[halfIndex]);
      const rank = rankIndex >= 0 ? finite(cells[rankIndex]) : null;
      if (!name || projection === null || projection <= 0) return;
      parsed += 1;
      const player = playerByNamePos.get(`${normalize(name)}|${position}`);
      if (!player) return;
      projections.set(player.key, { projection, rank });
      matched += 1;
    });
  });

  if (parsed < 20 || matched < Math.min(20, players.filter(player => player.pos === position).length)) {
    throw new Error(`LineupBeat ${position} parse failed: parsed=${parsed}, matched=${matched}`);
  }
  sourceCounts[position] = { parsed, matched };
  console.log(`LineupBeat ${position}: parsed ${parsed}, matched ${matched}.`);
}

const replacement = {};
for (const [position, rank] of Object.entries(REPLACEMENT_RANK)) {
  const values = players
    .filter(player => player.pos === position)
    .map(player => projections.get(player.key)?.projection)
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  replacement[position] = values[Math.min(rank - 1, values.length - 1)] ?? 0;
}

for (const player of players) {
  const lineupBeat = projections.get(player.key);
  player.lineupBeatProjection = lineupBeat?.projection ?? null;
  player.lineupBeatPosRank = lineupBeat?.rank ?? null;
  player.lineupBeatVor = lineupBeat && REPLACEMENT_RANK[player.pos]
    ? lineupBeat.projection - replacement[player.pos]
    : null;
}

const valueOrder = players
  .filter(player => Number.isFinite(player.lineupBeatVor))
  .sort((a, b) => b.lineupBeatVor - a.lineupBeatVor || a.adp - b.adp);
valueOrder.forEach((player, index) => { player.lineupBeatValueRank = index + 1; });
for (const player of players) {
  if (!Number.isFinite(player.lineupBeatValueRank)) player.lineupBeatValueRank = null;

  const baseProjection = finite(player.projection) ?? 0;
  const modelProjections = [
    { value: baseProjection, weight: 0.58 },
    { value: player.lineupBeatProjection, weight: 0.42 },
    { value: player.giqProjection, weight: 0.10 }
  ].filter(item => Number.isFinite(Number(item.value)) && Number(item.value) > 0);
  const weightTotal = modelProjections.reduce((sum, item) => sum + item.weight, 0);
  const blendedProjection = weightTotal
    ? modelProjections.reduce((sum, item) => sum + Number(item.value) * item.weight, 0) / weightTotal
    : baseProjection;
  player.projectionEnsemble = blendedProjection;

  const rankModels = [
    player.adp,
    player.valueRank,
    player.consensusRank,
    player.rotowireRank,
    player.giqRank,
    player.lineupBeatValueRank
  ].map(Number).filter(Number.isFinite);
  const rankWeights = [
    { value: player.adp, weight: 0.27 },
    { value: player.valueRank, weight: 0.20 },
    { value: player.consensusRank, weight: 0.16 },
    { value: player.rotowireRank, weight: 0.15 },
    { value: player.giqRank, weight: 0.06 },
    { value: player.lineupBeatValueRank, weight: 0.16 }
  ].filter(item => Number.isFinite(Number(item.value)));
  const rankWeightTotal = rankWeights.reduce((sum, item) => sum + item.weight, 0);
  player.ensembleRank = rankWeightTotal
    ? rankWeights.reduce((sum, item) => sum + Number(item.value) * item.weight, 0) / rankWeightTotal
    : Number(player.adp);
  player.rankSpread = standardDeviation(rankModels);
  player.modelSources = rankModels.length;

  const projectionModels = [baseProjection, player.lineupBeatProjection, player.giqProjection].map(Number).filter(value => Number.isFinite(value) && value > 0);
  const projectionSpread = standardDeviation(projectionModels);
  player.projectionSpread = projectionSpread;
  const baseFloor = finite(player.giqFloor);
  const baseCeiling = finite(player.giqCeiling);
  const fallbackCv = { QB: 0.15, RB: 0.26, WR: 0.23, TE: 0.25, DEF: 0.16, K: 0.14 }[player.pos] ?? 0.24;
  player.projectionFloor = baseFloor ?? Math.max(0, blendedProjection * (1 - fallbackCv * 1.05) - projectionSpread * 0.35);
  player.projectionCeiling = baseCeiling ?? blendedProjection * (1 + fallbackCv * 1.18) + projectionSpread * 0.45;
  const rankConfidence = Math.max(0.15, 1 - player.rankSpread / 60);
  const projectionConfidence = blendedProjection > 0 ? Math.max(0.2, 1 - projectionSpread / Math.max(40, blendedProjection * 0.35)) : 0.2;
  player.modelConfidence = Math.max(0.15, Math.min(1, rankConfidence * 0.65 + projectionConfidence * 0.35));
}

meta.lineupBeatGeneratedAt = new Date().toISOString();
meta.lineupBeatMatches = projections.size;
meta.lineupBeatCounts = sourceCounts;
meta.lineupBeatReplacement = replacement;
meta.modelVersion = 'ensemble-rollout-v4';
meta.sources = { ...(meta.sources || {}), lineupBeat: URLS };

fs.writeFileSync(dataPath, `window.draftMeta=${JSON.stringify(meta)};\nwindow.players=${JSON.stringify(players)};\n`);
console.log(`LineupBeat enrichment complete: ${projections.size} player projections matched.`);
