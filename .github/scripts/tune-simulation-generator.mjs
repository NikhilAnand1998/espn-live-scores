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
  `  const longShotCount = probabilities.filter(value => value < 0.10).length;\n  const fallerCount = probabilities.filter(value => value < 0.30).length;\n  const reachCount = selections.filter(selection => {\n    const player = selection.player;\n    const allowance = Math.max(7, finite(player.sd, 8) * 0.62);\n    return finite(player.adp, 999) - selection.overall > allowance;\n  }).length;\n  const reachPenalty = selections.reduce((sum, selection) => {\n    const player = selection.player;\n    const allowance = Math.max(7, finite(player.sd, 8) * 0.62);\n    return sum + Math.max(0, finite(player.adp, 999) - selection.overall - allowance) * 1.25;\n  }, 0);\n  const realismPenalty = Math.max(0, 0.30 - plausibility) * 65\n    + longShotCount * 9\n    + probabilities.filter(value => value < 0.03).length * 8;\n  const completenessPenalty = complete ? 0 : 180;\n  const riskAdjusted = expectedStarter * 0.62 + floorStarter * 0.23 + ceilingStarter * 0.15 + benchValue;\n  const modelScore = riskAdjusted - reachPenalty - realismPenalty - completenessPenalty;\n  const realism = plausibility >= 0.43 && longShotCount === 0\n    ? 'Realistic'\n    : plausibility >= 0.30 && longShotCount <= 1\n      ? 'Aggressive'\n      : 'Dream outcome';`,
  `  const earlyProbabilities = selections\n    .filter(selection => selection.round <= 8)\n    .map(selection => clamp(selection.availability, 0.01, 0.99));\n  const veryLongShotCount = probabilities.filter(value => value < 0.05).length;\n  const longShotCount = probabilities.filter(value => value < 0.10).length;\n  const earlyLongShotCount = earlyProbabilities.filter(value => value < 0.10).length;\n  const sub15Count = probabilities.filter(value => value < 0.15).length;\n  const sub20Count = probabilities.filter(value => value < 0.20).length;\n  const fallerCount = probabilities.filter(value => value < 0.30).length;\n  const weakestAvailability = probabilities.length ? Math.min(...probabilities) : 0;\n  const reachCount = selections.filter(selection => {\n    const player = selection.player;\n    const allowance = Math.max(7, finite(player.sd, 8) * 0.62);\n    return finite(player.adp, 999) - selection.overall > allowance;\n  }).length;\n  const reachPenalty = selections.reduce((sum, selection) => {\n    const player = selection.player;\n    const allowance = Math.max(7, finite(player.sd, 8) * 0.62);\n    return sum + Math.max(0, finite(player.adp, 999) - selection.overall - allowance) * 1.25;\n  }, 0);\n  const rarePickPenalty = probabilities.reduce((sum, probability) => {\n    if (probability < 0.05) return sum + 35 + (0.05 - probability) * 350;\n    if (probability < 0.10) return sum + 14 + (0.10 - probability) * 180;\n    if (probability < 0.15) return sum + (0.15 - probability) * 60;\n    if (probability < 0.20) return sum + (0.20 - probability) * 15;\n    return sum;\n  }, 0);\n  const stackedFallPenalty = Math.pow(Math.max(0, longShotCount - 1), 2) * 22\n    + Math.pow(Math.max(0, sub15Count - 4), 2) * 8\n    + Math.pow(Math.max(0, sub20Count - 6), 2) * 4;\n  const realismPenalty = Math.max(0, 0.22 - plausibility) * 40\n    + rarePickPenalty\n    + stackedFallPenalty;\n  const completenessPenalty = complete ? 0 : 180;\n  const riskAdjusted = expectedStarter * 0.62 + floorStarter * 0.23 + ceilingStarter * 0.15 + benchValue;\n  const modelScore = riskAdjusted - reachPenalty - realismPenalty - completenessPenalty;\n  const conservative = weakestAvailability >= 0.075\n    && veryLongShotCount === 0\n    && longShotCount <= 1\n    && earlyLongShotCount <= 1\n    && sub15Count <= 4\n    && sub20Count <= 6\n    && reachCount <= 2;\n  const recommended = weakestAvailability >= 0.05\n    && veryLongShotCount === 0\n    && longShotCount <= 2\n    && earlyLongShotCount <= 1\n    && sub15Count <= 6\n    && sub20Count <= 8\n    && reachCount <= 3;\n  const realism = conservative\n    ? 'Conservative'\n    : recommended\n      ? 'Value-dependent'\n      : 'Ceiling only';`,
  'conservative stacked-faller scoring'
);

