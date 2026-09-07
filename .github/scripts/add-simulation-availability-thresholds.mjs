import fs from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node add-simulation-availability-thresholds.mjs <input-generator> <output-generator>');
}

const configuredThresholds = [0, 10, 20, 35, 50];
const configuredDefault = 35;
const configuredMaxRound = 12;
let source = fs.readFileSync(inputPath, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Threshold patch target not found: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  'const DISPLAY_OVERALL = 12;\n',
  `const DISPLAY_OVERALL = 12;\nconst AVAILABILITY_THRESHOLDS = [${configuredThresholds.join(', ')}];\nconst DEFAULT_AVAILABILITY_THRESHOLD = ${configuredDefault};\nconst AVAILABILITY_FLOOR_MAX_ROUND = ${configuredMaxRound};\nconst THRESHOLD_KEEP_OVERALL = 120;\nconst THRESHOLD_KEEP_PER_STRATEGY = 36;\n`,
  'threshold constants'
);

replaceOnce(
  'function chooseUser(strategy, available, roster, round, random, riskTolerance) {',
  `function meetsAvailabilityFloor(player, round, minimumAvailability) {\n  if (minimumAvailability <= 0 || round > AVAILABILITY_FLOOR_MAX_ROUND) return true;\n  return Availability.probabilityAtPick(player, PICKS[round - 1]) * 100 + 1e-9 >= minimumAvailability;\n}\n\nfunction thresholdMinimumForDraft(draft) {\n  const values = (draft.picks || [])\n    .filter(pick => pick.round <= AVAILABILITY_FLOOR_MAX_ROUND && !['DEF', 'K'].includes(pick.pos))\n    .map(pick => Number(pick.availability))\n    .filter(Number.isFinite);\n  return values.length ? Math.min(...values) : 0;\n}\n\nfunction chooseUser(strategy, available, roster, round, random, riskTolerance, minimumAvailability = 0) {`,
  'availability helper and chooseUser parameter'
);

replaceOnce(
  `    if (!available.has(player.key) || !isEligible(player, rosterCounts, round)) continue;\n    if (strategy.id === 'late_qb' && round < 8 && player.pos === 'QB') continue;\n    if (forcedPosition && player.pos !== forcedPosition) continue;\n    const adp = finite(player.adp, 250);\n    const sd = Math.max(1.5, finite(player.sd, 8));`,
  `    if (!available.has(player.key) || !isEligible(player, rosterCounts, round)) continue;\n    if (strategy.id === 'late_qb' && round < 8 && player.pos === 'QB') continue;\n    if (forcedPosition && player.pos !== forcedPosition) continue;\n    if (!meetsAvailabilityFloor(player, round, minimumAvailability)) continue;\n    const adp = finite(player.adp, 250);\n    const sd = Math.max(1.5, finite(player.sd, 8));`,
  'candidate availability gate inside chooseUser'
);

replaceOnce(
  'function simulateStrategy(strategy, roomIndex, scenario, board) {',
  'function simulateStrategy(strategy, roomIndex, scenario, board, minimumAvailability = 0) {',
  'simulateStrategy parameter'
);

replaceOnce(
  '  const random = mulberry32(hashString(`${MASTER_SEED}|decision|${roomIndex}|${strategy.id}`));',
  '  const random = mulberry32(hashString(`${MASTER_SEED}|decision|${roomIndex}|${strategy.id}|floor-${minimumAvailability}`));',
  'threshold-specific decision seed'
);

replaceOnce(
  '      let selected = chooseUser(strategy, available, roster, round, random, riskTolerance);',
  '      let selected = chooseUser(strategy, available, roster, round, random, riskTolerance, minimumAvailability);',
  'pass threshold into user policy'
);

replaceOnce(
  `        selected = players\n          .filter(player => available.has(player.key) && isEligible(player, fallbackCounts, round))\n          .sort((a, b) => metrics.get(a.key).rank - metrics.get(b.key).rank)[0] || null;`,
  `        let fallbackPool = players\n          .filter(player => available.has(player.key)\n            && isEligible(player, fallbackCounts, round)\n            && meetsAvailabilityFloor(player, round, minimumAvailability));\n        if (!fallbackPool.length) {\n          fallbackPool = players\n            .filter(player => available.has(player.key) && isEligible(player, fallbackCounts, round));\n        }\n        selected = fallbackPool\n          .sort((a, b) => metrics.get(a.key).rank - metrics.get(b.key).rank)[0] || null;`,
  'threshold-aware fallback pool'
);

replaceOnce(
  `    weakestAvailability: Number((draft.weakestAvailability * 100).toFixed(1)),\n    realism: draft.realism,`,
  `    weakestAvailability: Number((draft.weakestAvailability * 100).toFixed(1)),\n    thresholdMinimumAvailability: Number(((draft.thresholdMinimumAvailability ?? draft.weakestAvailability) * 100).toFixed(1)),\n    realism: draft.realism,`,
  'clean threshold minimum metric'
);

