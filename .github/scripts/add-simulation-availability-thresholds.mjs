import fs from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node add-simulation-availability-thresholds.mjs <input-generator> <output-generator>');
}

const configuredThresholds = [0, 10, 20, 35, 50];
const configuredDefault = 35;
let source = fs.readFileSync(inputPath, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Threshold patch target not found: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  'const DISPLAY_OVERALL = 12;\n',
  `const DISPLAY_OVERALL = 12;\nconst AVAILABILITY_THRESHOLDS = [${configuredThresholds.join(', ')}];\nconst DEFAULT_AVAILABILITY_THRESHOLD = ${configuredDefault};\nconst THRESHOLD_KEEP_OVERALL = 120;\nconst THRESHOLD_KEEP_PER_STRATEGY = 36;\n`,
  'threshold constants'
);

replaceOnce(
  'const globalScores = [];\nconst startedAt = Date.now();',
  `const globalScores = [];\nconst thresholdPools = Object.fromEntries(AVAILABILITY_THRESHOLDS.map(threshold => [String(threshold), {\n  threshold,\n  eligibleDrafts: 0,\n  eligibleByStrategy: Object.fromEntries(STRATEGIES.map(strategy => [strategy.id, 0])),\n  overall: [],\n  byStrategy: Object.fromEntries(STRATEGIES.map(strategy => [strategy.id, []]))\n}]));\nconst startedAt = Date.now();`,
  'threshold pools'
);

replaceOnce(
  '    globalScores.push(draft.modelScore);\n    roomResults.push(draft);',
  `    globalScores.push(draft.modelScore);\n    for (const threshold of AVAILABILITY_THRESHOLDS) {\n      if (draft.weakestAvailability * 100 + 1e-9 < threshold) continue;\n      const thresholdPool = thresholdPools[String(threshold)];\n      thresholdPool.eligibleDrafts += 1;\n      thresholdPool.eligibleByStrategy[strategy.id] += 1;\n      insertTop(thresholdPool.overall, draft, THRESHOLD_KEEP_OVERALL);\n      insertTop(thresholdPool.byStrategy[strategy.id], draft, THRESHOLD_KEEP_PER_STRATEGY);\n    }\n    roomResults.push(draft);`,
  'collect threshold-qualified drafts'
);

replaceOnce(
  'const payload = {\n',
  `const thresholdResults = {};\nfor (const threshold of AVAILABILITY_THRESHOLDS) {\n  const pool = thresholdPools[String(threshold)];\n  const thresholdOverall = diverseTop(pool.overall, DISPLAY_OVERALL, 3).map(cleanDraft);\n  const thresholdByStrategy = {};\n  thresholdOverall.forEach((draft, index) => { draft.thresholdRank = index + 1; });\n  for (const strategy of STRATEGIES) {\n    thresholdByStrategy[strategy.id] = diverseTop(pool.byStrategy[strategy.id], DISPLAY_PER_STRATEGY).map(cleanDraft);\n    thresholdByStrategy[strategy.id].forEach((draft, index) => { draft.strategyThresholdRank = index + 1; });\n  }\n  thresholdResults[String(threshold)] = {\n    threshold,\n    eligibleDrafts: pool.eligibleDrafts,\n    eligibleByStrategy: pool.eligibleByStrategy,\n    overall: thresholdOverall,\n    byStrategy: thresholdByStrategy\n  };\n}\n\nconst defaultThresholdResult = thresholdResults[String(DEFAULT_AVAILABILITY_THRESHOLD)];\nif (!defaultThresholdResult || defaultThresholdResult.overall.length < 6) {\n  throw new Error(\`The default \${DEFAULT_AVAILABILITY_THRESHOLD}% availability floor produced only \${defaultThresholdResult?.overall.length || 0} ranked drafts.\`);\n}\n\nconst payload = {\n`,
  'build threshold result indexes'
);

replaceOnce(
  '    elapsedMs: Date.now() - startedAt\n',
  `    elapsedMs: Date.now() - startedAt,\n    availabilityThresholds: AVAILABILITY_THRESHOLDS,\n    defaultAvailabilityThreshold: DEFAULT_AVAILABILITY_THRESHOLD,\n    availabilityThresholdMeaning: 'Every QB, RB, WR, and TE selection in a displayed roster must have at least this modeled chance of being available at that exact pick. DEF and K are excluded.'\n`,
  'threshold metadata'
);

replaceOnce(
  '  overall: cleanedOverall,\n  ceiling: cleanedCeiling,\n  byStrategy: cleanedByStrategy\n',
  `  overall: defaultThresholdResult.overall,\n  ceiling: cleanedCeiling,\n  byStrategy: defaultThresholdResult.byStrategy,\n  thresholds: thresholdResults\n`,
  'threshold-aware payload lists'
);

fs.writeFileSync(outputPath, source);
console.log(`Added availability-floor indexes ${configuredThresholds.join(', ')} to ${outputPath}; default ${configuredDefault}%.`);