replaceOnce(
  `    plausibility,\n    realism,\n    longShotCount,\n    fallerCount,`,
  `    plausibility,\n    weakestAvailability,\n    realism,\n    conservative,\n    recommended,\n    veryLongShotCount,\n    longShotCount,\n    earlyLongShotCount,\n    sub15Count,\n    sub20Count,\n    fallerCount,`,
  'conservative draft diagnostics'
);

replaceOnce(
  `  openings: new Map(),\n  top: []`,
  `  openings: new Map(),\n  top: [],\n  practicalTop: [],\n  ceilingTop: []`,
  'strategy-specific practical pools'
);

replaceOnce(
  `const overallTop = [];\nconst globalScores = [];`,
  `const overallTop = [];\nconst practicalTop = [];\nconst ceilingTop = [];\nconst globalScores = [];`,
  'practical and ceiling leaderboards'
);

replaceOnce(
  `    insertTop(stats.top, draft, KEEP_PER_STRATEGY);\n    insertTop(overallTop, draft, KEEP_OVERALL);\n    globalScores.push(draft.modelScore);`,
  `    insertTop(stats.top, draft, KEEP_PER_STRATEGY);\n    insertTop(overallTop, draft, KEEP_OVERALL);\n    if (draft.recommended) {\n      insertTop(stats.practicalTop, draft, KEEP_PER_STRATEGY * 4);\n      insertTop(practicalTop, draft, KEEP_OVERALL * 3);\n    } else {\n      insertTop(stats.ceilingTop, draft, KEEP_PER_STRATEGY * 2);\n      insertTop(ceilingTop, draft, KEEP_OVERALL);\n    }\n    globalScores.push(draft.modelScore);`,
  'collect conservative display pools'
);

replaceOnce(
  `    plausibility: Number((draft.plausibility * 100).toFixed(1)),\n    realism: draft.realism,\n    longShotCount: draft.longShotCount,\n    fallerCount: draft.fallerCount,`,
  `    plausibility: Number((draft.plausibility * 100).toFixed(1)),\n    weakestAvailability: Number((draft.weakestAvailability * 100).toFixed(1)),\n    realism: draft.realism,\n    conservative: draft.conservative,\n    recommended: draft.recommended,\n    veryLongShotCount: draft.veryLongShotCount,\n    longShotCount: draft.longShotCount,\n    earlyLongShotCount: draft.earlyLongShotCount,\n    sub15Count: draft.sub15Count,\n    sub20Count: draft.sub20Count,\n    fallerCount: draft.fallerCount,`,
  'clean conservative metrics'
);

