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
  const number = Number(String(value).replace(/,/g, '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(number) ? number : null;
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

const byNamePosition = new Map(players.map(player => [`${normalize(player.name)}|${player.pos}`, player]));
const html = await getText(SOURCE_URL);
const $ = cheerio.load(html);
const marketRows = [];

$('table tr').each((_, row) => {
  const cells = $(row).find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
  if (cells.length < 7) return;

  const rank = finite(cells[0]);
  const link = $(row).find('a[href*="/players/"]').first();
  const rawName = link.text().replace(/\s+/g, ' ').trim();
  const positionCell = cells.find(cell => /^(QB|RB|WR|TE)\d+$/i.test(cell));
  const position = positionCell?.match(/^(QB|RB|WR|TE)/i)?.[1]?.toUpperCase();
  if (!rank || !rawName || !position || rank > 250) return;

  const positionIndex = cells.indexOf(positionCell);
  const vor = positionIndex >= 0 ? finite(cells[positionIndex + 1]) : null;
  const projection = positionIndex >= 0 ? finite(cells[positionIndex + 2]) : null;
  let floor = null;
  let ceiling = null;
  for (const cell of cells.slice(Math.max(0, positionIndex + 3))) {
    const numbers = String(cell).replace(/,/g, '').match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (numbers.length >= 2 && numbers[0] < numbers[1]) {
      floor = numbers[0];
      ceiling = numbers[1];
      break;
    }
  }
  const marketText = cells.find(cell => /\d+\s+markets?/i.test(cell));
  const marketCount = marketText ? finite(marketText.match(/\d+/)?.[0]) : null;
  const adpCell = cells.slice(positionIndex + 3).find(cell => /^\d+(?:\.\d+)?$/.test(cell));
  const sourceAdp = adpCell ? finite(adpCell) : null;

  const player = byNamePosition.get(`${normalize(rawName)}|${position}`);
  if (!player) return;
  if (projection === null || projection <= 0 || floor === null || ceiling === null || floor >= projection || ceiling <= projection) return;

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

const unique = new Map(marketRows.map(row => [row.key, row]));
if (unique.size < 45) {
  throw new Error(`Only parsed ${unique.size} usable market-priced half-PPR player rows`);
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
