import fs from 'node:fs';
import vm from 'node:vm';

const [dataPath, enginePath, patchPath] = process.argv.slice(2);
if (!dataPath || !enginePath || !patchPath) {
  throw new Error('Usage: node smoke-test-draft-optimizer.mjs <data.js> <engine.js> <engine-patch.js>');
}

const sandbox = {
  console,
  Math,
  Date,
  JSON,
  Set,
  Map,
  Number,
  String,
  Array,
  Object,
  Boolean,
  performance: { now: () => Date.now() }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const path of [dataPath, enginePath, patchPath]) {
  vm.runInContext(fs.readFileSync(path, 'utf8'), sandbox, { filename: path });
}

const players = Array.from(sandbox.players || []);
const Engine = sandbox.DraftEngine;
const meta = sandbox.draftMeta || {};
if (!Engine || players.length < 220) throw new Error(`Bad optimizer load: engine=${Boolean(Engine)} players=${players.length}`);

const byName = new Map(players.map(player => [player.name.replace(/\s+(Jr\.|III|II)$/i, ''), player]));
const assertions = [];
function assert(value, label) {
  if (!value) throw new Error(`FAILED: ${label}`);
  assertions.push(label);
  console.log(`PASS: ${label}`);
}
function blockedNames(names) {
  return new Set(names.map(name => byName.get(name)?.key).filter(Boolean));
}

assert(meta.modelVersion === 'ensemble-rollout-v5', 'Null-safe v5 data model is active');
assert(meta.nullSafeEnsemble === true, 'Null-safe ensemble finalization completed');
assert(Number(meta.lineupBeatMatches) >= 175, 'At least 175 independent half-PPR projections are matched');
const skillPlayers = players.filter(player => ['QB', 'RB', 'WR', 'TE'].includes(player.pos));
assert(skillPlayers.every(player => Number(player.projectionEnsemble) > 0), 'Every skill player has a positive ensemble projection');
assert(skillPlayers.every(player => Number(player.projectionFloor) > 0 && Number(player.projectionFloor) < Number(player.projectionEnsemble)), 'Every skill player has a valid nonzero floor');
assert(skillPlayers.every(player => Number(player.projectionCeiling) > Number(player.projectionEnsemble)), 'Every skill player has a ceiling above projection');
assert(skillPlayers.every(player => Number(player.ensembleRank) > 0), 'Every skill player has a positive ensemble rank');
assert(players.filter(player => player.estimated).every(player => Number(player.valueRank) > 0), 'Missing value ranks are safely estimated rather than treated as zero');

const opening = Engine.rankPlayers(players, new Set(), [], 1);
assert(opening.length >= 12, 'Round 1 returns a deep recommendation board');
assert(opening[0].details.optimized === true, 'Round 1 uses rollout optimization');
assert(opening[0].details.rollouts >= 50, 'Round 1 evaluates at least 50 board paths per candidate');
assert(opening[0].details.horizon >= 2, 'Round 1 looks ahead multiple snake turns');
assert(new Set(opening.slice(0, 16).map(entry => entry.player.key)).size === Math.min(16, opening.length), 'Round 1 recommendations are unique');
assert(opening.slice(0, 16).every(entry => ['RB', 'WR'].includes(entry.player.pos)), 'Round 1 recommendations contain only RBs and WRs');

const expectedTopEight = [
  'Jahmyr Gibbs', 'Bijan Robinson', 'Puka Nacua', "Ja'Marr Chase",
  'Jaxon Smith-Njigba', 'Jonathan Taylor', 'Christian McCaffrey', 'Amon-Ra St. Brown'
];
const normalBlocked = blockedNames(expectedTopEight);
const normalPickNine = Engine.rankPlayers(players, normalBlocked, [], 1);
const normalTopFour = normalPickNine.slice(0, 4).map(entry => entry.player.name);
assert(normalTopFour.some(name => /James Cook/.test(name)), 'James Cook remains in the normal pick-9 decision tier');
assert(normalTopFour.some(name => /CeeDee Lamb|De'Von Achane|Derrick Henry|Chase Brown/.test(name)), 'Pick 9 preserves multiple credible alternatives');

const cook = players.find(player => /James Cook/.test(player.name));
const ceedee = players.find(player => player.name === 'CeeDee Lamb');
assert(Boolean(cook && ceedee), 'Core Round 1 branch players exist');

const roundTwoBlocked = new Set(normalBlocked);
for (const name of ['Derrick Henry', "De'Von Achane", 'CeeDee Lamb', 'Justin Jefferson', 'Chase Brown', 'Drake London', 'Saquon Barkley', 'Rashee Rice']) {
  const player = byName.get(name);
  if (player) roundTwoBlocked.add(player.key);
}
roundTwoBlocked.add(cook.key);
const afterCook = Engine.rankPlayers(players, roundTwoBlocked, [cook], 2);
const cookTop = afterCook.slice(0, 8).map(entry => entry.player);
assert(cookTop.some(player => player.pos === 'RB'), 'RB-first Round 2 board retains a premium RB option');
assert(cookTop.some(player => player.pos === 'WR'), 'RB-first Round 2 board retains an elite WR option');
assert(afterCook[0].details.commonNextPositions.length > 0, 'Round 2 recommendation reports its simulated continuation');

const afterCeedeeBlocked = new Set(normalBlocked);
afterCeedeeBlocked.add(ceedee.key);
for (const name of ['James Cook', 'Derrick Henry', "De'Von Achane", 'Chase Brown', 'Saquon Barkley']) {
  const player = byName.get(name);
  if (player) afterCeedeeBlocked.add(player.key);
}
const afterCeedee = Engine.rankPlayers(players, afterCeedeeBlocked, [ceedee], 2);
assert(afterCeedee.slice(0, 4).some(entry => entry.player.pos === 'RB'), 'WR-first Round 2 board places an RB in the top four');

const walker = players.find(player => player.name === 'Kenneth Walker');
assert(Boolean(walker), 'Kenneth Walker exists in the player pool');
const earlyRoster = [cook, walker];
const earlyBlocked = new Set([...normalBlocked, cook.key, walker.key]);
for (const name of ['Derrick Henry', "De'Von Achane", 'CeeDee Lamb', 'Justin Jefferson', 'Chase Brown', 'Drake London', 'Saquon Barkley', 'A.J. Brown', 'Rashee Rice', 'George Pickens', 'Nico Collins', 'Omarion Hampton', 'Chris Olave', 'Malik Nabers', 'Kyren Williams']) {
  const player = byName.get(name);
  if (player) earlyBlocked.add(player.key);
}
const roundThree = Engine.rankPlayers(players, earlyBlocked, earlyRoster, 3);
assert(roundThree[0].player.pos === 'WR', 'RB-RB opening makes WR the top Round 3 recommendation');

for (const round of [15, 16]) {
  const late = Engine.rankPlayers(players, new Set(), [], round);
  assert(late.length > 0, `Round ${round} has recommendations`);
  assert(late.every(entry => entry.player.pos === (round === 15 ? 'DEF' : 'K')), `Round ${round} restricts recommendations to the correct position`);
}

const repeat = Engine.rankPlayers(players, normalBlocked, [], 1);
assert(repeat[0].player.key === normalPickNine[0].player.key, 'Optimizer is deterministic for an unchanged draft state');
assert(Engine.MODEL_VERSION === 'ensemble-rollout-v3', 'Rollout engine implementation is active before metadata labeling');

console.log(JSON.stringify({ passed: assertions.length, dataModel: meta.modelVersion, engine: Engine.MODEL_VERSION, normalTopFour }, null, 2));