replaceOnce(
  `const cleanedByStrategy = {};\nfor (const strategy of STRATEGIES) {\n  cleanedByStrategy[strategy.id] = diverseTop(aggregate[strategy.id].top, DISPLAY_PER_STRATEGY).map(cleanDraft);\n}\nconst cleanedOverall = diverseTop(overallTop, DISPLAY_OVERALL, 3).map(cleanDraft);\ncleanedOverall.forEach((draft, index) => { draft.overallRank = index + 1; });\nfor (const strategy of STRATEGIES) {\n  cleanedByStrategy[strategy.id].forEach((draft, index) => { draft.strategyRank = index + 1; });\n}`,
  `function conservativeFirst(list) {\n  return [...list].sort((first, second) =>\n    Number(second.conservative) - Number(first.conservative)\n      || second.modelScore - first.modelScore\n      || second.expectedStarter - first.expectedStarter\n  );\n}\n\nif (practicalTop.length < DISPLAY_OVERALL) {\n  throw new Error(\`Only found \${practicalTop.length} practical drafts; need \${DISPLAY_OVERALL}.\`);\n}\n\nconst cleanedByStrategy = {};\nfor (const strategy of STRATEGIES) {\n  const candidates = conservativeFirst(aggregate[strategy.id].practicalTop);\n  if (candidates.length < DISPLAY_PER_STRATEGY) {\n    throw new Error(\`Only found \${candidates.length} practical \${strategy.label} drafts; need \${DISPLAY_PER_STRATEGY}.\`);\n  }\n  cleanedByStrategy[strategy.id] = diverseTop(candidates, DISPLAY_PER_STRATEGY).map(cleanDraft);\n}\nconst cleanedOverall = diverseTop(conservativeFirst(practicalTop), DISPLAY_OVERALL, 3).map(cleanDraft);\nconst cleanedCeiling = diverseTop(ceilingTop, 6, 2).map(cleanDraft);\ncleanedOverall.forEach((draft, index) => { draft.overallRank = index + 1; });\ncleanedCeiling.forEach((draft, index) => { draft.ceilingRank = index + 1; });\nfor (const strategy of STRATEGIES) {\n  cleanedByStrategy[strategy.id].forEach((draft, index) => { draft.strategyRank = index + 1; });\n}`,
  'conservative-first displayed rankings'
);

replaceOnce(
  `    simulationVersion: 'pick9-strategy-lab-v1',`,
  `    simulationVersion: 'pick9-strategy-lab-v2-conservative',`,
  'simulation version'
);

replaceOnce(
  `    rankingMethod: '62% expected starter points, 23% floor, 15% ceiling, weighted bench value, then penalties for implausible falls and material reaches.',\n    simulationMethod: 'Every room samples a complete 14-team board from exact-format ADP and draft-position variance. The user drafts from slot 9 at all 16 snake picks under each strategy.',`,
  `    rankingMethod: '62% expected starter points, 23% floor, 15% ceiling, weighted bench value, then escalating penalties for each sub-20%, sub-15%, sub-10%, and sub-5% availability pick—especially when several occur on one roster.',\n    simulationMethod: 'Every room samples a complete 14-team board from exact-format ADP and draft-position variance. The user drafts from slot 9 at all 16 snake picks under each strategy.',\n    displayPolicy: 'The default Best practical list excludes every roster containing a sub-5% pick, allows no more than one sub-10% pick in the first eight rounds and no more than two across all 14 skill-position rounds, then caps additional sub-15% and sub-20% falls. Extreme outcomes remain available only under Ceiling outcomes.',`,
  'conservative ranking explanation'
);

replaceOnce(
  `  overall: cleanedOverall,\n  byStrategy: cleanedByStrategy`,
  `  overall: cleanedOverall,\n  ceiling: cleanedCeiling,\n  byStrategy: cleanedByStrategy`,
  'ceiling list payload'
);

replaceOnce(
  `    realism: draft.realism,\n    opening: draft.opening,`,
  `    realism: draft.realism,\n    weakestAvailability: draft.weakestAvailability,\n    longShotCount: draft.longShotCount,\n    earlyLongShotCount: draft.earlyLongShotCount,\n    sub15Count: draft.sub15Count,\n    opening: draft.opening,`,
  'diagnostic summary fields'
);

fs.writeFileSync(outputPath, source);
console.log(`Tuned ${inputPath} -> ${outputPath}: conservative-first rankings, no sub-5% practical picks, and strict limits on stacked sub-10% outcomes.`);
