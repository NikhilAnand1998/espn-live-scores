import { chromium } from 'playwright';

const SITE = 'https://nikhilanand1998.github.io/espn-live-scores/';
const pass = [];
const check = (ok, label) => {
  if (!ok) throw new Error(`FAILED: ${label}`);
  pass.push(label);
  console.log(`PASS: ${label}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fresh(page) {
  let last;
  for (let attempt = 1; attempt <= 36; attempt++) {
    try {
      const res = await page.goto(`${SITE}?v2e2e=${Date.now()}`, {waitUntil:'networkidle', timeout:45000});
      await page.evaluate(() => localStorage.clear());
      await page.reload({waitUntil:'networkidle', timeout:45000});
      const status = await page.locator('#status').innerText({timeout:10000});
      const source = await page.locator('body').evaluate(() => [...document.scripts].map(s=>s.src).join(' '));
      if (res?.ok() && status.includes('Round 1') && status.includes('1.09') && source.includes('app.js')) return;
      last = new Error(`Site not at expected version: ${status}`);
    } catch (e) { last = e; }
    console.log(`Waiting for GitHub Pages deployment ${attempt}/36`);
    await sleep(5000);
  }
  throw last;
}

async function pick(page, name) {
  const target = page.locator('[data-pick]').filter({hasText:name});
  check(await target.count() === 1, `${name} is offered`);
  await target.click();
}

const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
const errors=[];
try {
  const desktop = await browser.newContext({viewport:{width:1440,height:900}});
  const page = await desktop.newPage();
  page.on('pageerror', e=>errors.push(`pageerror ${e.message}`));
  page.on('console', m=>{if(m.type()==='error')errors.push(`console ${m.text()}`)});
  await fresh(page);
  check((await page.title()).includes('Pick 9 Draft Tree'),'hosted draft tree loads');
  check((await page.locator('#status').innerText()).includes('1.09 / #9'),'Round 1 pick is 1.09 / #9');
  check(await page.locator('[data-pick]').count() >= 10,'Round 1 has multiple leaf options');
  check(await page.locator('a[href="validation.html"]').count()===1,'validation report is linked');

  await pick(page,'James Cook');
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Round 2'));
  check((await page.locator('#status').innerText()).includes('2.06 / #20'),'RB-first path advances to 2.06 / #20');
  check((await page.locator('#team').innerText()).includes('James Cook'),'team updates after selection');
  check((await page.locator('.branch-title h2').innerText()).includes('Premium RB2 or elite WR value'),'RB-first branch remains flexible rather than forcing RB');

  await page.locator('#undo').click();
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Round 1'));
  await pick(page,'CeeDee Lamb');
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Round 2'));
  check((await page.locator('.branch-title h2').innerText()).includes('Prioritize RB unless an elite WR falls'),'WR-first branch prioritizes RB without ignoring elite value');

  page.once('dialog',d=>d.accept());
  await page.locator('#reset').click();
  await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Round 1'));
  const drafted=[];
  for(let r=1;r<=16;r++){
    const cards=page.locator('[data-pick]');
    check(await cards.count()>0,`Round ${r} has a selectable recommendation`);
    const card=cards.first();
    const name=(await card.locator('.card-name b').innerText()).trim();
    check(!drafted.includes(name),`Round ${r} does not repeat a player`);
    drafted.push(name);
    await card.click();
    if(r<16) await page.waitForFunction(n=>document.querySelector('#status')?.textContent.includes(`Round ${n}`),r+1);
    else await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Complete'));
  }
  check(new Set(drafted).size===16,'full path drafts 16 unique players');
  check(await page.locator('[data-edit]').count()===16,'all 16 picks render as tree nodes');
  check((await page.locator('.done').innerText()).includes('Draft complete'),'full path reaches completion');
  const countText=await page.locator('.counts').innerText();
  check(/1\s+QB/.test(countText),'completed roster includes QB');
  check(/[2-9]\s+RB/.test(countText),'completed roster includes at least 2 RB');
  check(/[2-9]\s+WR/.test(countText),'completed roster includes at least 2 WR');
  check(/1\s+TE/.test(countText),'completed roster includes TE');
  check(/1\s+DEF/.test(countText),'completed roster includes defense');
  check(/1\s+K/.test(countText),'completed roster includes kicker');

  await page.goto(`${SITE}validation.html?e2e=${Date.now()}`,{waitUntil:'networkidle',timeout:45000});
  await page.waitForFunction(()=>document.querySelector('#app')?.textContent.includes('Mock-draft recommendation audit'),null,{timeout:30000});
  check((await page.locator('#app').innerText()).includes('PASS'),'published mock-draft validation report says PASS');
  check((await page.locator('#app').innerText()).includes('3,000'),'validation report shows 3,000 tree mocks');
  await desktop.close();

  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
  const phone=await mobile.newPage();
  phone.on('pageerror',e=>errors.push(`mobile pageerror ${e.message}`));
  phone.on('console',m=>{if(m.type()==='error')errors.push(`mobile console ${m.text()}`)});
  await fresh(phone);
  const overflow=await phone.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
  check(overflow<=1,'mobile has no viewport horizontal overflow');
  check(await phone.locator('[data-pick]').count()>=10,'mobile renders Round 1 leaves');
  await phone.locator('[data-pick]').first().tap();
  await phone.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('Round 2'));
  check((await phone.locator('#status').innerText()).includes('2.06 / #20'),'mobile selection advances correctly');
  await mobile.close();

  check(errors.length===0,`no browser JavaScript or console errors: ${errors.join('; ')}`);
  console.log(JSON.stringify({passed:pass.length,checks:pass},null,2));
} finally {
  await browser.close();
}
