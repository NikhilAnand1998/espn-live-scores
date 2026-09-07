import { chromium } from 'playwright';

const siteUrl = process.env.SITE_URL || 'http://127.0.0.1:4173/';
const expectedPicks = [9, 20, 37, 48, 65, 76, 93, 104, 121, 132, 149, 160, 177, 188, 205, 216];
const checks = [];

function assert(value, label, details = '') {
  if (!value) throw new Error(`FAILED: ${label}${details ? ` — ${details}` : ''}`);
  checks.push(label);
  console.log(`PASS: ${label}`);
}

function validateDraft(draft) {
  assert(Array.isArray(draft.picks) && draft.picks.length === 16, `${draft.id} contains 16 selections`);
  assert(draft.picks.every((pick, index) => pick.overall === expectedPicks[index] && pick.round === index + 1), `${draft.id} uses exact pick-9 snake slots`);
  const keys = draft.picks.map(pick => `${pick.name}|${pick.pos}`);
  assert(new Set(keys).size === keys.length, `${draft.id} contains no duplicate players`);
  const counts = draft.picks.reduce((result, pick) => {
    result[pick.pos] = (result[pick.pos] || 0) + 1;
    return result;
  }, {});
  assert((counts.QB || 0) >= 1 && (counts.RB || 0) >= 2 && (counts.WR || 0) >= 2 && (counts.TE || 0) >= 1, `${draft.id} fills QB, 2 RB, 2 WR, and TE`);
  assert((counts.DEF || 0) === 1 && (counts.K || 0) === 1, `${draft.id} contains exactly one defense and kicker`);
  assert(draft.picks[14].pos === 'DEF' && draft.picks[15].pos === 'K', `${draft.id} reserves Rounds 15 and 16 for DEF and K`);
  assert(Number.isFinite(draft.modelScore) && Number.isFinite(draft.weeklyExpected) && Number.isFinite(draft.plausibility), `${draft.id} has finite ranking metrics`);
  assert(Number.isFinite(draft.weakestAvailability) && Number.isFinite(draft.sub15Count) && Number.isFinite(draft.sub20Count), `${draft.id} has conservative availability diagnostics`);
}

