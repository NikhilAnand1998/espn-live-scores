import vm from 'node:vm';

const SITE = 'https://nikhilanand1998.github.io/espn-live-scores/';

async function text(path) {
  const response = await fetch(`${SITE}${path}?diagnostic=${Date.now()}`, {
    headers: { 'user-agent': 'Mozilla/5.0 Pick9ChaseDiagnostic/1.0' }
  });
  if (!response.ok) throw new Error(`${response.status} fetching ${path}`);
  return response.text();
}

const [data, engine, patch, availability] = await Promise.all([
  text('data.js'), text('engine.js'), text('engine-patch.js'), text('availability.js')
]);
const sandbox = { console, Math, Date, JSON, Set, Map, Number, String, Array, Object, Boolean, performance: { now: () => Date.now() } };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const [name, source] of [['data.js', data], ['engine.js', engine], ['engine-patch.js', patch], ['availability.js', availability]]) {
  vm.runInContext(source, sandbox, { filename: name });
}
const players = Array.from(sandbox.players || []);
const Engine = sandbox.DraftEngine;
const Availability = sandbox.DraftAvailability;
const chase = players.find(player => player.name === 'Chase Brown');
if (!chase) throw new Error('Chase Brown missing from player pool');

function visibleBoard(round, roster = [], blocked = new Set()) {
  const overallPick = Engine.PICKS[round - 1];
  const entries = Engine.rankPlayers(players, blocked, roster, round).map(entry => Availability.annotate(entry, overallPick));
  const fallers = entries.filter(entry => {
    const player = entry.player;
    const modelRank = Number(player.ensembleRank ?? player.valueRank ?? player.adp);
    return entry.availability.probability < 0.48 && modelRank <= overallPick - 2;
  }).slice(0, 4);
  const fallerKeys = new Set(fallers.map(entry => entry.player.key));
  let expected = entries.filter(entry => !fallerKeys.has(entry.player.key) && entry.availability.probability >= 0.22);
  if (expected.length < 6) {
    const used = new Set([...fallerKeys, ...expected.map(entry => entry.player.key)]);
    expected = [...expected, ...entries.filter(entry => !used.has(entry.player.key))];
  }
  const baseCount = round === 1 ? 7 : 6;
  return { entries, fallers, expected, shown: expected.slice(0, baseCount) };
}

const round1 = visibleBoard(1);
const round2 = visibleBoard(2);
const report = {
  modelVersion: sandbox.draftMeta?.modelVersion,
  chase: {
    adp: chase.adp,
    sd: chase.sd,
    high: chase.high,
    low: chase.low,
    valueRank: chase.valueRank,
    consensusRank: chase.consensusRank,
    ensembleRank: chase.ensembleRank,
    projection: chase.projectionEnsemble ?? chase.projection,
    probabilityAtPick9: Availability.probabilityAtPick(chase, 9),
    probabilityAtPick20: Availability.probabilityAtPick(chase, 20),
    range: Availability.draftRange(chase)
  },
  round1: {
    fullRank: round1.entries.findIndex(entry => entry.player.key === chase.key) + 1,
    expectedRank: round1.expected.findIndex(entry => entry.player.key === chase.key) + 1,
    fallerRank: round1.fallers.findIndex(entry => entry.player.key === chase.key) + 1,
    visible: round1.shown.some(entry => entry.player.key === chase.key),
    shownExpected: round1.shown.map(entry => entry.player.name),
    fallers: round1.fallers.map(entry => entry.player.name),
    nextHiddenExpected: round1.expected.slice(7, 12).map(entry => entry.player.name)
  },
  round2: {
    fullRank: round2.entries.findIndex(entry => entry.player.key === chase.key) + 1,
    expectedRank: round2.expected.findIndex(entry => entry.player.key === chase.key) + 1,
    fallerRank: round2.fallers.findIndex(entry => entry.player.key === chase.key) + 1,
    visible: round2.shown.some(entry => entry.player.key === chase.key),
    shownExpected: round2.shown.map(entry => entry.player.name),
    fallers: round2.fallers.map(entry => entry.player.name)
  }
};
console.log('CHASE_BROWN_DIAGNOSTIC_START');
console.log(JSON.stringify(report, null, 2));
console.log('CHASE_BROWN_DIAGNOSTIC_END');
