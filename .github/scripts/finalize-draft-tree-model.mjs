import fs from 'node:fs';
import vm from 'node:vm';

const dataPath = process.argv[2] || 'data.js';

function validNumber(value, { positive = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (positive && number <= 0) return null;
  return number;
}

function weightedMean(items) {
  const usable = items
    .map(item => ({ value: validNumber(item.value, { positive: true }), weight: Number(item.weight) }))
    .filter(item => item.value !== null && Number.isFinite(item.weight) && item.weight > 0);
  if (!usable.length) return null;
  const sorted = usable.map(item => item.value).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let numerator = 0;
  let denominator = 0;
  for (const item of usable) {
    const winsorized = Math.max(median - 30, Math.min(median + 30, item.value));
    numerator += winsorized * item.weight;
    denominator += item.weight;
  }
  return denominator ? numerator / denominator : null;
}

function standardDeviation(values) {
  const usable = values.map(value => validNumber(value, { positive: true })).filter(value => value !== null);
  if (usable.length < 2) return 0;
  const average = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  return Math.sqrt(usable.reduce((sum, value) => sum + (value - average) ** 2, 0) / usable.length);
}

const source = fs.readFileSync(dataPath, 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: dataPath });
const players = Array.from(sandbox.window.players || []);
const meta = { ...(sandbox.window.draftMeta || {}) };
if (players.length < 200) throw new Error(`Only ${players.length} players found in ${dataPath}`);

const cvByPosition = { QB: 0.15, RB: 0.26, WR: 0.23, TE: 0.25, DEF: 0.16, K: 0.14 };
let fixedFloor = 0;
let fixedCeiling = 0;
let estimatedValueRanks = 0;
let marketPropPlayers = 0;

