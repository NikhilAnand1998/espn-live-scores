import fs from 'node:fs';
import * as cheerio from 'cheerio';

const outputPath = process.argv[2] || 'data.js';
const FFC_URL = 'https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?position=all&teams=14&year=2026';
const VALUE_URL = 'https://www.rotoalpha.com/nfl/rankings/14-team-half-ppr';

function canonicalPos(value) {
  const pos = String(value || '').toUpperCase().replace(/[0-9]/g, '');
  if (pos === 'PK') return 'K';
  if (pos === 'DST' || pos === 'D/ST') return 'DEF';
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
      'user-agent': 'Mozilla/5.0 Pick9DraftTree/2.0',
      accept: 'text/html,application/json,*/*'
    }
  });
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  return response.text();
}

const [ffcText, valueHtml] = await Promise.all([getText(FFC_URL), getText(VALUE_URL)]);
const ffcPayload = JSON.parse(ffcText);
const ffcPlayers = ffcPayload.players || ffcPayload.data || ffcPayload;
if (!Array.isArray(ffcPlayers) || ffcPlayers.length < 180) {
  throw new Error(`Unexpected exact-format ADP payload: ${Array.isArray(ffcPlayers) ? ffcPlayers.length : 'not an array'} players`);
}

const $ = cheerio.load(valueHtml);
const values = [];
$('table tr').each((_, row) => {
  const cells = $(row).find('td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
  if (cells.length < 6) return;
  const rank = Number(cells[0]);
  const name = cells[1];
  const pos = canonicalPos(cells[2]);
  const team = cells[3];
  const projection = Number(cells[4].replace(/[^0-9.-]/g, ''));
  const vor = Number(cells[5].replace(/[^0-9+.-]/g, ''));
  const posRank = Number((cells[2].match(/\d+/) || [])[0]);
  if (Number.isFinite(rank) && name && ['QB', 'RB', 'WR', 'TE', 'DEF', 'K'].includes(pos) && Number.isFinite(projection) && Number.isFinite(vor)) {
    values.push({ rank, name, pos, team, projection, vor, posRank: Number.isFinite(posRank) ? posRank : null });
  }
});
if (values.length < 150) throw new Error(`Only parsed ${values.length} exact-format value rows`);

const valueByKey = new Map(values.map(player => [playerKey(player.name, player.pos), player]));
const valueByTeamPos = new Map(values.map(player => [`${player.team}|${player.pos}`, player]));
const raw = ffcPlayers.map((player, index) => {
  const pos = canonicalPos(player.position);
  const adp = Number(player.adp);
  const sd = Math.max(1.5, Number(player.stdev || player.stddev || 8));
  const team = player.team || '';
  const exactValue = valueByKey.get(playerKey(player.name, pos));
  const value = exactValue || ((pos === 'DEF' || pos === 'K') ? valueByTeamPos.get(`${team}|${pos}`) : null) || null;
  return {
    id: index,
    key: playerKey(player.name, pos),
    name: player.name,
    pos,
    team,
    bye: player.bye || null,
    adp,
    sd,
    high: Number.isFinite(Number(player.high)) ? Number(player.high) : Math.max(1, adp - 3 * sd),
    low: Number.isFinite(Number(player.low)) ? Number(player.low) : adp + 3 * sd,
    valueRank: value?.rank ?? null,
    posRank: value?.posRank ?? null,
    projection: value?.projection ?? null,
    vor: value?.vor ?? null,
    estimated: !value
  };
}).filter(player => player.name && Number.isFinite(player.adp) && ['QB', 'RB', 'WR', 'TE', 'DEF', 'K'].includes(player.pos));

for (const pos of ['QB', 'RB', 'WR', 'TE', 'DEF', 'K']) {
  const known = raw.filter(player => player.pos === pos && Number.isFinite(player.vor)).sort((a, b) => a.adp - b.adp);
  const unknown = raw.filter(player => player.pos === pos && !Number.isFinite(player.vor));
  for (const player of unknown) {
    if (!known.length) {
      player.projection = 0;
      player.vor = -40;
      continue;
    }
    let before = known[0];
    let after = known.at(-1);
    for (const candidate of known) {
      if (candidate.adp <= player.adp) before = candidate;
      if (candidate.adp >= player.adp) {
        after = candidate;
        break;
      }
    }
    const span = Math.max(1, after.adp - before.adp);
    const weight = Math.max(0, Math.min(1, (player.adp - before.adp) / span));
    player.projection = before.projection + (after.projection - before.projection) * weight;
    player.vor = before.vor + (after.vor - before.vor) * weight;
  }
}

const tierEnds = [2, 9, 14, 20, 24, 31, 39, 48, 82, 200];
for (const player of raw) {
  player.tier = player.valueRank == null ? 10 : tierEnds.findIndex(end => player.valueRank <= end) + 1;
  if (!player.tier) player.tier = 10;
  player.adjustment = 0;
  player.upside = 0;
  player.status = '';
  player.statusNote = '';
  player.excluded = false;
}

const manual = new Map([
  [normalize('Josh Jacobs'), { excluded: true, adjustment: -999, status: 'UNAVAILABLE', statusNote: "Commissioner's Exempt List; do not draft at current cost." }],
  [normalize('Ashton Jeanty'), { adjustment: -4, status: 'MONITOR', statusNote: 'Recovering from an ankle injury; not placed on IR.' }],
  [normalize("D'Andre Swift"), { adjustment: -1, status: 'MONITOR', statusNote: 'Left practice; subsequent reporting indicated cramping.' }],
  [normalize('Rome Odunze'), { adjustment: -1, status: 'MONITOR', statusNote: 'Left practice with a leg issue; preliminary reports were reassuring.' }],
  [normalize('Emeka Egbuka'), { adjustment: -4, status: 'MONITOR', statusNote: 'Turf-toe recovery creates early-season uncertainty.' }],
  [normalize('Kenneth Walker'), { adjustment: -1, status: 'MINOR', statusNote: 'Recent ankle swelling was reported as shoe-related.' }],
  [normalize('MarShawn Lloyd'), { adjustment: 8, upside: 3, status: 'ROLE BOOST', statusNote: 'Expanded Green Bay opportunity while Jacobs is unavailable.' }],
  [normalize('Jacory Croskey-Merritt'), { adjustment: 4, upside: 2, status: 'ROLE BOOST', statusNote: 'Path to a meaningful Washington backfield role.' }],
  [normalize('Bhayshul Tuten'), { adjustment: 4, upside: 3, status: 'ROLE BOOST', statusNote: 'Expanded Jacksonville opportunity.' }],
  [normalize('Chris Godwin'), { adjustment: 3, upside: 1, status: 'ROLE BOOST', statusNote: 'Target opportunity is stronger than older ADP samples imply.' }]
]);

for (const player of raw) {
  const update = manual.get(normalize(player.name));
  if (update) Object.assign(player, update);
}

const metaPayload = ffcPayload.meta || ffcPayload.metadata || {};
const meta = {
  generatedAt: new Date().toISOString(),
  scoring: 'Half-PPR',
  teams: 14,
  slot: 9,
  rounds: 16,
  draftCount: Number(metaPayload.total_drafts || metaPayload.drafts || metaPayload.count || 3064),
  startDate: metaPayload.start_date || metaPayload.startDate || '2026-08-30',
  endDate: metaPayload.end_date || metaPayload.endDate || new Date().toISOString().slice(0, 10),
  sources: {
    adp: FFC_URL,
    value: VALUE_URL
  }
};

const output = `window.draftMeta=${JSON.stringify(meta)};\nwindow.players=${JSON.stringify(raw)};\n`;
fs.writeFileSync(outputPath, output);
console.log(`Wrote ${raw.length} players to ${outputPath}; ${raw.filter(player => !player.estimated).length} exact value matches.`);
