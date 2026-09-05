import fs from 'node:fs';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

const dataPath = process.argv[2] || 'data.js';
const SOURCES = {
  giq: 'https://giqfootball.com/half-ppr-rankings/',
  rotowire: 'https://www.rotowire.com/football/rankings-half-ppr.php'
};

function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\b(defense|dst|d st)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function weightedMean(items) {
  const usable = items.filter(item => finite(item.value) !== null && item.weight > 0);
  if (!usable.length) return null;
  const sorted = usable.map(item => finite(item.value)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let numerator = 0;
  let denominator = 0;
  for (const item of usable) {
    const value = Math.max(median - 25, Math.min(median + 25, finite(item.value)));
    numerator += value * item.weight;
    denominator += item.weight;
  }
  return denominator ? numerator / denominator : null;
}

function standardDeviation(values) {
  const usable = values.map(finite).filter(value => value !== null);
  if (usable.length < 2) return 0;
  const average = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  return Math.sqrt(usable.reduce((sum, value) => sum + (value - average) ** 2, 0) / usable.length);
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

const known = players
  .map(player => ({ player, normalized: normalize(player.name) }))
  .filter(item => item.normalized.length >= 3)
  .sort((a, b) => b.normalized.length - a.normalized.length);

function findPlayer(text) {
  const normalizedText = normalize(text);
  if (!normalizedText) return null;
  for (const item of known) {
    if (
      normalizedText === item.normalized
      || normalizedText.startsWith(`${item.normalized} `)
      || normalizedText.endsWith(` ${item.normalized}`)
      || normalizedText.includes(` ${item.normalized} `)
    ) return item.player;
  }
  return null;
}

function parseRank(value) {
  const match = String(value || '').trim().match(/^#?\s*(\d{1,3})(?:\.|\s|$)/);
  if (!match) return null;
  const rank = Number(match[1]);
  return rank >= 1 && rank <= 250 ? rank : null;
}

function parseRotowire(html) {
  const $ = cheerio.load(html);
  const result = new Map();
  $('table tr').each((_, row) => {
    const cells = $(row).find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 4) return;
    const rank = cells.map(parseRank).find(value => value !== null);
    if (rank === undefined || rank === null) return;
    const player = cells.map(findPlayer).find(Boolean);
    if (!player) return;
    const existing = result.get(player.key);
    if (!existing || rank < existing.rank) result.set(player.key, { rank });
  });
  return result;
}

function parseGiq(html) {
  const $ = cheerio.load(html);
  const result = new Map();
  $('table tr').each((_, row) => {
    const cells = $(row).find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 5) return;
    const rank = parseRank(cells[0]);
    const player = cells.map(findPlayer).find(Boolean);
    if (!rank || !player) return;

    const numericCells = cells.map(cell => finite(String(cell).replace(/,/g, '').replace(/[^0-9.+-]/g, '')));
    let projection = null;
    if (numericCells.length >= 4 && numericCells[3] !== null && numericCells[3] >= 50 && numericCells[3] <= 500) {
      projection = numericCells[3];
    } else {
      projection = numericCells.find((value, index) => index > 1 && value !== null && value >= 80 && value <= 500) ?? null;
    }

    let floor = null;
    let ceiling = null;
    for (const cell of cells) {
      const match = String(cell).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:–|—|-)\s*(\d+(?:\.\d+)?)/);
      if (match) {
        floor = Number(match[1]);
        ceiling = Number(match[2]);
        break;
      }
    }

    result.set(player.key, { rank, projection, floor, ceiling });
  });

  if (result.size >= 35) return result;

  const body = $('body').text().replace(/\s+/g, ' ');
  for (const item of known) {
    if (!['QB', 'RB', 'WR', 'TE'].includes(item.player.pos)) continue;
    const withoutSuffix = item.player.name.replace(/\s+(?:Jr\.?|Sr\.?|III|II|IV)$/i, '');
    const namePattern = regexEscape(withoutSuffix).replace(/\\\s+/g, '\\s+');
    const pattern = new RegExp(
      `(?:^|\\s)(\\d{1,3})\\s+${namePattern}(?:\\s+(?:Jr\\.?|Sr\\.?|III|II|IV))?\\s+[A-Z]{2,3}\\s*(?:•|·)?\\s*${item.player.pos}\\d+\\s+` +
      `(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)\\s+` +
      `(\\d+(?:\\.\\d+)?)\\s*(?:–|—|-)\\s*(\\d+(?:\\.\\d+)?)\\s*pts`,
      'i'
    );
    const match = body.match(pattern);
    if (!match) continue;
    result.set(item.player.key, {
      rank: Number(match[1]),
      projection: Number(match[3]),
      floor: Number(match[5]),
      ceiling: Number(match[6])
    });
  }

  return result;
}

