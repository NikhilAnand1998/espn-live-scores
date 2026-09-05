import fs from 'node:fs';
import vm from 'node:vm';
import * as cheerio from 'cheerio';

const dataPath = process.argv[2] || 'data.js';
const SOURCES = [
  {
    name: 'RotoWire print',
    url: 'https://www.rotowire.com/football/cheatsheet-print.php?style=HALF',
    orientation: 'name-before-position',
    printPattern: true
  },
  {
    name: 'RotoWire web9',
    url: 'https://web9.rotowire.com/football/cheatsheet-half.php',
    orientation: 'name-before-position'
  },
  {
    name: 'FFToday',
    url: 'https://ftp.fftoday.com/rankings/26-print-half-ppr.html',
    orientation: 'position-before-name'
  },
  {
    name: 'RotoWire mirror',
    url: 'https://aws-prod-web9.rotowire.com/football/article/2026-half-ppr-rankings-fantasy-football-nfl-preseason-week-3-update-130452',
    orientation: 'name-before-position'
  },
  {
    name: 'RotoWire article',
    url: 'https://www.rotowire.com/football/article/2026-half-ppr-rankings-fantasy-football-nfl-preseason-week-3-update-130452',
    orientation: 'name-before-position'
  }
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

function plausibleName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length >= 3
    && /[A-Za-z]/.test(text)
    && !/^(QB|RB|WR|TE|K|PK|DST|D\/ST)\d*$/i.test(text)
    && !/^[A-Z]{2,3}$/.test(text)
    && !/^\d+(?:\.\d+)?$/.test(text);
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

function parseTables(html, orientation) {
  const $ = cheerio.load(html);
  const rankings = [];

  $('table tr').each((_, row) => {
    const cells = $(row).find('th,td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 3) return;
    const rankIndex = cells.findIndex(cell => /^\d{1,3}\.?$/.test(cell));
    const posIndex = cells.findIndex((cell, index) => index > rankIndex && /^(QB|RB|WR|TE|K|PK|DST|D\/ST)\d*$/i.test(cell));
    if (rankIndex < 0 || posIndex < 0) return;

    const rank = Number(cells[rankIndex].replace('.', ''));
    const pos = canonicalPos(cells[posIndex]);
    const preferred = orientation === 'position-before-name' ? cells[posIndex + 1] : cells[posIndex - 1];
    const alternate = orientation === 'position-before-name' ? cells[posIndex - 1] : cells[posIndex + 1];
    const name = plausibleName(preferred) ? preferred : plausibleName(alternate) ? alternate : '';

    if (Number.isFinite(rank) && rank >= 1 && rank <= 250 && name && ['QB','RB','WR','TE','DEF','K'].includes(pos)) {
      rankings.push({ rank, name, pos });
    }
  });

  return rankings;
}

function parsePrintable(html) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const rankings = [];
  const patterns = [
    /(\d{1,3})\.\s*([A-Za-zÀ-ÿ.'’\- ]{3,55}?)\s+([A-Z]{2,3})\s+(QB|RB|WR|TE)\s*\(\d{1,2}\)/g,
    /(?:^|\s)(\d{1,3})\s+([A-Za-zÀ-ÿ.'’\- ]{3,55}?)\s+(QB|RB|WR|TE)\s+[A-Z]{2,3}\s+\d{1,2}(?=\s+\d{1,3}\s+|$)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const rank = Number(match[1]);
      const name = match[2].replace(/\.\s+/g, ' ').trim();
      const pos = match[4] || match[3];
      if (rank >= 1 && rank <= 250 && plausibleName(name)) rankings.push({ rank, name, pos });
    }
  }
  return rankings;
}

const source = fs.readFileSync(dataPath, 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: dataPath });
const players = Array.from(sandbox.window.players || []);
const meta = { ...(sandbox.window.draftMeta || {}) };
if (players.length < 200) throw new Error(`Only ${players.length} players found in ${dataPath}`);

let selectedSource = null;
let unique = new Map();
const sourceErrors = [];

for (const candidate of SOURCES) {
  try {
    const html = await getText(candidate.url);
    const parsed = [...parseTables(html, candidate.orientation), ...parsePrintable(html)];
    const candidateMap = new Map();
    for (const item of parsed) candidateMap.set(playerKey(item.name, item.pos), item);

    const knownChecks = ['James Cook|RB', 'CeeDee Lamb|WR', 'Kenneth Walker|RB'];
    const knownMatches = knownChecks.filter(check => {
      const [name, pos] = check.split('|');
      return candidateMap.has(playerKey(name, pos));
    }).length;

    console.log(`${candidate.name}: parsed ${candidateMap.size} ranks; known checks ${knownMatches}/3.`);
    if (candidateMap.size >= 150 && knownMatches >= 2) {
      selectedSource = candidate;
      unique = candidateMap;
      break;
    }
    sourceErrors.push(`${candidate.name}: only ${candidateMap.size} usable ranks`);
  } catch (error) {
    sourceErrors.push(`${candidate.name}: ${error.message}`);
  }
}

if (!selectedSource) {
  throw new Error(`No usable consensus source. ${sourceErrors.join(' | ')}`);
}

let matched = 0;
for (const player of players) {
  const consensus = unique.get(playerKey(player.name, player.pos));
  player.consensusRank = consensus?.rank ?? null;
  if (consensus) matched += 1;
}

if (matched < 150) throw new Error(`Only matched ${matched} current expert consensus ranks to the draft pool`);

meta.consensusGeneratedAt = new Date().toISOString();
meta.consensusMatches = matched;
meta.consensusSource = selectedSource.name;
meta.sources = { ...(meta.sources || {}), consensus: selectedSource.url };

fs.writeFileSync(dataPath, `window.draftMeta=${JSON.stringify(meta)};\nwindow.players=${JSON.stringify(players)};\n`);
console.log(`Added ${matched} current ${selectedSource.name} consensus ranks from ${unique.size} parsed rankings.`);
