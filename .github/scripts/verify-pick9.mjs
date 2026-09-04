import { chromium } from 'playwright';

const siteUrl = process.env.SITE_URL;
const passed = [];
const assert = (value, label) => {
  if (!value) throw new Error(`FAILED: ${label}`);
  passed.push(label);
  console.log(`PASS: ${label}`);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function openFresh(page) {
  let lastError;
  for (let attempt = 1; attempt <= 36; attempt++) {
    try {
      const response = await page.goto(`${siteUrl}?e2e=${Date.now()}`, {
        waitUntil: 'networkidle',
        timeout: 45000
      });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: 'networkidle', timeout: 45000 });
      const ready = await page.evaluate(() => ({
        status: document.querySelector('#status')?.textContent || '',
        players: window.players?.length || 0,
        engine: Boolean(window.DraftEngine),
        badge: document.querySelector('.audit-badge')?.textContent || ''
      }));
      if (response?.ok() && ready.status.includes('Round 1') && ready.status.includes('1.09') && ready.players >= 220 && ready.engine && ready.badge.includes('AUDITED')) return;
      lastError = new Error(`Attempt ${attempt}: deployed site not ready ${JSON.stringify(ready)}`);
    } catch (error) {
      lastError = error;
    }
    console.log(`Waiting for latest Pages deployment, attempt ${attempt}/36...`);
    await wait(5000);
  }
  throw lastError || new Error('Hosted site never became ready');
}