const parsed = { giq: new Map(), rotowire: new Map() };
const errors = [];

try {
  parsed.rotowire = parseRotowire(await getText(SOURCES.rotowire));
  console.log(`RotoWire: ${parsed.rotowire.size} matched rankings.`);
} catch (error) {
  errors.push(`RotoWire: ${error.message}`);
}

try {
  parsed.giq = parseGiq(await getText(SOURCES.giq));
  console.log(`GIQ: ${parsed.giq.size} matched rankings/projections.`);
} catch (error) {
  errors.push(`GIQ: ${error.message}`);
}

if (parsed.rotowire.size < 100 && parsed.giq.size < 35) {
  throw new Error(`External model enrichment failed. ${errors.join(' | ')}`);
}

const fallbackCv = { QB: 0.15, RB: 0.26, WR: 0.23, TE: 0.25, DEF: 0.16, K: 0.14 };
let giqProjectionMatches = 0;
let rotowireMatches = 0;

for (const player of players) {
  const rotowire = parsed.rotowire.get(player.key);
  const giq = parsed.giq.get(player.key);
  const baseProjection = finite(player.projection) ?? 0;

  player.rotowireRank = rotowire?.rank ?? null;
  player.giqRank = giq?.rank ?? null;
  player.giqProjection = giq?.projection ?? null;
  player.giqFloor = giq?.floor ?? null;
  player.giqCeiling = giq?.ceiling ?? null;
  if (rotowire) rotowireMatches += 1;
  if (finite(giq?.projection) !== null) giqProjectionMatches += 1;

  const rankValues = [
    finite(player.adp),
    finite(player.valueRank),
    finite(player.consensusRank),
    finite(player.rotowireRank),
    finite(player.giqRank)
  ].filter(value => value !== null);

  player.ensembleRank = weightedMean([
    { value: player.adp, weight: 0.29 },
    { value: player.valueRank, weight: 0.24 },
    { value: player.consensusRank, weight: 0.17 },
    { value: player.rotowireRank, weight: 0.20 },
    { value: player.giqRank, weight: 0.10 }
  ]) ?? finite(player.adp) ?? 999;
  player.rankSpread = standardDeviation(rankValues);
  player.modelSources = rankValues.length;

  const canBlendGiq = player.pos !== 'QB' && finite(player.giqProjection) !== null;
  player.projectionEnsemble = canBlendGiq
    ? baseProjection * 0.64 + Number(player.giqProjection) * 0.36
    : baseProjection;

  const cv = fallbackCv[player.pos] ?? 0.24;
  player.projectionFloor = finite(player.giqFloor) ?? Math.max(0, player.projectionEnsemble * (1 - cv * 1.18));
  player.projectionCeiling = finite(player.giqCeiling) ?? player.projectionEnsemble * (1 + cv * 1.28);
  player.modelConfidence = Math.max(0.15, Math.min(1, 1 - player.rankSpread / 55));
}

meta.externalModelsGeneratedAt = new Date().toISOString();
meta.rotowireMatches = rotowireMatches;
meta.giqProjectionMatches = giqProjectionMatches;
meta.externalModelErrors = errors;
meta.modelVersion = 'ensemble-rollout-v3';
meta.sources = { ...(meta.sources || {}), ...SOURCES };

fs.writeFileSync(dataPath, `window.draftMeta=${JSON.stringify(meta)};\nwindow.players=${JSON.stringify(players)};\n`);
console.log(`External ensemble ready: ${rotowireMatches} RotoWire ranks, ${giqProjectionMatches} GIQ projections.`);
