import * as cheerio from 'cheerio';

const SITE_URL = 'https://nikhilanand1998.github.io/espn-live-scores/';
const FFC_URL = 'https://fantasyfootballcalculator.com/api/v1/adp/half-ppr?position=all&teams=14&year=2026';
const VALUE_URL = 'https://www.rotoalpha.com/nfl/rankings/14-team-half-ppr';
const PICKS = [9,20,37,48,65,76,93,104,121,132,149,160,177,188,205,216];
const SIMULATIONS = Number(process.env.SIMULATIONS || 5000);
const SEED = Number(process.env.SEED || 20260904);

function mulberry32(seed){return function(){let t=seed+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
const rng=mulberry32(SEED);
function normal(){let u=0,v=0;while(!u)u=rng();while(!v)v=rng();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)}
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function canonicalPos(pos){const p=String(pos||'').toUpperCase().replace(/[0-9]/g,'');if(p==='PK')return'K';if(p==='DST'||p==='D/ST')return'DEF';return p}
function normalize(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/\b(defense|dst|d st)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim()}
const key=(name,pos)=>`${normalize(name)}|${canonicalPos(pos)}`;
async function getText(url){const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 DraftAudit/3.0','accept':'text/html,application/json,*/*'}});if(!r.ok)throw new Error(`${r.status} fetching ${url}`);return r.text()}
async function getJson(url){return JSON.parse(await getText(url))}

const [ffcPayload,valueHtml,appDataText]=await Promise.all([getJson(FFC_URL),getText(VALUE_URL),getText(`${SITE_URL}data.js?audit=${Date.now()}`)]);
const ffcRows=ffcPayload.players||ffcPayload.data||ffcPayload;
if(!Array.isArray(ffcRows)||!ffcRows.length)throw new Error('Current 14-team half-PPR ADP feed returned no players');

const $=cheerio.load(valueHtml);
const valueRows=[];
$('table tr').each((_,tr)=>{
  const cells=$(tr).find('td').map((__,td)=>$(td).text().replace(/\s+/g,' ').trim()).get();
  if(cells.length<6)return;
  const rank=Number(cells[0]),name=cells[1],pos=canonicalPos(cells[2]),team=cells[3],proj=Number(cells[4].replace(/[^0-9.-]/g,'')),vor=Number(cells[5].replace(/[^0-9+.-]/g,''));
  if(Number.isFinite(rank)&&name&&['QB','RB','WR','TE','DEF','K'].includes(pos)&&Number.isFinite(proj)&&Number.isFinite(vor))valueRows.push({rank,name,pos,team,proj,vor});
});
if(valueRows.length<150)throw new Error(`Only parsed ${valueRows.length} exact-format value rows from RotoAlpha`);
const valueByKey=new Map(valueRows.map(p=>[key(p.name,p.pos),p]));

const market=ffcRows.map((p,id)=>{
  const pos=canonicalPos(p.position),adp=Number(p.adp),sd=Math.max(0.7,Number(p.stdev||p.stddev||8));
  const value=valueByKey.get(key(p.name,pos));
  return{id,name:p.name,pos,team:p.team||'',bye:p.bye||null,adp,sd,high:Number.isFinite(Number(p.high))?Number(p.high):Math.max(1,adp-3*sd),low:Number.isFinite(Number(p.low))?Number(p.low):adp+3*sd,proj:value?.proj??null,vor:value?.vor??null,valueRank:value?.rank??null};
}).filter(p=>p.name&&Number.isFinite(p.adp));
const marketByKey=new Map(market.map(p=>[key(p.name,p.pos),p]));

for(const pos of ['QB','RB','WR','TE','DEF','K']){
  const known=market.filter(p=>p.pos===pos&&p.proj!=null).sort((a,b)=>a.adp-b.adp);
  for(const p of market.filter(p=>p.pos===pos&&p.proj==null)){
    if(!known.length){p.proj=0;p.vor=-50;continue}
    let before=known[0],after=known.at(-1);
    for(const v of known){if(v.adp<=p.adp)before=v;if(v.adp>=p.adp){after=v;break}}
    const w=clamp((p.adp-before.adp)/Math.max(1,after.adp-before.adp),0,1);
    p.proj=before.proj+(after.proj-before.proj)*w;p.vor=before.vor+(after.vor-before.vor)*w;
  }
}

const dataMatch=appDataText.match(/const\s+raw\s*=\s*`([\s\S]*?)`\s*;/);
if(!dataMatch)throw new Error('Could not parse deployed app player data');
const appPlayers=dataMatch[1].split(';').map((entry,id)=>{const[name,pos,adp]=entry.split('|');return{id,name,pos:canonicalPos(pos),adp:Number(adp),market:marketByKey.get(key(name,pos))||null}}).filter(p=>p.name&&Number.isFinite(p.adp));

const riskPenalty=new Map([
  [normalize('Josh Jacobs'),-1000],
  [normalize("D'Andre Swift"),-8],
  [normalize('Emeka Egbuka'),-5],
  [normalize('Ashton Jeanty'),-5]
]);
const risk=(p)=>riskPenalty.get(normalize(p.name))||0;
function counts(roster){const c={QB:0,RB:0,WR:0,TE:0,DEF:0,K:0};for(const p of roster)if(c[p.pos]!=null)c[p.pos]++;return c}
function erf(x){const sign=x<0?-1:1;x=Math.abs(x);const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911,t=1/(1+p*x),y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return sign*y}
const cdf=z=>.5*(1+erf(z/Math.SQRT2));
function goneProbability(p,currentPick,nextPick){if(!nextPick)return 1;const now=cdf((currentPick-p.adp)/p.sd),next=cdf((nextPick-p.adp)/p.sd);return clamp((next-now)/Math.max(.001,1-now),0,1)}

function legal(p,roster,r){const c=counts(roster);if(r===15)return p.pos==='DEF';if(r===16)return p.pos==='K';if(['DEF','K'].includes(p.pos))return false;if(r<=2&&!['RB','WR'].includes(p.pos))return false;if(c.QB>=1&&p.pos==='QB'&&r<13)return false;if(c.TE>=1&&p.pos==='TE'&&r<13)return false;if(c.QB>=2&&p.pos==='QB')return false;if(c.TE>=2&&p.pos==='TE')return false;return true}
function validatedScore(p,roster,r){if(!legal(p,roster,r))return-1e9;const c=counts(roster),pick=PICKS[r-1],next=PICKS[r]||240;let s=p.vor+risk(p);const diff=pick-p.adp;s+=clamp(diff*.28,-10,10);if(p.adp>pick+Math.max(10,p.sd*1.2))s-=(p.adp-pick-Math.max(10,p.sd*1.2))*.9;s+=goneProbability(p,pick,next)*Math.max(5,p.vor+20)*.09;
  if(r<=4){if(c.RB<2&&p.pos==='RB')s+=13;if(c.WR<2&&p.pos==='WR')s+=12;if(c.RB===0&&r>=3&&p.pos==='RB')s+=18;if(c.WR===0&&r>=3&&p.pos==='WR')s+=18;if(c.RB>=2&&c.WR<2&&p.pos==='RB')s-=22;if(c.WR>=2&&c.RB<2&&p.pos==='WR')s-=18}
  if(r>=4&&c.RB<2&&p.pos==='RB')s+=12+(r-4)*4;if(r>=4&&c.WR<2&&p.pos==='WR')s+=11+(r-4)*4;if(r>=5&&c.RB+c.WR<5&&['RB','WR'].includes(p.pos))s+=8;if(r>=5&&c.WR<3&&p.pos==='WR')s+=5;
  if(c.QB<1&&p.pos==='QB'){if(r===3)s+=4;if(r===4)s+=7;if(r>=5)s+=8+(r-5)*8}
  if(c.TE<1&&p.pos==='TE'){if(r===3)s+=3;if(r===4)s+=6;if(r>=5)s+=6+(r-5)*6}
  if(r>=9&&['RB','WR'].includes(p.pos))s+=Math.max(0,p.vor+15)*.13+(p.sd>12?2:0);if(r>=11&&p.pos==='RB')s+=3;
  return s;
}
function validatedChoose(available,roster,r){return available.filter(p=>legal(p,roster,r)&&risk(p)>-500).sort((a,b)=>validatedScore(b,roster,r)-validatedScore(a,roster,r)||a.adp-b.adp)[0]||null}

function appNeed(p,r,c){let s=0;if(c.QB&&p.pos==='QB')s-=50;if(c.TE&&p.pos==='TE')s-=24;if(r===1)s+=p.pos==='RB'?13:p.pos==='WR'?11:-60;else if(r===2)s+=c.RB?(p.pos==='RB'?17:p.pos==='WR'?14:-35):(p.pos==='RB'?28:-12);else if(r<=4){if(c.RB<2&&p.pos==='RB')s+=23;if(c.WR<2&&p.pos==='WR')s+=23;if(['QB','TE'].includes(p.pos))s-=14}else if(r<=6){if(c.RB<2&&p.pos==='RB')s+=21;if(c.WR<3&&p.pos==='WR')s+=16;if(c.QB<1&&p.pos==='QB')s+=r===6?17:4;if(c.TE<1&&p.pos==='TE')s+=10}else if(r<=8){if(c.QB<1&&p.pos==='QB')s+=38;if(c.TE<1&&p.pos==='TE')s+=18;if(['RB','WR'].includes(p.pos))s+=8}else if(r<=10){if(c.TE<1&&p.pos==='TE')s+=40;if(c.QB<1&&p.pos==='QB')s+=25;if(['RB','WR'].includes(p.pos))s+=10}else if(r<15)s+=['RB','WR'].includes(p.pos)?25:-45;else s+=r===15?(p.pos==='DEF'?110:-110):(p.pos==='K'?110:-110);return s}
function appChoose(availableKeys,roster,r){const pick=PICKS[r-1],c=counts(roster);return appPlayers.filter(p=>p.market&&availableKeys.has(key(p.market.name,p.market.pos))).filter(p=>r===15?p.pos==='DEF':r===16?p.pos==='K':!['DEF','K'].includes(p.pos)&&(r===1?p.adp<30:p.adp>=pick-23&&p.adp<=pick+54)).sort((a,b)=>{const f=p=>48-Math.abs(p.adp-pick)*.55+Math.max(-14,Math.min(24,(pick-p.adp)*1.25))+appNeed(p,r,c);return f(b)-f(a)||a.adp-b.adp})[0]?.market||null}
function marketChoose(available,roster,r){const c=counts(roster);return available.filter(p=>legal(p,roster,r)).sort((a,b)=>a.adp-b.adp)[0]||null}

function boardSample(scale){return market.map(p=>({p,slot:clamp(p.adp+normal()*p.sd*scale,Math.max(1,p.high),Math.max(p.high,p.low))+rng()*.001})).sort((a,b)=>a.slot-b.slot)}
function lineup(roster){const skill=roster.filter(p=>['QB','RB','WR','TE'].includes(p.pos)),used=new Set();const take=(pos,n)=>skill.filter(p=>p.pos===pos).sort((a,b)=>b.proj-a.proj).slice(0,n);const q=take('QB',1),rb=take('RB',2),wr=take('WR',2),te=take('TE',1);[...q,...rb,...wr,...te].forEach(p=>used.add(key(p.name,p.pos)));const flex=skill.filter(p=>['RB','WR','TE'].includes(p.pos)&&!used.has(key(p.name,p.pos))).sort((a,b)=>b.proj-a.proj).slice(0,1);flex.forEach(p=>used.add(key(p.name,p.pos)));const starters=[...q,...rb,...wr,...te,...flex],bench=skill.filter(p=>!used.has(key(p.name,p.pos)));return{starter:starters.reduce((s,p)=>s+p.proj,0),objective:starters.reduce((s,p)=>s+p.proj,0)+bench.reduce((s,p)=>s+Math.max(0,p.vor)*.15,0),starters}}
function fallbackPosition(r){return{name:r===15?'Streaming Defense':'Streaming Kicker',pos:r===15?'DEF':'K',adp:PICKS[r-1],sd:99,high:PICKS[r-1],low:PICKS[r-1],proj:0,vor:0}}
function simulate(policy,board){const available=new Map(market.map(p=>[key(p.name,p.pos),p])),roster=[],picks=[];let cursor=0;for(let overall=1;overall<=224;overall++){const r=PICKS.indexOf(overall)+1;if(r){const avail=[...available.values()];let chosen=policy==='current'?appChoose(new Set(available.keys()),roster,r):policy==='validated'?validatedChoose(avail,roster,r):marketChoose(avail,roster,r);if(!chosen)chosen=(r>=15?fallbackPosition(r):marketChoose(avail,roster,r));if(!chosen)throw new Error(`No choice round ${r}`);roster.push(chosen);picks.push({round:r,overall,name:chosen.name,pos:chosen.pos,adp:chosen.adp,externalRank:avail.filter(p=>legal(p,roster.slice(0,-1),r)&&risk(p)>-500).sort((a,b)=>validatedScore(b,roster.slice(0,-1),r)-validatedScore(a,roster.slice(0,-1),r)).findIndex(p=>key(p.name,p.pos)===key(chosen.name,chosen.pos))+1});available.delete(key(chosen.name,chosen.pos))}else{while(cursor<board.length&&!available.has(key(board[cursor].p.name,board[cursor].p.pos)))cursor++;if(cursor<board.length)available.delete(key(board[cursor++].p.name,board[cursor-1].p.pos))}}
  const c=counts(roster),score=lineup(roster),complete=c.QB>=1&&c.RB>=2&&c.WR>=2&&c.TE>=1&&c.DEF>=1&&c.K>=1;return{roster,picks,c,score,complete}}

const policies=['current','validated','market'],agg=Object.fromEntries(policies.map(p=>[p,{n:0,complete:0,starter:0,objective:0,top3:0,top5:0,rounds:Array.from({length:16},()=>({n:0,rank:0,top3:0})),first:new Map(),seq:new Map(),examples:[]} ]));
for(let i=0;i<SIMULATIONS;i++){const board=boardSample(i%2?.8:1.2);for(const policy of policies){const x=simulate(policy,board),a=agg[policy];a.n++;a.complete+=x.complete;a.starter+=x.score.starter;a.objective+=x.score.objective;for(let r=0;r<16;r++){const rank=Math.max(1,x.picks[r].externalRank||999),rr=a.rounds[r];rr.n++;rr.rank+=rank;if(rank<=3){rr.top3++;a.top3++}if(rank<=5)a.top5++}const first=x.picks[0].name,f=a.first.get(first)||{n:0,starter:0,objective:0};f.n++;f.starter+=x.score.starter;f.objective+=x.score.objective;a.first.set(first,f);const seq=x.picks.slice(0,4).map(p=>p.name).join(' > ');a.seq.set(seq,(a.seq.get(seq)||0)+1);if(a.examples.length<6&&i%Math.max(1,Math.floor(SIMULATIONS/6))===0)a.examples.push(x.picks.map(p=>`R${p.round} ${p.name} (${p.pos})`).join(' | '))}}
function summary(a){return{simulations:a.n,completePct:+(100*a.complete/a.n).toFixed(1),avgStarterPoints:+(a.starter/a.n).toFixed(1),avgRosterObjective:+(a.objective/a.n).toFixed(1),top3ExternalPct:+(100*a.top3/(a.n*16)).toFixed(1),top5ExternalPct:+(100*a.top5/(a.n*16)).toFixed(1),byRound:a.rounds.map((x,i)=>({round:i+1,avgExternalRank:+(x.rank/x.n).toFixed(2),top3Pct:+(100*x.top3/x.n).toFixed(1)})),firstRound:[...a.first.entries()].map(([name,x])=>({name,n:x.n,pct:+(100*x.n/a.n).toFixed(1),avgStarter:+(x.starter/x.n).toFixed(1),avgObjective:+(x.objective/x.n).toFixed(1)})).sort((a,b)=>b.n-a.n).slice(0,10),commonOpenings:[...a.seq.entries()].map(([sequence,n])=>({sequence,n,pct:+(100*n/a.n).toFixed(1)})).sort((a,b)=>b.n-a.n).slice(0,12),examples:a.examples}}
const appKeys=new Set(appPlayers.filter(p=>p.market).map(p=>key(p.market.name,p.market.pos))),top100=market.filter(p=>p.adp<=100).sort((a,b)=>a.adp-b.adp),missing=top100.filter(p=>!appKeys.has(key(p.name,p.pos))).map(p=>({name:p.name,pos:p.pos,adp:p.adp,externalRank:p.valueRank,vor:+p.vor.toFixed(1)}));
const report={generatedAt:new Date().toISOString(),seed:SEED,simulationsPerPolicy:SIMULATIONS,totalMocks:SIMULATIONS*policies.length,sources:{adp:FFC_URL,value:VALUE_URL,app:`${SITE_URL}data.js`},data:{marketPlayers:market.length,valueRows:valueRows.length,valueMatches:market.filter(p=>p.valueRank!=null).length,appPlayers:appPlayers.length,appMarketMatches:appPlayers.filter(p=>p.market).length,missingTop100Count:missing.length,missingTop100:missing},results:Object.fromEntries(policies.map(p=>[p,summary(agg[p])]))};
console.log('VALIDATION_REPORT_START');console.log(JSON.stringify(report,null,2));console.log('VALIDATION_REPORT_END');
