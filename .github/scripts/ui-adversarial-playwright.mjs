import fs from 'node:fs';
import { chromium } from 'playwright';

const siteUrl = process.env.SITE_URL || 'http://127.0.0.1:4173/';
const reportPath = process.env.REPORT_PATH || 'ui-adversarial-report.json';
const checks = [];
const runtimeErrors = [];
const failedAssets = [];

function assert(value, label, details = '') {
  if (!value) throw new Error(`FAILED: ${label}${details ? ` — ${details}` : ''}`);
  checks.push(label);
  console.log(`PASS: ${label}`);
}

async function openFresh(page) {
  const response = await page.goto(`${siteUrl}?ui-audit=${Date.now()}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  assert(Boolean(response?.ok()), 'site returns a successful document response');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-pick]', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#board-shell')?.getAttribute('aria-busy') === 'false', null, { timeout: 60000 });
}

async function noViewportOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  assert(dimensions.scrollWidth - dimensions.clientWidth <= 1, `${label} has no viewport-level horizontal overflow`, JSON.stringify(dimensions));
}

async function visibleTouchTargets(page, label) {
  const failures = await page.evaluate(() => {
    const selectors = [
      '#undo:not([disabled])', '#reset', '#team-toggle',
      '.draft-player', '.faller-button', '.show-more', '.path-change', '#show-full-path'
    ];
    return [...document.querySelectorAll(selectors.join(','))]
      .filter(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      })
      .map(element => {
        const rect = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label') || element.textContent.trim().replace(/\s+/g, ' '), width: rect.width, height: rect.height };
      })
      .filter(item => item.width < 44 || item.height < 44);
  });
  assert(failures.length === 0, `${label} uses at least 44px touch targets`, JSON.stringify(failures));
}

async function auditStaticUx(page, label) {
  assert((await page.title()).includes('Pick 9 Draft Tree'), `${label} has a clear product title`);
  assert((await page.locator('#round-label').innerText()).includes('Round 1'), `${label} clearly shows the current round`);
  assert((await page.locator('#pick-label').innerText()).includes('1.09') && (await page.locator('#pick-label').innerText()).includes('#9'), `${label} clearly shows the snake pick`);
  assert(await page.locator('input,textarea,[role="searchbox"]').count() === 0, `${label} requires no player search`);
  assert(await page.locator('[data-gone],button:has-text("Gone"),button:has-text("Taken")').count() === 0, `${label} requires no opponent-pick tracking`);
  assert((await page.locator('#intro').innerText()).includes('Tap only the player you draft'), `${label} states the single required action`);
  assert((await page.locator('#board-shell').innerText()).includes('Do not enter opponent picks'), `${label} repeats the no-tracking rule at the decision point`);
  assert(await page.locator('.recommendation-card').count() >= 5, `${label} shows multiple expected choices without search`);
  assert(await page.locator('.availability-badge').count() >= 5, `${label} shows expected availability on every main choice`);
  assert(await page.locator('.faller-button').count() >= 1, `${label} separately surfaces premium fallers`);
  assert(await page.locator('button button').count() === 0, `${label} contains no nested interactive controls`);
  assert(await page.locator('.draft-player').first().getAttribute('aria-label') !== '', `${label} draft action has an accessible name`);
  await noViewportOverflow(page, label);
  await visibleTouchTargets(page, label);
}

async function auditTeamDisclosure(page, label) {
  assert(await page.locator('#team-body').isHidden(), `${label} keeps detailed roster collapsed by default`);
  await page.locator('#team-toggle').click();
  assert(await page.locator('#team-body').isVisible(), `${label} expands the roster from one large control`);
  assert(await page.locator('#team-toggle').getAttribute('aria-expanded') === 'true', `${label} exposes roster disclosure state to assistive technology`);
  await page.locator('#team-toggle').click();
  assert(await page.locator('#team-body').isHidden(), `${label} collapses the roster again`);
}

async function chooseFirstExpected(page) {
  const button = page.locator('.draft-player').first();
  const name = (await button.innerText()).replace(/^Draft\s+/i, '').trim();
  const started = Date.now();
  await button.click();
  await page.waitForFunction(() => document.querySelector('#round-label')?.textContent.includes('Round 2'), null, { timeout: 60000 });
  return { name, elapsed: Date.now() - started };
}

async function auditSelectionFlow(page, label) {
  const { name, elapsed } = await chooseFirstExpected(page);
  assert(elapsed < 8000, `${label} recalculates the next branch in under eight seconds`, `${elapsed}ms`);
  const pickText = await page.locator('#pick-label').innerText();
  assert(pickText.includes('2.06') && pickText.includes('#20'), `${label} advances to the correct Round 2 snake pick`);
  assert(await page.locator('.path-node').count() === 1, `${label} turns the selected player into the visible tree trunk`);
  assert((await page.locator('#construction').innerText()).toLowerCase().includes(name.split(' ').at(-1).toLowerCase()), `${label} updates the compact current-team summary`);
  assert(await page.locator('#intro').isHidden(), `${label} removes onboarding copy after the draft starts`);
  assert(await page.locator('.recommendation-card').count() >= 5, `${label} produces a new multi-option Round 2 board`);
  assert(await page.locator('[data-gone],button:has-text("Gone"),button:has-text("Taken")').count() === 0, `${label} still requires no opponent tracking after advancing`);

  const boardTop = await page.locator('#board-shell').evaluate(element => element.getBoundingClientRect().top);
  const headerBottom = await page.locator('.app-header').evaluate(element => element.getBoundingClientRect().bottom);
  assert(boardTop >= headerBottom - 2, `${label} auto-scroll does not hide the next board behind the sticky header`, `boardTop=${boardTop}, headerBottom=${headerBottom}`);

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.path-node', { timeout: 60000 });
  assert((await page.locator('#round-label').innerText()).includes('Round 2'), `${label} persists the draft state through refresh`);
  assert((await page.locator('#construction').innerText()).toLowerCase().includes(name.split(' ').at(-1).toLowerCase()), `${label} persists the selected player through refresh`);

  await page.locator('#undo').click();
  await page.waitForFunction(() => document.querySelector('#round-label')?.textContent.includes('Round 1'), null, { timeout: 60000 });
  assert(await page.locator('.path-node').count() === 0, `${label} undo returns to a clean Round 1 tree`);
}

async function auditFallerPath(page, label) {
  const faller = page.locator('.faller-button').first();
  const name = (await faller.locator('b').innerText()).trim();
  await faller.click();
  await page.waitForFunction(() => document.querySelector('#round-label')?.textContent.includes('Round 2'), null, { timeout: 60000 });
  assert((await page.locator('.path-node').first().innerText()).includes(name), `${label} allows an unexpected premium faller to become the selected branch`);
  await page.locator('#undo').click();
  await page.waitForFunction(() => document.querySelector('#round-label')?.textContent.includes('Round 1'), null, { timeout: 60000 });
}

async function auditShowMore(page, label) {
  const before = await page.locator('.recommendation-card').count();
  const button = page.locator('#show-more');
  if (await button.count()) {
    await button.click();
    const after = await page.locator('.recommendation-card').count();
    assert(after >= before + 1, `${label} expands alternatives without introducing a search workflow`);
    await page.locator('#undo').click();
    await page.waitForTimeout(80);
  } else {
    checks.push(`${label} had no hidden alternatives to expand`);
    console.log(`PASS: ${label} had no hidden alternatives to expand`);
  }
}

async function auditKeyboard(page) {
  const button = page.locator('.draft-player').first();
  await button.focus();
  assert(await button.evaluate(element => document.activeElement === element), 'desktop keyboard can focus the primary draft action');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#round-label')?.textContent.includes('Round 2'), null, { timeout: 60000 });
  assert(true, 'desktop keyboard Enter selects a player and advances the tree');
}

async function auditFullDraft(page) {
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.draft-player', { timeout: 60000 });
  const drafted = [];
  for (let currentRound = 1; currentRound <= 16; currentRound += 1) {
    const button = page.locator('.draft-player').first();
    assert(await button.count() === 1, `full-flow Round ${currentRound} has a primary expected option`);
    const name = (await button.innerText()).replace(/^Draft\s+/i, '').trim();
    assert(!drafted.includes(name), `full-flow Round ${currentRound} never repeats a selected player`);
    drafted.push(name);
    await button.click();
    if (currentRound < 16) {
      await page.waitForFunction(nextRound => document.querySelector('#round-label')?.textContent.includes(`Round ${nextRound}`), currentRound + 1, { timeout: 60000 });
    } else {
      await page.waitForFunction(() => document.querySelector('#round-label')?.textContent.includes('complete'), null, { timeout: 60000 });
    }
  }
  assert(new Set(drafted).size === 16, 'full-flow completes with 16 unique selections');
  assert(await page.locator('.draft-complete').count() === 1, 'full-flow ends in an explicit completion state');
  assert((await page.locator('#pick-label').innerText()).includes('16 players selected'), 'full-flow header summarizes the completed roster');
}

async function auditTextScaling(page) {
  await page.evaluate(() => { document.documentElement.style.fontSize = '125%'; });
  await noViewportOverflow(page, 'mobile text-scaling state');
  const clippedButtons = await page.evaluate(() => [...document.querySelectorAll('.draft-player')]
    .filter(button => button.scrollWidth > button.clientWidth + 2)
    .map(button => button.textContent.trim()));
  assert(clippedButtons.length === 0, 'mobile draft actions remain readable at 125% text scaling', JSON.stringify(clippedButtons));
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const mobileSizes = [
    { name: '320px compact mobile', width: 320, height: 568 },
    { name: '390px iPhone mobile', width: 390, height: 844 },
    { name: '430px large mobile', width: 430, height: 932 }
  ];

  for (const size of mobileSizes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    page.on('pageerror', error => runtimeErrors.push(`${size.name}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') runtimeErrors.push(`${size.name}: ${message.text()}`); });
    page.on('response', response => { if (response.url().startsWith(siteUrl) && response.status() >= 400) failedAssets.push(`${response.status()} ${response.url()}`); });
    await openFresh(page);
    await auditStaticUx(page, size.name);
    await auditTeamDisclosure(page, size.name);
    if (size.width === 390) {
      await auditSelectionFlow(page, size.name);
      await auditFallerPath(page, size.name);
      await auditShowMore(page, size.name);
      await auditTextScaling(page);
    }
    await context.close();
  }

  const reducedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const reducedPage = await reducedContext.newPage();
  await openFresh(reducedPage);
  await chooseFirstExpected(reducedPage);
  assert((await reducedPage.locator('#round-label').innerText()).includes('Round 2'), 'reduced-motion mode remains fully functional');
  await reducedContext.close();

  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const desktop = await desktopContext.newPage();
  desktop.on('pageerror', error => runtimeErrors.push(`desktop: ${error.message}`));
  desktop.on('console', message => { if (message.type() === 'error') runtimeErrors.push(`desktop: ${message.text()}`); });
  await openFresh(desktop);
  await auditStaticUx(desktop, 'desktop');
  await auditKeyboard(desktop);
  await auditFullDraft(desktop);
  await desktopContext.close();

  assert(runtimeErrors.length === 0, 'no browser JavaScript or console errors', JSON.stringify(runtimeErrors));
  assert(failedAssets.length === 0, 'no local or hosted assets return HTTP errors', JSON.stringify(failedAssets));

  const report = {
    passed: true,
    siteUrl,
    generatedAt: new Date().toISOString(),
    totalChecks: checks.length,
    checks,
    runtimeErrors,
    failedAssets,
    adversarialRisksCovered: [
      'one-handed mobile use',
      'small viewport overflow',
      'excessive onboarding height',
      'manual opponent-entry burden',
      'accidental nested controls',
      'undersized touch targets',
      'sticky-header occlusion',
      'text scaling',
      'keyboard access',
      'state persistence',
      'undo and branch correction',
      'premium-faller selection',
      '16-round dead ends and duplicate players'
    ]
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
