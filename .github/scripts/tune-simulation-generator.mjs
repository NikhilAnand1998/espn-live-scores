import fs from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node tune-simulation-generator.mjs <input-generator> <output-generator>');
}

let source = fs.readFileSync(inputPath, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Simulation patch target not found: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  `  const rosterCounts = counts(roster);\n  let best = null;`,
  `  const rosterCounts = counts(roster);\n  let forcedPosition = null;\n  if (strategy.id === 'hero_rb' && round === 1) forcedPosition = 'RB';\n  if (strategy.id === 'robust_rb' && round <= 3 && rosterCounts.RB < 2) forcedPosition = 'RB';\n  if (strategy.id === 'wr_avalanche' && round <= 2 && rosterCounts.WR < 2) forcedPosition = 'WR';\n  if (strategy.id === 'elite_te' && round === 5 && rosterCounts.TE < 1) forcedPosition = 'TE';\n  if (strategy.id === 'elite_qb' && round === 5 && rosterCounts.QB < 1) forcedPosition = 'QB';\n  if (strategy.id === 'late_qb' && round === 8 && rosterCounts.QB < 1) forcedPosition = 'QB';\n  let best = null;`,
  'explicit strategy identity'
);

replaceOnce(
  `    if (!available.has(player.key) || !isEligible(player, rosterCounts, round)) continue;\n    const adp = finite(player.adp, 250);`,
  `    if (!available.has(player.key) || !isEligible(player, rosterCounts, round)) continue;\n    if (strategy.id === 'late_qb' && round < 8 && player.pos === 'QB') continue;\n    if (forcedPosition && player.pos !== forcedPosition) continue;\n    const adp = finite(player.adp, 250);`,
  'forced-position filtering'
);

replaceOnce(
  `  const realism = plausibility >= 0.43 && longShotCount === 0\n    ? 'Realistic'\n    : plausibility >= 0.30 && longShotCount <= 1\n      ? 'Aggressive'\n      : 'Dream outcome';`,
  `  const veryLongShotCount = probabilities.filter(value => value < 0.03).length;\n  const realism = plausibility >= 0.115 && veryLongShotCount === 0 && longShotCount <= 1 && reachCount <= 2\n    ? 'Realistic'\n    : plausibility >= 0.035 && veryLongShotCount <= 1 && longShotCount <= 3 && reachCount <= 4\n      ? 'Aggressive'\n      : 'Dream outcome';`,
  'calibrated realism bands'
);

replaceOnce(
  `const overallTop = [];\nconst globalScores = [];`,
  `const overallTop = [];\nconst realisticTop = [];\nconst aggressiveTop = [];\nconst globalScores = [];`,
  'realism-specific leaderboards'
);

replaceOnce(
  `    insertTop(stats.top, draft, KEEP_PER_STRATEGY);\n    insertTop(overallTop, draft, KEEP_OVERALL);\n    globalScores.push(draft.modelScore);`,
  `    insertTop(stats.top, draft, KEEP_PER_STRATEGY);\n    insertTop(overallTop, draft, KEEP_OVERALL);\n    if (draft.realism === 'Realistic') insertTop(realisticTop, draft, KEEP_OVERALL);\n    if (draft.realism === 'Aggressive') insertTop(aggressiveTop, draft, KEEP_OVERALL);\n    globalScores.push(draft.modelScore);`,
  'collect realistic and aggressive drafts'
);

replaceOnce(
  `const cleanedOverall = diverseTop(overallTop, DISPLAY_OVERALL, 3).map(cleanDraft);`,
  `const selectedOverall = [];\nconst addOverall = draft => {\n  if (!draft || selectedOverall.some(existing => existing.rosterKey === draft.rosterKey)) return;\n  selectedOverall.push(draft);\n};\nfor (const draft of diverseTop(realisticTop, 4, 2)) addOverall(draft);\nfor (const draft of diverseTop(aggressiveTop, 4, 2)) addOverall(draft);\nfor (const draft of diverseTop(overallTop, DISPLAY_OVERALL, 3)) addOverall(draft);\nconst cleanedOverall = selectedOverall\n  .slice(0, DISPLAY_OVERALL)\n  .sort((a, b) => b.modelScore - a.modelScore || b.expectedStarter - a.expectedStarter)\n  .map(cleanDraft);`,
  'mixed overall leaderboard'
);

replaceOnce(
  `    realism: draft.realism,\n    opening: draft.opening,`,
  `    realism: draft.realism,\n    plausibility: draft.plausibility,\n    longShotCount: draft.longShotCount,\n    opening: draft.opening,`,
  'diagnostic summary fields'
);

fs.writeFileSync(outputPath, source);
console.log(`Tuned ${inputPath} -> ${outputPath}: explicit strategy constraints and balanced realism categories.`);
