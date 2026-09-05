import fs from 'node:fs';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

const dataPath = process.argv[2] || 'data.js';
const SOURCES = [
  { name: 'LeagueLogs', url: 'https://leaguelogs.com/rankings/ros/half-ppr' },
  { name: 'FantasyPros', url: 'https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php' },
  { name: 'RotoWire rankings', url: 'https://www.rotowire.com/football/rankings-half-ppr.php' },
  { name: 'RotoWire print', url: 'https://www.rotowire.com/football/cheatsheet-print.php?style=HALF' },
  { name: 'RotoWire web9', url: 'https://web9.rotowire.com/football/cheatsheet-half.php' },
  { name: 'FFToday', url: 'https://ftp.fftoday.com/rankings/26-print-half-ppr.html' }
];

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

const knownNames = players
  .map(player => ({ player, normalized: normalize(player.name) }))
  .filter(item => item.normalized.length >= 4)
  .sort((a, b) => b.normalized.length - a.normalized.length);

function findKnownPlayer(cellText) {
  const normalizedCell = normalize(
    String(cellText || '')
      .replace(/start\s*\/\s*sit/gi, ' ')
      .replace(/2025 roster/gi, ' ')
      .replace(/injury/gi, ' ')
      .replace(/overall\s*#?\d+/gi, ' ')
  );
  if (!normalizedCell) return null;

  for (const item of knownNames) {
    if (
      normalizedCell === item.normalized
      || normalizedCell.startsWith(`${item.normalized} `)
      || normalizedCell.endsWith(` ${item.normalized}`)
      || normalizedCell.includes(` ${item.normalized} `)
    ) {
      return item.player;
    }
  }
  return null;
}

function parseTables(html) {
  const $ = cheerio.load(html);
  const rankings = [];

  $('table tr').each((_, row) => {
    const cells = $(row).find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 2) return;

    let rank = null;
    for (const cell of cells.slice(0, 3)) {
      const match = cell.match(/^#?\s*(\d{1,3})(?:\.|\s|$)/);
      if (match) {
        rank = Number(match[1]);
        break;
      }
    }
    if (!Number.isFinite(rank) || rank < 1 || rank > 250) return;

    let matchedPlayer = null;
    for (const cell of cells) {
      matchedPlayer = findKnownPlayer(cell);
      if (matchedPlayer) break;
    }
    if (matchedPlayer) rankings.push({ rank, name: matchedPlayer.name, pos: matchedPlayer.pos });
  });

  return rankings;
}

function parseBody(html) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const rankings = [];
  for (const item of knownNames) {
    const escaped = item.player.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
    const patterns = [
      new RegExp(`(?:^|\\s)(\\d{1,3})\\.?\\s+${escaped}\\s+(?:${item.player.pos}\\s+)?[A-Z]{2,3}`, 'i'),
      new RegExp(`(?:^|\\s)(\\d{1,3})\\s+(?:${item.player.pos}\\d*\\s+)?${escaped}`, 'i')
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const rank = Number(match[1]);
        if (rank >= 1 && rank <= 250) rankings.push({ rank, name: item.player.name, pos: item.player.pos });
        break;
      }
    }
  }
  return rankings;
}

let selectedSource = null;
let unique = new Map();
const sourceErrors = [];

for (const candidate of SOURCES) {
  try {
    const html = await getText(candidate.url);
    const parsed = [...parseTables(html), ...parseBody(html)];
    const candidateMap = new Map();
    for (const item of parsed) {
      const k = playerKey(item.name, item.pos);
      const existing = candidateMap.get(k);
      if (!existing || item.rank < existing.rank) candidateMap.set(k, item);
    }

    const knownChecks = ['James Cook|RB', 'CeeDee Lamb|WR', 'Kenneth Walker|RB'];
    const knownMatches = knownChecks.filter(check => {
      const [name, pos] = check.split('|');
      return candidateMap.has(playerKey(name, pos));
    }).length;

    console.log(`${candidate.name}: parsed ${candidateMap.size} ranks; known checks ${knownMatches}/3.`);
    if (candidateMap.size >= 100 && knownMatches >= 2) {
      selectedSource = candidate;
      unique = candidateMap;
      break;
    }
    sourceErrors.push(`${candidate.name}: only ${candidateMap.size} usable ranks`);
  } catch (error) {
    sourceErrors.push(`${candidate.name}: ${error.message}`);
  }
}

if (!selectedSource) throw new Error(`No usable consensus source. ${sourceErrors.join(' | ')}`);

let matched = 0;
for (const player of players) {
  const consensus = unique.get(playerKey(player.name, player.pos));
  player.consensusRank = consensus?.rank ?? null;
  if (consensus) matched += 1;
}

if (matched < 100) throw new Error(`Only matched ${matched} current expert consensus ranks to the draft pool`);

meta.consensusGeneratedAt = new Date().toISOString();
meta.consensusMatches = matched;
meta.consensusSource = selectedSource.name;
meta.sources = { ...(meta.sources || {}), consensus: selectedSource.url };

fs.writeFileSync(dataPath, `window.draftMeta=${JSON.stringify(meta)};\nwindow.players=${JSON.stringify(players)};\n`);
console.log(`Added ${matched} current ${selectedSource.name} consensus ranks from ${unique.size} parsed rankings.`);
