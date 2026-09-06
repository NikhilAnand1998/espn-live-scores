import fs from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node patch-actionable-fallers.mjs <input-app.js> <output-app.js>');
}

let source = fs.readFileSync(inputPath, 'utf8');

function replaceOnce(before, after, label) {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  "const storageKey = 'pick9-adversarial-ux-v2';",
  "const storageKey = 'pick9-adversarial-ux-v3';",
  'new saved-state version'
);

replaceOnce(
  "let state = { selected: [], retired: [], more: 0 };",
  "let state = { selected: [], more: 0 };",
  'remove inferred retired-player state'
);

replaceOnce(
  "  state.retired = (state.retired || []).map(list =>\n    (list || []).filter(key => byKey.has(key))\n  );\n",
  "",
  'remove retired-player state normalization'
);

replaceOnce(
  "  function blockedKeys() {\n    return new Set([\n      ...state.selected,\n      ...(state.retired || []).flat()\n    ]);\n  }",
  "  function blockedKeys() {\n    // Only the user's own selections are certain. Unselected players remain in\n    // the model so they can reappear as actionable fallers on a later turn.\n    return new Set(state.selected);\n  }",
  'block only selected players'
);

const oldSplitBoard = `  function splitBoard(entries, currentRound) {
    if (currentRound >= 15) return { fallers: [], expected: entries };
    const overallPick = Engine.PICKS[currentRound - 1];
    const fallers = entries.filter(entry => {
      const player = entry.player;
      const modelRank = Number(player.ensembleRank ?? player.valueRank ?? player.adp);
      return entry.availability.probability < 0.48 && modelRank <= overallPick - 2;
    }).slice(0, 4);
    const fallerKeys = new Set(fallers.map(entry => entry.player.key));
    let expected = entries.filter(entry =>
      !fallerKeys.has(entry.player.key) && entry.availability.probability >= 0.22
    );
    if (expected.length < 6) {
      const used = new Set([...fallerKeys, ...expected.map(entry => entry.player.key)]);
      expected = [...expected, ...entries.filter(entry => !used.has(entry.player.key))];
    }
    return { fallers, expected };
  }`;

const newSplitBoard = `  function splitBoard(entries, currentRound) {
    if (currentRound >= 15) return { fallers: [], expected: entries };
    const overallPick = Engine.PICKS[currentRound - 1];
    const modelRank = entry => Number(entry.player.ensembleRank ?? entry.player.valueRank ?? entry.player.adp);
    const lateGap = entry => Math.max(0, overallPick - Number(entry.availability.range?.late || entry.player.adp));

    const allFallers = entries.filter(entry =>
      entry.availability.probability < 0.48 && modelRank(entry) <= overallPick - 2
    );

    // Draft night needs plausible, decision-relevant fallers rather than four
    // nearly impossible superstars crowding out players from the prior tier.
    const actionable = [...allFallers].sort((a, b) =>
      lateGap(a) - lateGap(b)
      || b.availability.probability - a.availability.probability
      || modelRank(a) - modelRank(b)
    );
    const dream = [...allFallers].sort((a, b) => modelRank(a) - modelRank(b))[0];
    const fallers = [];
    for (const entry of [...actionable.slice(0, 5), dream].filter(Boolean)) {
      if (!fallers.some(existing => existing.player.key === entry.player.key)) fallers.push(entry);
    }

    const fallerKeys = new Set(fallers.map(entry => entry.player.key));
    let expected = entries.filter(entry =>
      !fallerKeys.has(entry.player.key) && entry.availability.probability >= 0.22
    );
    if (expected.length < 6) {
      const used = new Set([...fallerKeys, ...expected.map(entry => entry.player.key)]);
      expected = [...expected, ...entries.filter(entry => !used.has(entry.player.key))];
    }
    return { fallers: fallers.slice(0, 6), expected };
  }`;
replaceOnce(oldSplitBoard, newSplitBoard, 'actionable faller selection');

replaceOnce(
  "    const baseCount = currentRound === 1 ? 7 : 6;",
  "    const baseCount = currentRound === 1 ? 8 : 6;",
  'show full pick-nine decision tier'
);

replaceOnce(
  '<div><span class="eyebrow">CHECK FIRST</span><h3 id="faller-title">Premium fallers</h3></div>\n            <p>Unlikely to reach you, but priority picks when they do.</p>',
  '<div><span class="eyebrow">CHECK FIRST</span><h3 id="faller-title">Actionable fallers</h3></div>\n            <p>Players from the prior tier who would be strong values if still available.</p>',
  'rename faller section'
);

replaceOnce(
  "      const entries = rankedEntries(currentRound);\n      const index = entries.findIndex(entry => entry.player.key === playerKey);\n      if (index < 0) return;\n      snapshot();\n      state.retired[currentRound - 1] = entries.slice(0, index).map(entry => entry.player.key);",
  "      const entries = rankedEntries(currentRound);\n      if (!entries.some(entry => entry.player.key === playerKey)) return;\n      snapshot();",
  'do not infer that higher-ranked unselected players are gone'
);

replaceOnce(
  "      state.retired = state.retired.slice(0, index);\n",
  "",
  'do not retain inferred removals when reopening a round'
);

replaceOnce(
  "      state = { selected: [], retired: [], more: 0 };",
  "      state = { selected: [], more: 0 };",
  'reset no-retirement state'
);

fs.writeFileSync(outputPath, source);
console.log(`Patched ${inputPath} -> ${outputPath}: unselected players remain eligible and fallers are ranked by actionability.`);
