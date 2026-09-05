import fs from 'node:fs';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

const dataPath = process.argv[2] || 'data.js';
const SOURCE_URL = 'https://sharplineup.com/rankings/half-ppr';

function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = String(value).replace(/,/g, '').match(/[+-]?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

function headerKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

const knownByPosition = {};
for (const position of ['QB', 'RB', 'WR', 'TE']) {
  knownByPosition[position] = players
    .filter(player => player.pos === position)
    .map(player => ({ player, normalized: normalize(player.name) }))
    .sort((a, b) => b.normalized.length - a.normalized.length);
}

function findPlayer(rowText, position) {
  const normalizedText = normalize(rowText);
  for (const item of knownByPosition[position] || []) {
    if (
      normalizedText === item.normalized
      || normalizedText.startsWith(`${item.normalized} `)
      || normalizedText.includes(` ${item.normalized} `)
      || normalizedText.endsWith(` ${item.normalized}`)
    ) return item.player;
  }
  return null;
}

function indexMatching(headers, predicate, fallback) {
  const index = headers.findIndex(predicate);
  return index >= 0 ? index : fallback;
}

const html = await getText(SOURCE_URL);
const $ = cheerio.load(html);
const marketRows = [];
let tablesSeen = 0;
let candidateRows = 0;

$('table').each((_, table) => {
  tablesSeen += 1;
  let headerCells = $(table).find('thead tr').first().find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
  if (!headerCells.length) {
    headerCells = $(table).find('tr').first().find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
  }
  const headers = headerCells.map(headerKey);
  const rankIndex = indexMatching(headers, header => header === 'rk' || header.startsWith('rk ') || header.includes('rank'), 0);
  const playerIndex = indexMatching(headers, header => header.includes('player'), 1);
  const positionIndex = indexMatching(headers, header => header === 'pos' || header.includes('position'), 2);
  const vorIndex = indexMatching(headers, header => header.includes('vor') || header.includes('value'), 3);
  const projectionIndex = indexMatching(headers, header => header.includes('proj'), 4);
  const rangeIndex = indexMatching(headers, header => header.includes('flr') || header.includes('floor') || header.includes('ceil') || header.includes('volatility'), 5);
  const marketIndex = indexMatching(headers, header => header === 'mkt' || header.includes('market'), 7);
  const adpIndex = indexMatching(headers, header => header.includes('adp'), 8);

  const rows = $(table).find('tbody tr').length ? $(table).find('tbody tr') : $(table).find('tr').slice(1);
  rows.each((__, row) => {
    const cells = $(row).find('td').map((___, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 7) return;
    const rank = finite(cells[rankIndex]);
    const positionCell = cells[positionIndex] || cells.find(cell => /^(QB|RB|WR|TE)\d+$/i.test(cell));
    const position = positionCell?.match(/^(QB|RB|WR|TE)/i)?.[1]?.toUpperCase();
    if (!rank || rank > 250 || !position) return;
    candidateRows += 1;

    const playerText = [
      cells[playerIndex],
      $(row).find('a').map((___, link) => $(link).text().replace(/\s+/g, ' ').trim()).get().join(' '),
      $(row).text().replace(/\s+/g, ' ').trim()
    ].join(' ');
    const player = findPlayer(playerText, position);
    if (!player) return;

    const vor = finite(cells[vorIndex]);
    const projection = finite(cells[projectionIndex]);
    const rangeText = cells[rangeIndex] || '';
    const rangeNumbers = String(rangeText).replace(/,/g, '').match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    const floor = rangeNumbers[0] ?? null;
    const ceiling = rangeNumbers[1] ?? null;
    const marketText = cells[marketIndex] || cells.find(cell => /\d+\s+markets?/i.test(cell)) || '';
    const marketCount = finite(marketText);
    const sourceAdp = finite(cells[adpIndex]);

    if (
      projection === null || projection <= 0
      || floor === null || ceiling === null
      || floor >= projection || ceiling <= projection
    ) return;

    marketRows.push({
      key: player.key,
      rank,
      vor,
      projection,
      floor,
      ceiling,
      marketCount,
      sourceAdp
    });
  });
});

const unique = new Map();
for (const row of marketRows) {
  const existing = unique.get(row.key);
  if (!existing || row.rank < existing.rank) unique.set(row.key, row);
}
if (unique.size < 45) {
  throw new Error(`Only parsed ${unique.size} usable market-priced half-PPR rows from ${candidateRows} candidate rows across ${tablesSeen} tables`);
}

for (const player of players) {
  const market = unique.get(player.key);
  player.marketPropRank = market?.rank ?? null;
  player.marketPropVor = market?.vor ?? null;
  player.marketPropProjection = market?.projection ?? null;
  player.marketPropFloor = market?.floor ?? null;
  player.marketPropCeiling = market?.ceiling ?? null;
  player.marketPropCount = market?.marketCount ?? null;
  player.marketPropSourceAdp = market?.sourceAdp ?? null;
}

meta.marketPropsGeneratedAt = new Date().toISOString();
meta.marketPropMatches = unique.size;
meta.marketPropSource = SOURCE_URL;
meta.modelVersion = 'ensemble-rollout-v5-market';
meta.sources = { ...(meta.sources || {}), marketProps: SOURCE_URL };

fs.writeFileSync(dataPath, `window.draftMeta=${JSON.stringify(meta)};\nwindow.players=${JSON.stringify(players)};\n`);
console.log(`Added ${unique.size} half-PPR projections priced from live player-prop and prediction markets.`);
