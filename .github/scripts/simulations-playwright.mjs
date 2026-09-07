import { chromium } from 'playwright';

const siteUrl = process.env.SITE_URL || 'http://127.0.0.1:4173/';
const expectedPicks = [9, 20, 37, 48, 65, 76, 93, 104, 121, 132, 149, 160, 177, 188, 205, 216];
const expectedThresholds = [0, 10, 20, 35, 50];
const checks = [];

function assert(value, label, details = '') {
  if (!value) throw new Error(`FAILED: ${label}${details ? ` — ${details}` : ''}`);
  checks.push(label);
  console.log(`PASS: ${label}`);
}

function validateDraft(draft, minimum = 0) {
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
  assert(Number.isFinite(draft.modelScore) && Number.isFinite(draft.weeklyExpected) && Number.isFinite(draft.weakestAvailability), `${draft.id} has finite ranking and availability metrics`);
  assert(draft.weakestAvailability + 0.001 >= minimum, `${draft.id} meets the ${minimum}% minimum availability floor`, `lowest=${draft.weakestAvailability}`);
  const skillPicks = draft.picks.filter(pick => !['DEF', 'K'].includes(pick.pos));
  assert(skillPicks.every(pick => Number(pick.availability) + 0.001 >= minimum), `${draft.id} has no individual skill pick below ${minimum}%`);
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
  assert(payload.meta.totalCompletedDrafts >= 35000, 'at least 35,000 complete strategy drafts were simulated');
  assert(payload.meta.rooms >= 5000, 'simulation covers at least 5,000 independent draft rooms');
  assert(payload.meta.strategies >= 7, 'seven distinct strategies are represented');
  assert(payload.meta.defaultAvailabilityThreshold === 35, '35% is the default minimum availability floor');
  assert(JSON.stringify(payload.meta.availabilityThresholds) === JSON.stringify(expectedThresholds), 'payload exposes 0%, 10%, 20%, 35%, and 50% floors');
  assert(Object.keys(payload.thresholds || {}).length === expectedThresholds.length, 'every availability floor has a precomputed result bucket');

  for (const threshold of expectedThresholds) {
    const bucket = payload.thresholds[String(threshold)];
    assert(Boolean(bucket), `${threshold}% threshold bucket exists`);
    assert(Number.isFinite(bucket.eligibleDrafts), `${threshold}% threshold reports its eligible draft count`);
    assert(bucket.overall.length <= 12, `${threshold}% threshold limits the overall display list`);
    bucket.overall.forEach(draft => validateDraft(draft, threshold));
    for (const list of Object.values(bucket.byStrategy || {})) list.forEach(draft => validateDraft(draft, threshold));
  }

  const defaultBucket = payload.thresholds['35'];
  assert(defaultBucket.overall.length >= 6, '35% floor contains at least six ranked overall drafts');
  assert(payload.overall.every(draft => draft.weakestAvailability >= 35), 'backward-compatible overall list also uses the 35% floor');
  assert(payload.ceiling.every(draft => draft.realism === 'Ceiling only'), 'extreme outcomes remain isolated in the ceiling list');

  const byStrategy = defaultBucket.byStrategy;
  if (byStrategy.hero_rb?.length) assert(byStrategy.hero_rb.every(draft => draft.picks[0].pos === 'RB'), '35% Hero RB examples begin with a running back');
  if (byStrategy.robust_rb?.length) assert(byStrategy.robust_rb.every(draft => draft.picks.slice(0, 3).filter(pick => pick.pos === 'RB').length >= 2), '35% Robust RB examples take two backs in the first three rounds');
  if (byStrategy.wr_avalanche?.length) assert(byStrategy.wr_avalanche.every(draft => draft.picks.slice(0, 4).filter(pick => pick.pos === 'WR').length >= 2), '35% WR avalanche examples take at least two receivers in the first four rounds');
  if (byStrategy.elite_te?.length) assert(byStrategy.elite_te.every(draft => draft.picks.find(pick => pick.pos === 'TE')?.round <= 6), '35% Elite TE examples secure tight end by Round 6');
  if (byStrategy.elite_qb?.length) assert(byStrategy.elite_qb.every(draft => draft.picks.find(pick => pick.pos === 'QB')?.round <= 6), '35% Elite QB examples secure quarterback by Round 6');
  if (byStrategy.late_qb?.length) assert(byStrategy.late_qb.every(draft => draft.picks.find(pick => pick.pos === 'QB')?.round >= 8), '35% Late QB examples wait until Round 8 or later');

  await page.locator('[data-app-tab="simulations"]').click();
  await page.waitForSelector('.simulation-draft-card');
  assert(await page.locator('.simulation-threshold').count() === expectedThresholds.length, 'UI renders five minimum-availability thresholds');
  assert(await page.locator('[data-availability-threshold="35"]').getAttribute('aria-pressed') === 'true', '35% floor is selected by default');
  assert((await page.locator('#simulation-threshold-summary').innerText()).includes('at or above 35%'), 'summary explains the active 35% floor');
  assert(await page.locator('.simulation-draft-card').count() === defaultBucket.overall.length, 'default UI renders the 35% overall list');
  const defaultIds = await page.locator('.simulation-draft-card').evaluateAll(cards => cards.map(card => card.dataset.simulationDraft));
  assert(defaultIds.every(id => defaultBucket.overall.some(draft => draft.id === id)), 'default cards all come from the 35% bucket');

  await page.locator('[data-availability-threshold="20"]').click();
  await page.waitForFunction(() => document.querySelector('[data-availability-threshold="20"]')?.getAttribute('aria-pressed') === 'true');
  const twentyIds = payload.thresholds['20'].overall.map(draft => draft.id);
  await page.waitForFunction(expectedIds => {
    const actualIds = [...document.querySelectorAll('.simulation-draft-card')].map(card => card.dataset.simulationDraft);
    return actualIds.length === expectedIds.length && actualIds.every(id => expectedIds.includes(id));
  }, twentyIds, { timeout: 5000 });
  assert((await page.locator('[data-simulation-filter="overall"]').innerText()).includes('20%+'), 'overall filter label updates to the 20% floor');

  await page.locator('[data-availability-threshold="50"]').click();
  await page.waitForFunction(() => document.querySelector('[data-availability-threshold="50"]')?.getAttribute('aria-pressed') === 'true');
  const fiftyCount = payload.thresholds['50'].overall.length;
  if (fiftyCount) {
    assert(await page.locator('.simulation-draft-card').count() === fiftyCount, '50% floor renders its stricter ranked drafts');
    const lowestValues = await page.locator('.simulation-score-grid span:nth-child(4) b').allInnerTexts();
    assert(lowestValues.every(value => Number(value.replace('%', '')) >= 50), 'every visible 50% card reports a lowest skill-pick chance of at least 50%');
  } else {
    assert(await page.locator('.simulation-empty').count() === 1, '50% floor clearly explains when no stored drafts qualify');
  }

  await page.locator('[data-availability-threshold="35"]').click();
  const heroList = payload.thresholds['35'].byStrategy.hero_rb || [];
  await page.locator('[data-simulation-filter="hero_rb"]').click();
  await page.waitForFunction(expectedIds => {
    const actualIds = [...document.querySelectorAll('.simulation-draft-card')].map(card => card.dataset.simulationDraft);
    return actualIds.length === expectedIds.length && actualIds.every(id => expectedIds.includes(id));
  }, heroList.map(draft => draft.id), { timeout: 5000 });
  assert(await page.locator('[data-simulation-filter="hero_rb"]').getAttribute('aria-pressed') === 'true', 'strategy filter works inside the selected availability floor');

  await page.locator('[data-simulation-filter="ceiling"]').click();
  assert(await page.locator('.simulation-threshold:disabled').count() === expectedThresholds.length, 'availability-floor controls are disabled for isolated ceiling outcomes');
  assert((await page.locator('#simulation-threshold-summary').innerText()).includes('paused'), 'ceiling view explains that the threshold is paused');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, 'simulation threshold UI has no horizontal overflow on a 390px phone', `overflow=${overflow}`);

  await page.locator('[data-app-tab="live"]').click();
  assert(await page.locator('[data-app-panel="live"]').isVisible(), 'tab control returns to the live draft assistant');
  assert(await page.locator('[data-player-name="Chase Brown"]').count() >= 1, 'live pick-9 board still surfaces Chase Brown');
  assert(errors.length === 0, 'threshold filtering produces no browser or console errors', errors.join(' | '));

  console.log(JSON.stringify({ passed: true, totalChecks: checks.length, checks }, null, 2));
  await context.close();
} finally {
  await browser.close();
}
