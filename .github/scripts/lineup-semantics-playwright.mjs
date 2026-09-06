import { chromium } from 'playwright';

const siteUrl = process.env.SITE_URL || 'http://127.0.0.1:4173/';
const STORAGE_KEY = 'pick9-adversarial-ux-v2';
const checks = [];

function assert(value, label, details = '') {
  if (!value) throw new Error(`FAILED: ${label}${details ? ` — ${details}` : ''}`);
  checks.push(label);
  console.log(`PASS: ${label}`);
}

async function waitReady(page) {
  await page.waitForSelector('[data-pick]', { timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.DraftLineup), null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#board-shell')?.getAttribute('aria-busy') === 'false', null, { timeout: 60000 });
}

async function setRoster(page, rbCount, wrCount) {
  const selected = await page.evaluate(({ rbCount, wrCount }) => {
    const rbs = window.players.filter(player => player.pos === 'RB' && !player.excluded).slice(0, rbCount);
    const wrs = window.players.filter(player => player.pos === 'WR' && !player.excluded).slice(0, wrCount);
    return [...rbs, ...wrs].map(player => player.key);
  }, { rbCount, wrCount });
  await page.evaluate(({ key, selected }) => {
    localStorage.setItem(key, JSON.stringify({ selected, retired: [], more: 0 }));
  }, { key: STORAGE_KEY, selected });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitReady(page);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const response = await page.goto(`${siteUrl}?lineup-test=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  assert(Boolean(response?.ok()), 'lineup-semantics test site loads');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitReady(page);

  const rules = await page.evaluate(() => ({
    engine: window.DraftEngine.STARTERS,
    ui: window.DraftLineup.targets
  }));
  assert(rules.engine.RB === 2 && rules.engine.WR === 2 && rules.engine.FLEX === 1, 'recommendation engine is configured for 2 RB, 2 WR, and 1 FLEX');
  assert(rules.ui.RB === 2 && rules.ui.WR === 2 && rules.ui.FLEX === 1, 'UI lineup model matches the recommendation engine');

  await setRoster(page, 3, 3);
  const chipText = async slot => (await page.locator(`[data-slot="${slot}"]`).innerText()).replace(/\s+/g, ' ').trim();
  assert((await chipText('RB')) === '2/2 RB', 'three drafted RBs display as two RB starter slots filled');
  assert((await chipText('WR')) === '2/2 WR', 'three drafted WRs display as two WR starter slots filled');
  assert((await chipText('FLEX')) === '1/1 FLEX', 'one extra RB or WR fills the single FLEX slot');
  assert((await chipText('BN')) === '1 BN', 'the sixth RB/WR is shown as one bench player rather than another starter');
  const allChips = (await page.locator('#roster-chips').innerText()).replace(/\s+/g, ' ');
  assert(!allChips.includes('3 RB') && !allChips.includes('3 WR'), 'header no longer double-counts drafted totals as starting slots');

  const allocation = await page.evaluate(() => {
    const roster = JSON.parse(localStorage.getItem('pick9-adversarial-ux-v2')).selected
      .map(key => window.players.find(player => player.key === key));
    return window.DraftLineup.allocate(roster);
  });
  assert(allocation.filled.RB === 2 && allocation.filled.WR === 2 && allocation.filled.FLEX === 1 && allocation.bench === 1, 'lineup allocator produces 2 RB, 2 WR, 1 FLEX, and 1 bench from a 3-RB/3-WR roster');

  await page.locator('#team-toggle').click();
  const summary = (await page.locator('.lineup-format-summary').innerText()).replace(/\s+/g, ' ');
  assert(summary.includes('Starting lineup: 1 QB · 2 RB · 2 WR · 1 TE · 1 FLEX · DEF · K'), 'expanded roster states the exact starting lineup');
  assert(summary.includes('RB and WR totals are not extra starting slots'), 'expanded roster explains starter versus bench counting');

  await setRoster(page, 2, 2);
  const roles = await page.evaluate(() => {
    const roster = JSON.parse(localStorage.getItem('pick9-adversarial-ux-v2')).selected
      .map(key => window.players.find(player => player.key === key));
    const extraRb = window.players.find(player => player.pos === 'RB' && !roster.some(selected => selected.key === player.key));
    const extraWr = window.players.find(player => player.pos === 'WR' && !roster.some(selected => selected.key === player.key));
    return {
      rb: window.DraftLineup.roleFor(extraRb, roster),
      wr: window.DraftLineup.roleFor(extraWr, roster)
    };
  });
  assert(roles.rb === 'Fills FLEX starter 1/1' && roles.wr === 'Fills FLEX starter 1/1', 'a third RB or WR is classified as the FLEX starter when FLEX is open');

  await setRoster(page, 3, 3);
  const benchRole = await page.evaluate(() => {
    const roster = JSON.parse(localStorage.getItem('pick9-adversarial-ux-v2')).selected
      .map(key => window.players.find(player => player.key === key));
    const extraRb = window.players.find(player => player.pos === 'RB' && !roster.some(selected => selected.key === player.key));
    return window.DraftLineup.roleFor(extraRb, roster);
  });
  assert(benchRole === 'Bench/depth value', 'additional RB or WR recommendations are labeled as bench depth after FLEX is filled');

  const visibleRoles = await page.locator('.lineup-role').allInnerTexts();
  assert(visibleRoles.length > 0, 'recommendation cards visibly state starter, FLEX, or bench role');

  console.log(JSON.stringify({ passed: true, totalChecks: checks.length, checks }, null, 2));
  await context.close();
} finally {
  await browser.close();
}