for (const player of players) {
  const baseProjection = validNumber(player.projection, { positive: true }) ?? 0;
  const lineupBeatProjection = validNumber(player.lineupBeatProjection, { positive: true });
  const marketPropProjection = validNumber(player.marketPropProjection, { positive: true });
  const giqProjection = validNumber(player.giqProjection, { positive: true });
  if (marketPropProjection !== null) marketPropPlayers += 1;

  const projectionItems = marketPropProjection !== null
    ? [
        { value: baseProjection, weight: 0.38 },
        { value: lineupBeatProjection, weight: 0.27 },
        { value: marketPropProjection, weight: 0.35 },
        { value: giqProjection, weight: 0.05 }
      ]
    : [
        { value: baseProjection, weight: 0.58 },
        { value: lineupBeatProjection, weight: 0.42 },
        { value: giqProjection, weight: 0.10 }
      ];
  const usableProjectionItems = projectionItems.filter(item => item.value !== null && item.value > 0);
  const projectionWeight = usableProjectionItems.reduce((sum, item) => sum + item.weight, 0);
  const projectionEnsemble = projectionWeight
    ? usableProjectionItems.reduce((sum, item) => sum + item.value * item.weight, 0) / projectionWeight
    : baseProjection;
  player.projectionEnsemble = projectionEnsemble;
  player.projectionSourceCount = usableProjectionItems.length;

  const rankItems = marketPropProjection !== null
    ? [
        { value: player.adp, weight: 0.24 },
        { value: player.valueRank, weight: 0.18 },
        { value: player.consensusRank, weight: 0.14 },
        { value: player.rotowireRank, weight: 0.12 },
        { value: player.giqRank, weight: 0.03 },
        { value: player.lineupBeatValueRank, weight: 0.11 },
        { value: player.marketPropRank, weight: 0.20 }
      ]
    : [
        { value: player.adp, weight: 0.27 },
        { value: player.valueRank, weight: 0.20 },
        { value: player.consensusRank, weight: 0.16 },
        { value: player.rotowireRank, weight: 0.15 },
        { value: player.giqRank, weight: 0.06 },
        { value: player.lineupBeatValueRank, weight: 0.16 }
      ];
  player.ensembleRank = weightedMean(rankItems) ?? validNumber(player.adp, { positive: true }) ?? 999;

  const validRanks = rankItems
    .map(item => validNumber(item.value, { positive: true }))
    .filter(value => value !== null);
  player.rankSpread = standardDeviation(validRanks);
  player.modelSources = validRanks.length;

  if (validNumber(player.valueRank, { positive: true }) === null) {
    player.valueRank = player.ensembleRank;
    estimatedValueRanks += 1;
  }

  const projectionModels = [baseProjection, lineupBeatProjection, marketPropProjection, giqProjection]
    .map(value => validNumber(value, { positive: true }))
    .filter(value => value !== null);
  player.projectionSpread = standardDeviation(projectionModels);

  const cv = cvByPosition[player.pos] ?? 0.24;
  const marketFloor = validNumber(player.marketPropFloor, { positive: true });
  const marketCeiling = validNumber(player.marketPropCeiling, { positive: true });
  const giqFloor = validNumber(player.giqFloor, { positive: true });
  const giqCeiling = validNumber(player.giqCeiling, { positive: true });
  const fallbackFloor = Math.max(0, projectionEnsemble * (1 - cv * 1.05) - player.projectionSpread * 0.35);
  const fallbackCeiling = projectionEnsemble * (1 + cv * 1.18) + player.projectionSpread * 0.45;

  if (marketFloor !== null && marketFloor < projectionEnsemble) {
    player.projectionFloor = marketFloor * 0.75 + fallbackFloor * 0.25;
  } else if (giqFloor !== null && giqFloor < projectionEnsemble) {
    player.projectionFloor = giqFloor * 0.65 + fallbackFloor * 0.35;
  } else {
    player.projectionFloor = fallbackFloor;
  }

  if (marketCeiling !== null && marketCeiling > projectionEnsemble) {
    player.projectionCeiling = marketCeiling * 0.75 + fallbackCeiling * 0.25;
  } else if (giqCeiling !== null && giqCeiling > projectionEnsemble) {
    player.projectionCeiling = giqCeiling * 0.65 + fallbackCeiling * 0.35;
  } else {
    player.projectionCeiling = fallbackCeiling;
  }

  if (!(player.projectionFloor > 0) && projectionEnsemble > 0) {
    player.projectionFloor = fallbackFloor;
    fixedFloor += 1;
  }
  if (!(player.projectionCeiling > projectionEnsemble) && projectionEnsemble > 0) {
    player.projectionCeiling = fallbackCeiling;
    fixedCeiling += 1;
  }

  const rankConfidence = Math.max(0.15, 1 - player.rankSpread / 60);
  const projectionConfidence = projectionEnsemble > 0
    ? Math.max(0.2, 1 - player.projectionSpread / Math.max(40, projectionEnsemble * 0.35))
    : 0.2;
  const marketConfidence = marketPropProjection !== null
    ? Math.min(1, 0.55 + (validNumber(player.marketPropCount) ?? 0) / 70)
    : 0.45;
  player.modelConfidence = Math.max(0.15, Math.min(1,
    rankConfidence * 0.52 + projectionConfidence * 0.30 + marketConfidence * 0.18
  ));
}

const invalidPlayers = players.filter(player => {
  const projection = validNumber(player.projectionEnsemble, { positive: true });
  const floor = validNumber(player.projectionFloor, { positive: true });
  const ceiling = validNumber(player.projectionCeiling, { positive: true });
  if (!['QB', 'RB', 'WR', 'TE'].includes(player.pos)) return false;
  return projection === null || floor === null || ceiling === null || floor >= projection || ceiling <= projection;
});
if (invalidPlayers.length) {
  throw new Error(`Invalid finalized uncertainty ranges: ${invalidPlayers.slice(0, 10).map(player => player.name).join(', ')}`);
}

meta.modelVersion = 'ensemble-rollout-v6-market';
meta.finalizedAt = new Date().toISOString();
meta.nullSafeEnsemble = true;
meta.finalization = {
  skillPlayersValidated: players.filter(player => ['QB', 'RB', 'WR', 'TE'].includes(player.pos)).length,
  marketPropPlayers,
  estimatedValueRanks,
  fixedFloor,
  fixedCeiling
};

fs.writeFileSync(dataPath, `window.draftMeta=${JSON.stringify(meta)};\nwindow.players=${JSON.stringify(players)};\n`);
console.log(`Finalized ${players.length} players; ${meta.finalization.skillPlayersValidated} skill-player uncertainty ranges validated; ${marketPropPlayers} players use market-priced props; ${estimatedValueRanks} missing value ranks safely estimated.`);