replaceOnce(
  'const globalScores = [];\nconst startedAt = Date.now();',
  `const globalScores = [];\nconst thresholdPools = Object.fromEntries(AVAILABILITY_THRESHOLDS.map(threshold => [String(threshold), {\n  threshold,\n  attemptedDrafts: 0,\n  eligibleDrafts: 0,\n  eligibleByStrategy: Object.fromEntries(STRATEGIES.map(strategy => [strategy.id, 0])),\n  overall: [],\n  byStrategy: Object.fromEntries(STRATEGIES.map(strategy => [strategy.id, []]))\n}]));\nconst startedAt = Date.now();`,
  'threshold pools'
);

replaceOnce(
  '    globalScores.push(draft.modelScore);\n    roomResults.push(draft);',
  `    globalScores.push(draft.modelScore);\n    for (const threshold of AVAILABILITY_THRESHOLDS) {\n      const thresholdPool = thresholdPools[String(threshold)];\n      thresholdPool.attemptedDrafts += 1;\n      const thresholdSimulation = threshold === 0\n        ? simulation\n        : simulateStrategy(strategy, roomIndex, scenario, board, threshold);\n      const thresholdDraft = threshold === 0\n        ? draft\n        : scoreDraft(strategy, roomIndex, scenario, thresholdSimulation);\n      if (threshold > 0) thresholdDraft.id = \`${'${thresholdDraft.id}'}-floor-${'${threshold}'}\`;\n      thresholdDraft.thresholdMinimumAvailability = thresholdMinimumForDraft(thresholdDraft);\n      if (thresholdDraft.thresholdMinimumAvailability * 100 + 1e-9 < threshold) continue;\n      thresholdPool.eligibleDrafts += 1;\n      thresholdPool.eligibleByStrategy[strategy.id] += 1;\n      insertTop(thresholdPool.overall, thresholdDraft, THRESHOLD_KEEP_OVERALL);\n      insertTop(thresholdPool.byStrategy[strategy.id], thresholdDraft, THRESHOLD_KEEP_PER_STRATEGY);\n    }\n    roomResults.push(draft);`,
  'run threshold-aware policy variants'
);

replaceOnce(
  'const payload = {\n',
  `const thresholdResults = {};\nfor (const threshold of AVAILABILITY_THRESHOLDS) {\n  const pool = thresholdPools[String(threshold)];\n  const thresholdOverall = diverseTop(pool.overall, DISPLAY_OVERALL, 3).map(cleanDraft);\n  const thresholdByStrategy = {};\n  thresholdOverall.forEach((draft, index) => { draft.thresholdRank = index + 1; });\n  for (const strategy of STRATEGIES) {\n    thresholdByStrategy[strategy.id] = diverseTop(pool.byStrategy[strategy.id], DISPLAY_PER_STRATEGY).map(cleanDraft);\n    thresholdByStrategy[strategy.id].forEach((draft, index) => { draft.strategyThresholdRank = index + 1; });\n  }\n  thresholdResults[String(threshold)] = {\n    threshold,\n    maxRound: AVAILABILITY_FLOOR_MAX_ROUND,\n    attemptedDrafts: pool.attemptedDrafts,\n    eligibleDrafts: pool.eligibleDrafts,\n    eligibleByStrategy: pool.eligibleByStrategy,\n    overall: thresholdOverall,\n    byStrategy: thresholdByStrategy\n  };\n}\n\nconst defaultThresholdResult = thresholdResults[String(DEFAULT_AVAILABILITY_THRESHOLD)];\nif (!defaultThresholdResult || defaultThresholdResult.overall.length < 6) {\n  throw new Error(\`The default \${DEFAULT_AVAILABILITY_THRESHOLD}% core-pick availability floor produced only \${defaultThresholdResult?.overall.length || 0} ranked drafts from \${defaultThresholdResult?.eligibleDrafts || 0} eligible paths.\`);\n}\n\nconst payload = {\n`,
  'build threshold result indexes'
);

replaceOnce(
  '    totalCompletedDrafts: ROOMS * STRATEGIES.length,',
  '    totalCompletedDrafts: ROOMS * STRATEGIES.length * AVAILABILITY_THRESHOLDS.length,\n    baseStrategyDrafts: ROOMS * STRATEGIES.length,',
  'actual completed path count'
);

replaceOnce(
  '    elapsedMs: Date.now() - startedAt\n',
  `    elapsedMs: Date.now() - startedAt,\n    availabilityThresholds: AVAILABILITY_THRESHOLDS,\n    defaultAvailabilityThreshold: DEFAULT_AVAILABILITY_THRESHOLD,\n    availabilityFloorMaxRound: AVAILABILITY_FLOOR_MAX_ROUND,\n    availabilityThresholdMeaning: 'Every QB, RB, WR, and TE selection through Round 12 must have at least this modeled chance of being available at that exact pick. Rounds 13-14 are late bench dart throws; DEF and K are excluded.'\n`,
  'threshold metadata'
);

replaceOnce(
  '  overall: cleanedOverall,\n  ceiling: cleanedCeiling,\n  byStrategy: cleanedByStrategy\n',
  `  overall: defaultThresholdResult.overall,\n  ceiling: cleanedCeiling,\n  byStrategy: defaultThresholdResult.byStrategy,\n  thresholds: thresholdResults\n`,
  'threshold-aware payload lists'
);

fs.writeFileSync(outputPath, source);
console.log(`Added threshold-aware draft variants for ${configuredThresholds.join(', ')}% floors through Round ${configuredMaxRound} to ${outputPath}; default ${configuredDefault}%.`);
