import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = new URL('./audit-draft-recommendations.mjs', import.meta.url);
let source = fs.readFileSync(sourcePath, 'utf8');
const before = "if(!chosen) chosen=marketChoose(avail,roster,ourRound);\n      const selectedKey=key(chosen.name,chosen.pos);";
const after = "if(!chosen) chosen=marketChoose(avail,roster,ourRound);\n      if(!chosen && ourRound===15) chosen={name:'Streaming Defense',pos:'DEF',adp:overall,sd:99,points:0,ppg:0,vor:0,exact:false};\n      if(!chosen && ourRound===16) chosen={name:'Streaming Kicker',pos:'K',adp:overall,sd:99,points:0,ppg:0,vor:0,exact:false};\n      if(!chosen) chosen=avail[0];\n      if(!chosen) throw new Error('No available player at overall '+overall+' round '+ourRound);\n      const selectedKey=key(chosen.name,chosen.pos);";
if (!source.includes(before)) throw new Error('Audit source patch target was not found');
source = source.replace(before, after);
const target = '/tmp/audit-draft-recommendations-patched.mjs';
fs.writeFileSync(target, source);
await import(`${pathToFileURL(target).href}?v=${Date.now()}`);
