import vm from 'node:vm';

const SITE_URL = 'https://nikhilanand1998.github.io/espn-live-scores/';
const FFC_URL = 'https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?position=all&teams=14&year=2026';
const PROJ_URL = 'https://raw.githubusercontent.com/dachhack/stathead/production/public/data/redraft-projections.json';
const PICKS = [9,20,37,48,65,76,93,104,121,132,149,160,177,188,205,216];
const SIMULATIONS = Number(process.env.SIMULATIONS || 5000);
const SEED = Number(process.env.SEED || 20260904);

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
function normal() {
  let u = 0, v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\b(defense|dst|d\/st)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function key(name, pos) { return `${normalize(name)}|${pos === 'DST' ? 'DEF' : pos}`; }
async function getText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 DraftAudit/1.0', accept: '*/*' } });
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  return response.text();
}
async function getJson(url) { return JSON.parse(await getText(url)); }

const [ffcPayload, projectionPayload, appDataText] = await Promise.all([
  getJson(FFC_URL),
  getJson(PROJ_URL),
  getText(`${SITE_URL}data.js?audit=${Date.now()}`)
]);

const ffcRows = Array.isArray(ffcPayload) ? ffcPayload : (ffcPayload.players || ffcPayload.data || []);
if (!ffcRows.length) throw new Error('FFC exact-format ADP returned no players');
const market = ffcRows.map((p, id) => ({
  id,
  name: p.name,
  pos: p.position === 'DST' ? 'DEF' : p.position,
  adp: Number(p.adp),
  sd: Math.max(1.5, Number(p.stdev || p.stddev || 8)),
  high: Number.isFinite(Number(p.high)) ? Number(p.high) : Number(p.adp) - 3 * Number(p.stdev || 8),
  low: Number.isFinite(Number(p.low)) ? Number(p.low) : Number(p.adp) + 3 * Number(p.stdev || 8),
  team: p.team || '',
  bye: p.bye || null,
  source: 'market'
})).filter(p => p.name && Number.isFinite(p.adp));
const marketByKey = new Map(market.map(p => [key(p.name, p.pos), p]));

const projectionRows = projectionPayload.players || [];
const projectionByKey = new Map(projectionRows.map(p => [key(p.name, p.position), p]));
const knownByPos = { QB: [], RB: [], WR: [], TE: [] };
for (const p of market) {
  const projection = projectionByKey.get(key(p.name, p.pos));
  if (projection && knownByPos[p.pos]) {
    const halfPprPpg = Number(projection.ppg) - 0.5 * Number(projection.recPG || 0);
    knownByPos[p.pos].push({ adp: p.adp, points: halfPprPpg * 17, ppg: halfPprPpg, exact: true });
  }
}
for (const values of Object.values(knownByPos)) values.sort((a,b) => a.adp - b.adp);
function estimateProjection(p) {
  const exact = projectionByKey.get(key(p.name, p.pos));
  if (exact) {
    const ppg = Number(exact.ppg) - 0.5 * Number(exact.recPG || 0);
    return { ppg, points: ppg * 17, exact: true };
  }
  const values = knownByPos[p.pos] || [];
  if (!values.length) return { ppg: 0, points: 0, exact: false };
  let before = values[0], after = values.at(-1);
  for (const v of values) {
    if (v.adp <= p.adp) before = v;
    if (v.adp >= p.adp) { after = v; break; }
  }
  const span = Math.max(1, after.adp - before.adp);
  const weight = clamp((p.adp - before.adp) / span, 0, 1);
  const points = before.points + (after.points - before.points) * weight;
  return { points, ppg: points / 17, exact: false };
}
for (const p of market) Object.assign(p, estimateProjection(p));

const replacementRank = { QB: 14, RB: 35, WR: 42, TE: 14 };
const replacement = {};
for (const pos of Object.keys(replacementRank)) {
  const sorted = market.filter(p => p.pos === pos).sort((a,b) => b.points - a.points);
  replacement[pos] = sorted[Math.min(replacementRank[pos] - 1, sorted.length - 1)]?.points || 0;
}
for (const p of market) p.vor = replacement[p.pos] == null ? 0 : p.points - replacement[p.pos];

const dataMatch = appDataText.match(/const\s+raw\s*=\s*`([\s\S]*?)`\s*;/);
if (!dataMatch) throw new Error('Could not parse deployed app data.js');
const appPlayers = dataMatch[1].split(';').map((entry, id) => {
  const [name, pos, adp] = entry.split('|');
  const marketPlayer = marketByKey.get(key(name, pos));
  return { id, name, pos, adp: Number(adp), market: marketPlayer || null };
}).filter(p => p.name && Number.isFinite(p.adp));

function rosterCounts(roster) {
  const c = { QB:0, RB:0, WR:0, TE:0, DEF:0, K:0 };
  for (const p of roster) if (c[p.pos] != null) c[p.pos]++;
  return c;
}
function appNeed(p, r, c) {
  let s = 0;
  if (c.QB && p.pos === 'QB') s -= 50;
  if (c.TE && p.pos === 'TE') s -= 24;
  if (r === 1) s += p.pos === 'RB' ? 13 : p.pos === 'WR' ? 11 : -60;
  else if (r === 2) s += c.RB ? (p.pos === 'RB' ? 17 : p.pos === 'WR' ? 14 : -35) : (p.pos === 'RB' ? 28 : -12);
  else if (r <= 4) {
    if (c.RB < 2 && p.pos === 'RB') s += 23;
    if (c.WR < 2 && p.pos === 'WR') s += 23;
    if (['QB','TE'].includes(p.pos)) s -= 14;
  } else if (r <= 6) {
    if (c.RB < 2 && p.pos === 'RB') s += 21;
    if (c.WR < 3 && p.pos === 'WR') s += 16;
    if (c.QB < 1 && p.pos === 'QB') s += r === 6 ? 17 : 4;
    if (c.TE < 1 && p.pos === 'TE') s += 10;
  } else if (r <= 8) {
    if (c.QB < 1 && p.pos === 'QB') s += 38;
    if (c.TE < 1 && p.pos === 'TE') s += 18;
    if (['RB','WR'].includes(p.pos)) s += 8;
  } else if (r <= 10) {
    if (c.TE < 1 && p.pos === 'TE') s += 40;
    if (c.QB < 1 && p.pos === 'QB') s += 25;
    if (['RB','WR'].includes(p.pos)) s += 10;
  } else if (r < 15) s += ['RB','WR'].includes(p.pos) ? 25 : -45;
  else s += r === 15 ? (p.pos === 'DEF' ? 110 : -110) : (p.pos === 'K' ? 110 : -110);
  return s;
}
function appChoose(availableKeys, roster, r) {
  const pick = PICKS[r-1], c = rosterCounts(roster);
  const candidates = appPlayers.filter(p => {
    if (!p.market || !availableKeys.has(key(p.market.name, p.market.pos))) return false;
    if (r === 15) return p.pos === 'DEF';
    if (r === 16) return p.pos === 'K';
    if (['DEF','K'].includes(p.pos)) return false;
    return r === 1 ? p.adp < 30 : p.adp >= pick - 23 && p.adp <= pick + 54;
  });
  candidates.sort((a,b) => {
    const score = p => 48 - Math.abs(p.adp-pick)*0.55 + Math.max(-14,Math.min(24,(pick-p.adp)*1.25)) + appNeed(p,r,c);
    return score(b)-score(a) || a.adp-b.adp;
  });
  return candidates[0]?.market || null;
}

function probabilityGoneBeforeNext(p, currentPick, nextPick) {
  if (!nextPick) return 1;
  const zNow = (currentPick - p.adp) / p.sd;
  const zNext = (nextPick - p.adp) / p.sd;
  const cdf = z => 0.5 * (1 + erf(z / Math.SQRT2));
  const now = cdf(zNow), next = cdf(zNext);
  return clamp((next - now) / Math.max(0.001, 1 - now), 0, 1);
}
function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;
  const t=1/(1+p*x); const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}
function independentScore(p, roster, r) {
  const c = rosterCounts(roster), pick = PICKS[r-1], nextPick = PICKS[r] || 240;
  if (r === 15) return p.pos === 'DEF' ? 1000 - p.adp : -1000;
  if (r === 16) return p.pos === 'K' ? 1000 - p.adp : -1000;
  if (['DEF','K'].includes(p.pos)) return -1000;
  if (c.QB >= 1 && p.pos === 'QB' && r < 13) return -500;
  if (c.TE >= 1 && p.pos === 'TE' && r < 13) return -300;
  let s = p.vor + Math.max(-9, Math.min(9, (pick - p.adp) * 0.22));
  s += probabilityGoneBeforeNext(p,pick,nextPick) * Math.max(0,p.vor) * 0.12;
  if (r <= 4) {
    if (c.RB < 2 && p.pos === 'RB') s += 15;
    if (c.WR < 2 && p.pos === 'WR') s += 12;
    if (['QB','TE'].includes(p.pos)) s -= 15;
  }
  if (r >= 4 && c.RB < 2 && p.pos === 'RB') s += 20 + (r-4)*4;
  if (r >= 4 && c.WR < 2 && p.pos === 'WR') s += 18 + (r-4)*4;
  if (r >= 5 && c.WR < 3 && p.pos === 'WR') s += 7;
  if (r >= 6 && c.QB < 1 && p.pos === 'QB') s += 10 + (r-6)*8;
  if (r >= 7 && c.TE < 1 && p.pos === 'TE') s += 7 + (r-7)*7;
  if (r >= 11 && ['RB','WR'].includes(p.pos)) s += Math.max(0,p.vor)*0.18 + (p.adp > 120 ? 3 : 0);
  return s;
}
function projectionChoose(available, roster, r) {
  return available.slice().sort((a,b) => independentScore(b,roster,r)-independentScore(a,roster,r) || a.adp-b.adp)[0] || null;
}
function marketChoose(available, roster, r) {
  const c = rosterCounts(roster);
  const legal = available.filter(p => {
    if (r === 15) return p.pos === 'DEF';
    if (r === 16) return p.pos === 'K';
    if (['DEF','K'].includes(p.pos)) return false;
    if (c.QB >= 1 && p.pos === 'QB' && r < 13) return false;
    if (c.TE >= 1 && p.pos === 'TE' && r < 13) return false;
    return true;
  });
  return legal.sort((a,b)=>a.adp-b.adp)[0] || null;
}

function sampledBoard() {
  return market.map(p => ({
    p,
    slot: clamp(p.adp + normal()*p.sd, Math.max(1,p.high), Math.max(p.high,p.low)) + rng()*0.001
  })).sort((a,b)=>a.slot-b.slot);
}
function optimalLineupScore(roster) {
  const skill = roster.filter(p => ['QB','RB','WR','TE'].includes(p.pos));
  const take = (pos,n) => skill.filter(p=>p.pos===pos).sort((a,b)=>b.points-a.points).slice(0,n);
  const q=take('QB',1), rb=take('RB',2), wr=take('WR',2), te=take('TE',1);
  const used = new Set([...q,...rb,...wr,...te].map(p=>key(p.name,p.pos)));
  const flex = skill.filter(p=>['RB','WR','TE'].includes(p.pos)&&!used.has(key(p.name,p.pos))).sort((a,b)=>b.points-a.points).slice(0,1);
  const starters=[...q,...rb,...wr,...te,...flex];
  const starterPoints=starters.reduce((s,p)=>s+p.points,0);
  const bench=skill.filter(p=>!used.has(key(p.name,p.pos))&&!flex.includes(p));
  const benchValue=bench.reduce((s,p)=>s+Math.max(0,p.vor)*0.18,0);
  return { starterPoints, objective: starterPoints+benchValue, starters:starters.map(p=>p.name) };
}
function simulate(policy, board) {
  const available = new Map(market.map(p=>[key(p.name,p.pos),p]));
  const roster=[]; let boardIndex=0; const picksMade=[]; const regrets=[]; const independentRanks=[];
  for(let overall=1;overall<=224;overall++) {
    const ourRound=PICKS.indexOf(overall)+1;
    if(ourRound) {
      const avail=[...available.values()];
      const independent=avail.slice().sort((a,b)=>independentScore(b,roster,ourRound)-independentScore(a,roster,ourRound)||a.adp-b.adp);
      let chosen=policy==='app'?appChoose(new Set(available.keys()),roster,ourRound):policy==='projection'?projectionChoose(avail,roster,ourRound):marketChoose(avail,roster,ourRound);
      if(!chosen) chosen=marketChoose(avail,roster,ourRound);
      const selectedKey=key(chosen.name,chosen.pos);
      const rank=Math.max(1,independent.findIndex(p=>key(p.name,p.pos)===selectedKey)+1);
      independentRanks.push(rank);
      regrets.push((independent[0]?independentScore(independent[0],roster,ourRound):0)-independentScore(chosen,roster,ourRound));
      roster.push(chosen); picksMade.push({round:ourRound,overall,name:chosen.name,pos:chosen.pos,adp:chosen.adp,independentRank:rank});
      available.delete(selectedKey);
    } else {
      while(boardIndex<board.length&&!available.has(key(board[boardIndex].p.name,board[boardIndex].p.pos))) boardIndex++;
      if(boardIndex<board.length) {
        const picked=board[boardIndex++].p;
        available.delete(key(picked.name,picked.pos));
      }
    }
  }
  const c=rosterCounts(roster), score=optimalLineupScore(roster);
  const complete=c.QB>=1&&c.RB>=2&&c.WR>=2&&c.TE>=1&&c.DEF>=1&&c.K>=1;
  const reaches=picksMade.filter(x=>x.overall < x.adp - (marketByKey.get(key(x.name,x.pos))?.sd||8)).length;
  return {roster,picks:picksMade,counts:c,complete,reaches,score,regrets,independentRanks};
}

const policies=['app','projection','market'];
const aggregate=Object.fromEntries(policies.map(p=>[p,{n:0,complete:0,objective:0,starter:0,reaches:0,regret:0,top1:0,top3:0,top5:0,rounds:Array.from({length:16},()=>({n:0,regret:0,rank:0,top3:0})),first:new Map(),examples:[]} ]));
for(let sim=0;sim<SIMULATIONS;sim++) {
  const board=sampledBoard();
  for(const policy of policies) {
    const result=simulate(policy,board);
    const a=aggregate[policy]; a.n++; a.complete+=result.complete?1:0; a.objective+=result.score.objective; a.starter+=result.score.starterPoints; a.reaches+=result.reaches;
    const meanRegret=result.regrets.reduce((s,x)=>s+x,0)/result.regrets.length; a.regret+=meanRegret;
    for(let i=0;i<result.independentRanks.length;i++) {
      const rank=result.independentRanks[i], rr=a.rounds[i]; rr.n++; rr.rank+=rank; rr.regret+=result.regrets[i]; if(rank<=3)rr.top3++;
      if(rank===1)a.top1++; if(rank<=3)a.top3++; if(rank<=5)a.top5++;
    }
    const first=result.picks[0]?.name||'Unknown'; const f=a.first.get(first)||{n:0,objective:0,starter:0}; f.n++;f.objective+=result.score.objective;f.starter+=result.score.starterPoints;a.first.set(first,f);
    if(a.examples.length<5&&sim%Math.max(1,Math.floor(SIMULATIONS/5))===0)a.examples.push(result.picks.map(x=>`${x.round}:${x.name} (${x.pos})`).join(' | '));
  }
}

const currentTop100=market.filter(p=>p.adp<=100).sort((a,b)=>a.adp-b.adp);
const appMarketKeys=new Set(appPlayers.filter(p=>p.market).map(p=>key(p.market.name,p.market.pos)));
const missingTop100=currentTop100.filter(p=>!appMarketKeys.has(key(p.name,p.pos))).map(p=>({name:p.name,pos:p.pos,adp:p.adp,points:+p.points.toFixed(1),vor:+p.vor.toFixed(1)}));
const staleAppAdp=appPlayers.filter(p=>p.market&&Math.abs(p.adp-p.market.adp)>=7).map(p=>({name:p.name,appAdp:p.adp,currentAdp:p.market.adp,diff:+(p.adp-p.market.adp).toFixed(1)})).sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff));
const exactProjectionRate=market.filter(p=>['QB','RB','WR','TE'].includes(p.pos)&&p.exact).length/market.filter(p=>['QB','RB','WR','TE'].includes(p.pos)).length;

function summarize(a) {
  const totalPicks=a.n*16;
  return {
    simulations:a.n,
    completePct:+(100*a.complete/a.n).toFixed(1),
    avgStarterPoints:+(a.starter/a.n).toFixed(1),
    avgObjective:+(a.objective/a.n).toFixed(1),
    avgReaches:+(a.reaches/a.n).toFixed(2),
    avgIndependentRegret:+(a.regret/a.n).toFixed(2),
    top1Pct:+(100*a.top1/totalPicks).toFixed(1),
    top3Pct:+(100*a.top3/totalPicks).toFixed(1),
    top5Pct:+(100*a.top5/totalPicks).toFixed(1),
    byRound:a.rounds.map((r,i)=>({round:i+1,avgIndependentRank:+(r.rank/r.n).toFixed(2),top3Pct:+(100*r.top3/r.n).toFixed(1),avgRegret:+(r.regret/r.n).toFixed(2)})),
    firstRound:[...a.first.entries()].map(([name,v])=>({name,n:v.n,pct:+(100*v.n/a.n).toFixed(1),avgObjective:+(v.objective/v.n).toFixed(1),avgStarter:+(v.starter/v.n).toFixed(1)})).sort((x,y)=>y.n-x.n).slice(0,12),
    examples:a.examples
  };
}
const report={
  generatedAt:new Date().toISOString(),seed:SEED,simulations:SIMULATIONS,
  sources:{market:FFC_URL,projections:PROJ_URL,app:`${SITE_URL}data.js`},
  dataQuality:{marketPlayers:market.length,appPlayers:appPlayers.length,appMatchedToMarket:appPlayers.filter(p=>p.market).length,exactProjectionPct:+(100*exactProjectionRate).toFixed(1),missingTop100Count:missingTop100.length,missingTop100,staleAppAdpCount:staleAppAdp.length,staleAppAdp:staleAppAdp.slice(0,40)},
  replacement:Object.fromEntries(Object.entries(replacement).map(([k,v])=>[k,+v.toFixed(1)])),
  results:Object.fromEntries(policies.map(p=>[p,summarize(aggregate[p])]))
};
console.log('AUDIT_REPORT_START');
console.log(JSON.stringify(report,null,2));
console.log('AUDIT_REPORT_END');