function validatePracticalDraft(draft) {
  assert(draft.recommended === true, `${draft.id} is approved for the practical list`);
  assert(draft.realism !== 'Ceiling only', `${draft.id} is not a ceiling-only roster`);
  assert(draft.veryLongShotCount === 0, `${draft.id} contains no sub-5% picks`);
  assert(draft.earlyLongShotCount <= 1, `${draft.id} contains at most one sub-10% pick in the first eight rounds`);
  assert(draft.longShotCount <= 2, `${draft.id} contains at most two sub-10% picks across the full roster`);
  assert(draft.sub15Count <= 6, `${draft.id} contains at most six sub-15% picks`);
  assert(draft.sub20Count <= 8, `${draft.id} contains at most eight sub-20% picks`);
  assert(draft.weakestAvailability >= 5, `${draft.id} has no displayed pick below 5%`);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

  const response = await page.goto(`${siteUrl}?simulation-audit=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  assert(Boolean(response?.ok()), 'simulation site loads successfully');
  await page.waitForSelector('[data-pick]', { timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.simulatedDrafts), null, { timeout: 60000 });

  const payload = await page.evaluate(() => window.simulatedDrafts);
  assert(payload.meta.totalCompletedDrafts >= 20000, 'at least 20,000 complete strategy drafts were simulated');
  assert(payload.meta.rooms >= 2500, 'simulation covers at least 2,500 independent draft rooms');
  assert(payload.meta.strategies >= 7, 'seven distinct strategies are represented');
  assert(payload.meta.simulationVersion.includes('conservative'), 'simulation payload uses the conservative ranking version');
  assert(payload.strategySummary.length === payload.meta.strategies, 'strategy leaderboard contains every strategy');
  assert(payload.overall.length >= 10, 'practical rankings contain at least ten distinct drafts');
  assert(Array.isArray(payload.ceiling) && payload.ceiling.length >= 3, 'ceiling outcomes remain available in a separate list');
  assert(Object.values(payload.byStrategy).every(list => list.length >= 3), 'every strategy has three ranked practical examples');

  const tier = draft => draft.conservative ? 0 : 1;
  assert(payload.overall.every((draft, index, list) => {
    if (index === 0) return true;
    const previous = list[index - 1];
    return tier(previous) < tier(draft)
      || (tier(previous) === tier(draft) && previous.modelScore >= draft.modelScore);
  }), 'practical drafts are conservative-first and then ordered by score');
  assert(payload.overall.some(draft => draft.realism === 'Conservative'), 'default rankings include strictly conservative rosters');
  assert(payload.ceiling.every(draft => draft.recommended === false && draft.realism === 'Ceiling only'), 'extreme outcomes are isolated from the practical list');

  payload.overall.forEach(draft => {
    validateDraft(draft);
    validatePracticalDraft(draft);
  });
  Object.values(payload.byStrategy).flat().forEach(draft => {
    validateDraft(draft);
    validatePracticalDraft(draft);
  });
  payload.ceiling.forEach(validateDraft);

  const byStrategy = payload.byStrategy;
  assert(byStrategy.hero_rb.every(draft => draft.picks[0].pos === 'RB'), 'Hero RB examples begin with a running back');
  assert(byStrategy.robust_rb.every(draft => draft.picks.slice(0, 3).filter(pick => pick.pos === 'RB').length >= 2), 'Robust RB examples take two backs in the first three rounds');
  assert(byStrategy.wr_avalanche.every(draft => draft.picks.slice(0, 4).filter(pick => pick.pos === 'WR').length >= 2), 'WR avalanche examples take at least two receivers in the first four rounds');
  assert(byStrategy.elite_te.every(draft => draft.picks.find(pick => pick.pos === 'TE')?.round <= 6), 'Elite TE examples secure tight end by Round 6');
  assert(byStrategy.elite_qb.every(draft => draft.picks.find(pick => pick.pos === 'QB')?.round <= 6), 'Elite QB examples secure quarterback by Round 6');
  assert(byStrategy.late_qb.every(draft => draft.picks.find(pick => pick.pos === 'QB')?.round >= 8), 'Late QB examples wait until Round 8 or later');

  assert(await page.locator('[role="tab"]').count() === 2, 'site exposes Live draft and Best simulated drafts tabs');
  await page.locator('[data-app-tab="simulations"]').click();
  await page.waitForSelector('.simulation-draft-card');
  assert(await page.locator('[data-app-panel="simulations"]').isVisible(), 'simulation panel is visible after tab selection');
  assert(!(await page.locator('[data-app-panel="live"]').isVisible()), 'live panel is hidden while simulation tab is active');
  assert(await page.locator('.simulation-strategy-card').count() === payload.meta.strategies, 'strategy leaderboard renders all strategies');
  assert(await page.locator('.simulation-draft-card').count() === payload.overall.length, 'best practical draft cards render by default');
  assert(await page.locator('.simulation-pick').count() >= 16, 'expanded top practical draft renders all selections');
  assert((await page.locator('[data-simulation-filter="overall"]').innerText()).includes('Best practical'), 'default filter is clearly labeled Best practical');
  assert(await page.locator('.simulation-realism.dream').count() === 0, 'default practical view contains no ceiling-only cards');

  await page.locator('[data-simulation-filter="ceiling"]').click();
  const ceilingIds = payload.ceiling.map(draft => draft.id);
  await page.waitForFunction(expectedIds => {
    const actualIds = [...document.querySelectorAll('.simulation-draft-card')]
      .map(card => card.getAttribute('data-simulation-draft'));
    return actualIds.length === expectedIds.length
      && actualIds.every(id => expectedIds.includes(id));
  }, ceilingIds, { timeout: 5000 });
  assert(await page.locator('.simulation-draft-card').count() === payload.ceiling.length, 'ceiling filter renders the isolated upside outcomes');
  assert(await page.locator('.simulation-realism.dream').count() === payload.ceiling.length, 'ceiling filter clearly labels every extreme roster');

  await page.locator('[data-simulation-filter="hero_rb"]').click();
  const heroIds = payload.byStrategy.hero_rb.map(draft => draft.id);
  await page.waitForFunction(expectedIds => {
    const actualIds = [...document.querySelectorAll('.simulation-draft-card')]
      .map(card => card.getAttribute('data-simulation-draft'));
    return actualIds.length === expectedIds.length
      && actualIds.every(id => expectedIds.includes(id));
  }, heroIds, { timeout: 5000 });
  const filteredIds = await page.locator('.simulation-draft-card').evaluateAll(cards =>
    cards.map(card => card.getAttribute('data-simulation-draft'))
  );
  assert(filteredIds.length === heroIds.length, 'strategy filter renders only Hero RB drafts');
  assert(filteredIds.every(id => heroIds.includes(id)), 'filtered cards match selected strategy');
  assert(await page.locator('[data-simulation-filter="hero_rb"]').getAttribute('aria-pressed') === 'true', 'strategy filter exposes its selected state');
  assert(await page.locator('.simulation-realism.dream').count() === 0, 'strategy examples also exclude ceiling-only outcomes');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, 'simulation tab has no horizontal overflow on a 390px phone', `overflow=${overflow}`);

  await page.locator('[data-app-tab="live"]').click();
  assert(await page.locator('[data-app-panel="live"]').isVisible(), 'tab control returns to the live draft assistant');
  assert(await page.locator('[data-player-name="Chase Brown"]').count() >= 1, 'live pick-9 board still surfaces Chase Brown');
  assert(errors.length === 0, 'simulation tab produces no browser or console errors', errors.join(' | '));

  console.log(JSON.stringify({ passed: true, totalChecks: checks.length, checks }, null, 2));
  await context.close();
} finally {
  await browser.close();
}
