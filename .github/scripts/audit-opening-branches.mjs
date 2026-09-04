import vm from 'node:vm';

const SITE_URL = 'https://nikhilanand1998.github.io/espn-live-scores/';
const INDEPENDENT_URL = 'https://raw.githubusercontent.com/dachhack/stathead/production/public/data/redraft-projections.json';
const SIMULATIONS = Number(process.env.SIMULATIONS || 12000);
const SEED = Number(process.env.SEED || 20260906);
const PICKS = [9,20,37,48,65,76,93,104,121,132,149,160,177,188,205,216];

function mulberry32(seed){return function(){let t=seed+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
const rng=mulberry32(SEED);
function normal(){let u=0,v=0;while(!u)u=rng();while(!v)v=rng();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)}
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
function normalize(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g,'').replace(/\b(defense|dst|d st)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim()}
const key=(name,pos)=>`${normalize(name)}|${pos==='DST'?'DEF':pos}`;
async function getText(url){const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 Pick9BranchAudit/1.0',accept:'*/*'}});if(!r.ok)throw new Error(`${r.status} fetching ${url}`);return r.text()}

const [dataText,engineText,patchText,independentText]=await Promise.all([
  getText(`${SITE_URL}data.js?branch-audit=${Date.now()}`),
  getText(`${SITE_URL}engine.js?branch-audit=${Date.now()}`),
  getText(`${SITE_URL}engine-patch.js?branch-audit=${Date.now()}`),
  getText(INDEPENDENT_URL)
]);
const sandbox={console,Math,Date,JSON,Set,Map,Number,String,Array,Object,Boolean};sandbox.window=sandbox;sandbox.globalThis=sandbox;vm.createContext(sandbox);vm.runInContext(dataText,sandbox);vm.runInContext(engineText,sandbox);vm.runInContext(patchText,sandbox);
const players=Array.from(sandbox.players||[]),Engine=sandbox.DraftEngine;
if(!Engine||players.length<220)throw new Error(`Bad deployed engine/data ${Boolean(Engine)} ${players.length}`);
const byName=new Map(players.map(p=>[normalize(p.name),p]));

const independent=JSON.parse(independentText).players||[];
const independentByKey=new Map(independent.map(p=>[key(p.name,p.position),Number(p.ppg)-.5*Number(p.recPG||0)]));
for(const p of players){p.independentPpg=independentByKey.get(key(p.name,p.pos))??null;p.currentPoints=Number(p.projection||0)}
for(const pos of ['QB','RB','WR','TE']){
  const known=players.filter(p=>p.pos===pos&&Number.isFinite(p.independentPpg)).sort((a,b)=>a.adp-b.adp);
  for(const p of players.filter(p=>p.pos===pos&&!Number.isFinite(p.independentPpg))){let before=known[0],after=known.at(-1);for(const v of known){if(v.adp<=p.adp)before=v;if(v.adp>=p.adp){after=v;break}}const w=clamp((p.adp-before.adp)/Math.max(1,after.adp-before.adp),0,1);p.independentPpg=before.independentPpg+(after.independentPpg-before.independentPpg)*w}
}
for(const p of players)if(!Number.isFinite(p.independentPpg))p.independentPpg=0;

function counts(roster){const c={QB:0,RB:0,WR:0,TE:0,DEF:0,K:0};for(const p of roster)if(c[p.pos]!=null)c[p.pos]++;return c}
function board(){return players.map(p=>({p,slot:clamp(p.adp+normal()*Math.max(1.5,Number(p.sd||8))*(rng()<.5?.8:1.2),Number(p.high||1),Number(p.low||p.adp+40))+rng()*.0001})).sort((a,b)=>a.slot-b.slot)}
function engineChoice(available,roster,r){const keys=new Set(available.map(p=>p.key)),blocked=new Set(players.filter(p=>!keys.has(p.key)).map(p=>p.key));return Engine.rankPlayers(players,blocked,roster,r)[0]?.player||null}
function fallback(r){return{name:r===15?'Streaming Defense':'Streaming Kicker',key:`fallback-${r}`,pos:r===15?'DEF':'K',adp:PICKS[r-1],projection:0,independentPpg:0}}
function lineup(roster,field){const skill=roster.filter(p=>['QB','RB','WR','TE'].includes(p.pos)),used=new Set(),sort=(a,b)=>(field==='current'?b.currentPoints-a.currentPoints:b.independentPpg-a.independentPpg),take=(pos,n)=>skill.filter(p=>p.pos===pos).sort(sort).slice(0,n);const q=take('QB',1),rb=take('RB',2),wr=take('WR',2),te=take('TE',1);[...q,...rb,...wr,...te].forEach(p=>used.add(p.key));const flex=skill.filter(p=>['RB','WR','TE'].includes(p.pos)&&!used.has(p.key)).sort(sort).slice(0,1),starters=[...q,...rb,...wr,...te,...flex];return field==='current'?starters.reduce((s,p)=>s+p.currentPoints,0):starters.reduce((s,p)=>s+p.independentPpg,0)}

const scenarios=[
  {id:'engine',label:'Engine best available',forced:[]},
  {id:'r1-cook',label:'James Cook',forced:['James Cook']},
  {id:'r1-achane',label:"De'Von Achane",forced:["De'Von Achane"]},
  {id:'r1-henry',label:'Derrick Henry',forced:['Derrick Henry']},
  {id:'r1-ceedee',label:'CeeDee Lamb',forced:['CeeDee Lamb']},
  {id:'r1-jefferson',label:'Justin Jefferson',forced:['Justin Jefferson']},
  {id:'cook-walker',label:'Cook > Kenneth Walker',forced:['James Cook','Kenneth Walker']},
  {id:'cook-kyren',label:'Cook > Kyren Williams',forced:['James Cook','Kyren Williams']},
  {id:'cook-hampton',label:'Cook > Omarion Hampton',forced:['James Cook','Omarion Hampton']},
  {id:'cook-pickens',label:'Cook > George Pickens',forced:['James Cook','George Pickens']},
  {id:'cook-nico',label:'Cook > Nico Collins',forced:['James Cook','Nico Collins']},
  {id:'cook-ajb',label:'Cook > A.J. Brown',forced:['James Cook','A.J. Brown']},
  {id:'ceedee-walker',label:'CeeDee > Kenneth Walker',forced:['CeeDee Lamb','Kenneth Walker']},
  {id:'ceedee-hampton',label:'CeeDee > Omarion Hampton',forced:['CeeDee Lamb','Omarion Hampton']},
  {id:'ceedee-chasebrown',label:'CeeDee > Chase Brown',forced:['CeeDee Lamb','Chase Brown']}
];
const aggregate=Object.fromEntries(scenarios.map(s=>[s.id,{label:s.label,eligible:0,current:0,independent:0,complete:0,openings:new Map(),examples:[]}]))

function simulate(sample,scenario){const available=new Map(players.map(p=>[p.key,p])),roster=[],picks=[];let cursor=0;for(let overall=1;overall<=224;overall++){const r=PICKS.indexOf(overall)+1;if(r){let chosen=null;if(r<=scenario.forced.length){const target=byName.get(normalize(scenario.forced[r-1]));if(!target||!available.has(target.key))return null;chosen=target}else chosen=engineChoice([...available.values()],roster,r);if(!chosen&&r>=15)chosen=fallback(r);if(!chosen)return null;roster.push(chosen);picks.push(chosen);available.delete(chosen.key)}else{while(cursor<sample.length&&!available.has(sample[cursor].p.key))cursor++;if(cursor<sample.length){available.delete(sample[cursor].p.key);cursor++}}}const c=counts(roster);return{roster,picks,current:lineup(roster,'current'),independent:lineup(roster,'independent'),complete:c.QB>=1&&c.RB>=2&&c.WR>=2&&c.TE>=1&&c.DEF>=1&&c.K>=1,opening:picks.slice(0,6).map(p=>p.name).join(' > ')}}

for(let i=0;i<SIMULATIONS;i++){const sample=board();for(const scenario of scenarios){const result=simulate(sample,scenario);if(!result)continue;const a=aggregate[scenario.id];a.eligible++;a.current+=result.current;a.independent+=result.independent;a.complete+=result.complete?1:0;a.openings.set(result.opening,(a.openings.get(result.opening)||0)+1);if(a.examples.length<3&&i%Math.max(1,Math.floor(SIMULATIONS/3))===0)a.examples.push(result.picks.map((p,index)=>`R${index+1} ${p.name}`).join(' | '))}}

const engine=aggregate.engine;
const result=scenarios.map(s=>{const a=aggregate[s.id],eligible=a.eligible||1;return{id:s.id,label:s.label,eligible:a.eligible,availabilityPct:+(100*a.eligible/SIMULATIONS).toFixed(1),completePct:+(100*a.complete/eligible).toFixed(1),avgCurrentProjectedStarterPoints:+(a.current/eligible).toFixed(1),avgIndependentWeeklyStarterPoints:+(a.independent/eligible).toFixed(2),deltaCurrentVsUnconditionalEngine:+(a.current/eligible-engine.current/engine.eligible).toFixed(1),deltaIndependentVsUnconditionalEngine:+(a.independent/eligible-engine.independent/engine.eligible).toFixed(2),commonOpenings:[...a.openings.entries()].map(([opening,n])=>({opening,n,pct:+(100*n/eligible).toFixed(1)})).sort((x,y)=>y.n-x.n).slice(0,5),examples:a.examples}});

console.log('OPENING_BRANCH_AUDIT_START');
console.log(JSON.stringify({generatedAt:new Date().toISOString(),seed:SEED,simulations:SIMULATIONS,sources:{site:SITE_URL,independent:INDEPENDENT_URL},results:result},null,2));
console.log('OPENING_BRANCH_AUDIT_END');
