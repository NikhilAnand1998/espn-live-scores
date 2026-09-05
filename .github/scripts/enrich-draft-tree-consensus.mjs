import fs from 'node:fs';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

const dataPath = process.argv[2] || 'data.js';
const CONSENSUS_URL = 'https://www.rotowire.com/football/article/2026-half-ppr-rankings-fantasy-football-nfl-preseason-week-3-update-130452';

function canonicalPos(value) {
  const pos = String(value || '').trim().toUpperCase().replace(/[0-9]/g, '');
  if (pos === 'DST' || pos === 'D/ST') return 'DEF';
  if (pos === 'PK') return 'K';
  return pos;
}

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
  return `${normalize(name)}|${canonicalPos(pos)}`;
}

async function getText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 Pick9ConsensusEnricher/1.0',
      accept: 'text/html,*/*'
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

const html = await getText(CONSENSUS_URL);
const $ = cheerio.load(html);
const rankings = [];

$('table tr').each((_, row) => {
  const cells = $(row).find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
  if (cells.length < 4) return;
  const rankIndex = cells.findIndex(cell => /^\d{1,3}$/.test(cell));
  const posIndex = cells.findIndex((cell, index) => index > rankIndex && /^(QB|RB|WR|TE|K|PK|DST|D\/ST)\d*$/.test(cell));
  if (rankIndex < 0 || posIndex < 0) return;
  const rank = Number(cells[rankIndex]);
  const rawPos = cells[posIndex];
  const pos = canonicalPos(rawPos);
  const name = cells[posIndex - 1];
  if (Number.isFinite(rank) && name && ['QB', 'RB', 'WR', 'TE', 'DEF', 'K'].includes(pos)) {
    rankings.push({ rank, name, pos });
  }
});

if (rankings.length < 150) {
  const text = $('body').text().replace(/\s+/g, ' ');
  const pattern = /(?:^|\s)(\d{1,3})\s+([A-Z][A-Za-zÀ-ÿ.'’\- ]{2,45}?)\s+(QB|RB|WR|TE)\s+[A-Z]{2,3}\s+\d{1,2}(?=\s+\d{1,3}\s+|$)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    rankings.push({ rank: Number(match[1]), name: match[2].trim(), pos: match[3] });
  }
}

const unique = new Map();
for (const item of rankings) {
  if (item.rank >= 1 && item.rank <= 250) unique.set(playerKey(item.name, item.pos), item);
}
if (unique.size < 150) throw new Error(`Only parsed ${unique.size} consensus ranks from RotoWire`);

let matched = 0;
for (const player of players) {
  const consensus = unique.get(playerKey(player.name, player.pos));
  player.consensusRank = consensus?.rank ?? null;
  if (consensus) matched += 1;
}

meta.consensusGeneratedAt = new Date().toISOString();
meta.consensusMatches = matched;
meta.sources = { ...(meta.sources || {}), consensus: CONSENSUS_URL };

fs.writeFileSync(dataPath, `window.draftMeta=${JSON.stringify(meta)};\nwindow.players=${JSON.stringify(players)};\n`);
console.log(`Added ${matched} current expert consensus ranks from ${unique.size} parsed rankings.`);
