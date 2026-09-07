import vm from 'node:vm';

const SITE = 'https://nikhilanand1998.github.io/espn-live-scores/';
const PICKS = [9,20,37,48,65,76,93,104,121,132,149,160,177,188];

async function getText(path) {
  const response = await fetch(`${SITE}${path}?floor-diagnostic=${Date.now()}`, {
    headers: { 'user-agent': 'Mozilla/5.0 Pick9FloorDiagnostic/1.0' }
  });
  if (!response.ok) throw new Error(`${response.status} fetching ${path}`);
  return response.text();
}

const [dataSource, availabilitySource] = await Promise.all([
  getText('data.js'),
  getText('availability.js')
]);
const sandbox = { console, Math, Date, JSON, Set, Map, Number, String, Array, Object, Boolean };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(dataSource, sandbox, { filename: 'data.js' });
vm.runInContext(availabilitySource, sandbox, { filename: 'availability.js' });

const players = Array.from(sandbox.players || []).filter(player => ['QB','RB','WR','TE'].includes(player.pos) && !player.excluded);
const Availability = sandbox.DraftAvailability;
const thresholds = [10,20,35,50];
const rows = PICKS.map((pick, index) => {
  const ranked = players.map(player => ({
    name: player.name,
    pos: player.pos,
    adp: player.adp,
    probability: Availability.probabilityAtPick(player, pick)
  })).sort((a,b) => b.probability - a.probability);
  return {
    round: index + 1,
    pick,
    counts: Object.fromEntries(thresholds.map(threshold => [threshold, ranked.filter(row => row.probability * 100 >= threshold).length])),
    topFive: ranked.slice(0,5).map(row => ({...row, probability: +(row.probability * 100).toFixed(1)})),
    nearestAdp: [...ranked].sort((a,b) => Math.abs(a.adp-pick)-Math.abs(b.adp-pick)).slice(0,5).map(row => ({...row, probability: +(row.probability * 100).toFixed(1)}))
  };
});
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceMeta: sandbox.draftMeta,
  skillPlayers: players.length,
  thresholds,
  rows
}, null, 2));