async function clickPlayer(page, name) {
  const card = page.locator('[data-pick]').filter({ hasText: name });
  assert(await card.count() === 1, `${name} is offered as a leaf`);
  await card.click();
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const runtimeErrors = [];
const failedAssets = [];

try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await desktop.newPage();
  page.on('pageerror', error => runtimeErrors.push(`desktop pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') runtimeErrors.push(`desktop console: ${message.text()}`);
  });
  page.on('response', response => {
    if (response.url().startsWith(siteUrl) && response.status() >= 400) failedAssets.push(`${response.status()} ${response.url()}`);
  });

  await openFresh(page);
  assert((await page.title()).includes('Pick 9 Draft Tree'), 'hosted page title loads');
  assert((await page.locator('#status').innerText()).includes('1.09 / #9'), 'Round 1 snake notation is 1.09 / #9');
  assert((await page.locator('.audit-badge').innerText()).includes('MOCK-DRAFT AUDITED'), 'audited recommendation build is deployed');
  assert((await page.locator('#source-note').innerText()).includes('exact-format'), 'exact-format data source note is visible');

  const dataAudit = await page.evaluate(() => ({
    total: window.players.length,
    estimated: window.players.filter(player => player.estimated).length,
    exact: window.players.filter(player => !player.estimated).length,
    names: window.players.map(player => player.name),
    jacobs: window.players.find(player => player.name === 'Josh Jacobs')
  }));
  assert(dataAudit.total >= 220, `complete current player pool is loaded (${dataAudit.total})`);
  assert(dataAudit.exact >= 165, `at least 165 players have exact 14-team value matches (${dataAudit.exact})`);
  assert(dataAudit.estimated >= 30, `unmatched players are estimated rather than falsely cross-matched (${dataAudit.estimated})`);
  for (const name of ['Kyren Williams','Zay Flowers','Ashton Jeanty','Josh Allen','Cam Skattebo',"D'Andre Swift",'David Montgomery','Brian Thomas Jr.','Chuba Hubbard','Xavier Worthy']) {
    assert(dataAudit.names.includes(name), `${name} is included in the recommendation pool`);
  }
  assert(Boolean(dataAudit.jacobs?.excluded), 'Josh Jacobs is present for identification but excluded from recommendations');
  assert(await page.locator('[data-pick]').filter({ hasText: 'Josh Jacobs' }).count() === 0, 'Josh Jacobs is not recommended while unavailable');

  assert(await page.locator('[data-pick]').count() >= 10, 'Round 1 displays multiple clickable leaves');
  assert(await page.locator('[data-pick]').filter({ hasText: 'James Cook' }).count() === 1, 'James Cook Round 1 branch is present');
  assert(await page.locator('[data-pick]').filter({ hasText: 'CeeDee Lamb' }).count() === 1, 'CeeDee Lamb Round 1 branch is present');

  const initialOptions = await page.locator('.card-name b').allInnerTexts();
  console.log(`ROUND 1 OPTIONS: ${initialOptions.join(' | ')}`);

  await clickPlayer(page, 'James Cook');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Round 2'));
  const round2Status = await page.locator('#status').innerText();
  assert(round2Status.includes('2.06 / #20'), 'James Cook advances to correct Round 2 pick 2.06 / #20');
  assert((await page.locator('#team').innerText()).includes('James Cook'), 'current team updates after selection');
  assert(await page.locator('[data-edit]').count() === 1, 'selected player becomes the tree trunk');
  assert(await page.locator('[data-pick]').filter({ hasText: 'James Cook' }).count() === 0, 'selected player cannot be recommended again');
  const round2Options = await page.locator('.card-name b').allInnerTexts();
  console.log(`ROUND 2 AFTER JAMES COOK: ${round2Options.join(' | ')}`);
  assert(round2Options.some(name => ['Kenneth Walker','Kyren Williams','Omarion Hampton','Saquon Barkley','Chase Brown'].some(target => name.includes(target))), 'RB-first Round 2 board contains a premium RB option');

  await page.locator('#undo').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Round 1'));
  assert(!(await page.locator('#team').innerText()).includes('James Cook'), 'Undo removes the previous selection');

  await clickPlayer(page, 'James Cook');
  await page.reload({ waitUntil: 'networkidle' });
  assert((await page.locator('#team').innerText()).includes('James Cook'), 'selected team persists after reload');
  assert((await page.locator('#status').innerText()).includes('Round 2'), 'current round persists after reload');

  const firstRound2Card = page.locator('article.card').first();
  const goneName = await firstRound2Card.locator('.card-name b').innerText();
  await firstRound2Card.locator('[data-gone]').click();
  assert(await page.locator('[data-pick]').filter({ hasText: goneName }).count() === 0, 'Gone removes an opponent-drafted leaf');
  await page.locator('#restore').click();
  assert(await page.locator('[data-pick]').filter({ hasText: goneName }).count() === 1, 'Restore Gone brings the leaf back');

  await page.locator('[data-edit="0"]').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Round 1'));
  await clickPlayer(page, 'CeeDee Lamb');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Round 2'));
  assert((await page.locator('.branch-title h2').innerText()).includes('Prioritize your first premium RB'), 'WR-first branch changes Round 2 strategy to RB priority');
  const wrFirstOptions = await page.locator('.card-name b').allInnerTexts();
  console.log(`ROUND 2 AFTER CEEDEE: ${wrFirstOptions.join(' | ')}`);
  assert(wrFirstOptions.slice(0, 4).some(name => ['Kenneth Walker','Kyren Williams','Omarion Hampton','Chase Brown','Saquon Barkley'].some(target => name.includes(target))), 'WR-first branch places a premium RB near the top');

  page.once('dialog', dialog => dialog.accept());
  await page.locator('#reset').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Round 1'));
  assert((await page.locator('#team').innerText()).includes('No picks yet'), 'Reset clears the full draft');

  const drafted = [];
  for (let r = 1; r <= 16; r++) {
    const options = page.locator('[data-pick]');
    assert(await options.count() > 0, `Round ${r} has at least one selectable leaf`);
    const first = options.first();
    const name = (await first.locator('.card-name b').innerText()).trim();
    assert(!drafted.includes(name), `Round ${r} recommendation is not a duplicate`);
    drafted.push(name);
    await first.click();
    if (r < 16) await page.waitForFunction(next => document.querySelector('#status')?.textContent.includes(`Round ${next}`), r + 1);
    else await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Complete'));
  }
  console.log(`FULL AUTO PATH: ${drafted.join(' > ')}`);
  assert(new Set(drafted).size === 16, 'full 16-round path contains 16 unique players');
  assert(await page.locator('[data-edit]').count() === 16, 'full draft renders all 16 selected tree nodes');
  assert((await page.locator('.done').innerText()).includes('Draft complete'), 'full draft reaches completion state');
  assert((await page.locator('.node').last().locator('.effect').innerText()).includes('Draft complete'), 'Round 16 node correctly says Draft complete');
  const countText = await page.locator('.counts').innerText();
  assert(/1\s+QB/.test(countText), 'completed roster includes one starting QB');
  assert(/[2-9]\s+RB/.test(countText), 'completed roster includes at least two RBs');
  assert(/[2-9]\s+WR/.test(countText), 'completed roster includes at least two WRs');
  assert(/[1-9]\s+TE/.test(countText), 'completed roster includes a TE');
  assert(/1\s+DEF/.test(countText), 'completed roster includes one defense');
  assert(/1\s+K/.test(countText), 'completed roster includes one kicker');
  assert(!drafted.some(name => name === 'Josh Jacobs'), 'unavailable Josh Jacobs never appears in the full recommendation path');
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const phone = await mobile.newPage();
  phone.on('pageerror', error => runtimeErrors.push(`mobile pageerror: ${error.message}`));
  phone.on('console', message => {
    if (message.type() === 'error') runtimeErrors.push(`mobile console: ${message.text()}`);
  });
  await openFresh(phone);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, 'mobile page has no viewport-level horizontal overflow');
  assert(await phone.locator('[data-pick]').count() >= 10, 'mobile Round 1 leaves render');
  await phone.locator('[data-pick]').filter({ hasText: 'James Cook' }).tap();
  await phone.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Round 2'));
  assert((await phone.locator('#status').innerText()).includes('2.06 / #20'), 'mobile selection advances to correct Round 2 pick');
  assert(await phone.locator('[data-edit]').count() === 1, 'mobile selected node becomes the trunk');
  await mobile.close();

  assert(runtimeErrors.length === 0, `no browser console or JavaScript errors (${runtimeErrors.join('; ')})`);
  assert(failedAssets.length === 0, `no hosted assets return HTTP errors (${failedAssets.join('; ')})`);
  console.log(JSON.stringify({ siteUrl, passed: passed.length, checks: passed }, null, 2));
} finally {
  await browser.close();
}
