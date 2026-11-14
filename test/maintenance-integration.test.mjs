import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/maintenance.mjs', import.meta.url));
const fake = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const name = path.basename(process.argv[1]), a = process.argv.slice(2), d = process.env.FIXTURE;
const read = n => JSON.parse(fs.readFileSync(path.join(d,n)));
fs.appendFileSync(path.join(d,'calls'), JSON.stringify([name,...a])+'\\n');
if (name === 'hc') {
 if (a[0] === 'get') console.log('{}');
 else if (a[0] === 'ls') console.log(JSON.stringify(read('terminals')));
 else if (a[0] === 'run') {
  if (fs.existsSync(path.join(d,'lavish-kit/maintenance/owner--project/lock'))) process.exit(3);
  const s = read('lavish-kit/maintenance/owner--project/state.json');
  if (!s.jobs.some(j => j.status === 'launching' && j.name === a[a.indexOf('--name')+1])) process.exit(4);
  fs.writeFileSync(path.join(d,'terminals'), JSON.stringify({terminals:[{name:a[a.indexOf('--name')+1],address:'worker',state:'live'}]}));
 }
} else if (name === 'gh') {
 const cfg = read('github'), endpoint = a.at(-1);
 if (cfg.rate) { console.log('HTTP/2 429\\r\\nRetry-After: 600\\r\\n\\r\\n{}'); process.exit(1); }
 const conditional = a.includes('If-None-Match: "v1"');
 if (conditional && cfg.notModified) { console.log('HTTP/2 304\\r\\nETag: "v1"\\r\\n\\r\\n'); process.exit(1); }
 const value = endpoint.includes('/comments?') ? cfg.comments : endpoint.includes('/issues?') ? [cfg.issue] : cfg.issue;
 console.log('HTTP/2 200\\r\\nETag: "v1"\\r\\n\\r\\n'+JSON.stringify(value));
} else if (name === 'npm') console.log(JSON.stringify('999.0.0'));
else if (name === 'jj') console.log(read('main'));
`;
function fixture(t) {
 const dir = mkdtempSync(path.join(os.tmpdir(), 'maintenance-integration-')); t.after(() => rmSync(dir, { recursive:true, force:true }));
 const bin = path.join(dir,'bin'); mkdirSync(bin);
 for (const name of ['hc','gh','npm','jj','herdr-polytoken']) writeFileSync(path.join(bin,name), fake, {mode:0o755});
 const put = (n,v) => writeFileSync(path.join(dir,n),JSON.stringify(v));
 const issue = {number:1,title:'First',body:'Body',state:'open',user:{login:'operator'}};
 put('github',{issue,comments:[]}); put('terminals',{terminals:[]}); put('main','main-a'); writeFileSync(path.join(dir,'calls'),'');
 const env = {...process.env, PATH:`${bin}:${process.env.PATH}`, XDG_STATE_HOME:dir, FIXTURE:dir, MAINTENANCE_REPO:'owner/project', MAINTENANCE_OPERATOR:'operator', HC_TERMINAL_ID:'watcher'};
 const file = path.join(dir,'lavish-kit/maintenance/owner--project/state.json');
 const run = (...a) => spawnSync(process.execPath,[script,...a],{env,encoding:'utf8'});
 const state = () => JSON.parse(readFileSync(file));
 const calls = () => readFileSync(path.join(dir,'calls'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 return {dir,put,issue,env,file,run,state,calls};
}
test('polls conditionally, starts one persisted worker without lock, and recovers without duplicate', t => {
 const x=fixture(t); let r=x.run('once'); assert.equal(r.status,0,r.stderr); assert.equal(r.stdout,'');
 let s=x.state(); assert.equal(s.jobs[0].status,'running'); assert.equal(s.jobs[0].terminal,'worker');
 const launch=x.calls().find(c=>c[0]==='hc' && c[1]==='run');
 assert.deepEqual(launch.slice(1,6),['run','--bg','--outlive-parent','--no-notify','--name']);
 assert.deepEqual(launch.slice(7,11),['--','herdr-polytoken','new','--prompt']); assert.match(launch[11],/propose a session goal/);
 assert.ok(x.calls().some(c=>c[0]==='npm' && c[2]==='lavish-axi'));
 s.jobs[0].status='launching'; delete s.jobs[0].terminal; writeFileSync(x.file,JSON.stringify(s));
 const npmCalls=x.calls().filter(c=>c[0]==='npm').length;
 x.put('github',{issue:x.issue,comments:[],notModified:true}); r=x.run('once'); assert.equal(r.status,0,r.stderr);
 assert.equal(x.state().jobs[0].status,'running');
 assert.equal(x.calls().filter(c=>c[0]==='npm').length,npmCalls);
 assert.equal(x.calls().filter(c=>c[0]==='hc' && c[1]==='run').length,1);
 assert.ok(x.calls().some(c=>c.includes('If-None-Match: "v1"')));
 s=x.state(); assert.equal(s.jobs.filter(j=>j.kind==='issue').length,1);
 x.put('github',{issue:x.issue,comments:[{id:1,body:'🤖 status',updated_at:'1',user:{login:'operator'}}]});
 assert.equal(x.run('once').status,0); assert.equal(x.state().jobs.filter(j=>j.kind==='issue').length,1);
 x.put('github',{issue:{...x.issue,title:'Edited'},comments:[]}); assert.equal(x.run('once').status,0); assert.equal(x.state().jobs.filter(j=>j.kind==='issue').length,2);
});
test('fresh activity, backoff, and changed main after reviewed candidates', t => {
 const x=fixture(t); assert.equal(x.run('once').status,0);
 const s=x.state(), issue=s.jobs.find(j=>j.kind==='issue'), maintenance=s.jobs.find(j=>j.kind==='maintenance');
 const worker=(...a)=>spawnSync(process.execPath,[script,...a],{env:{...x.env,HC_TERMINAL_ID:'worker'},encoding:'utf8'});
 const claim=worker('claim',issue.id); assert.equal(claim.status,0,claim.stderr); const token=claim.stdout.trim();
 x.put('github',{issue:x.issue,comments:[],notModified:true}); assert.equal(worker('check-activity',issue.id,token).status,0);
 x.put('github',{issue:{...x.issue,body:'Changed'},comments:[]}); assert.notEqual(worker('check-activity',issue.id,token).status,0);
 assert.equal(worker('outcome',issue.id,token,'blocked','changed').status,0);
 let st=x.state(); st.jobs=[]; st.sweptMain='main-a'; st.reviewed=Object.fromEntries(maintenance.details.candidates.map(c=>[c.name,c.latest])); writeFileSync(x.file,JSON.stringify(st));
 x.put('github',{issue:{...x.issue,user:{login:'other'}},comments:[]}); x.put('main','main-b');
 assert.equal(x.run('once').status,0); st=x.state(); assert.equal(st.jobs.length,1); assert.deepEqual(st.jobs[0].details.candidates,[]); assert.equal(st.jobs[0].details.main,'main-b');
 x.put('github',{issue:x.issue,comments:[],rate:true}); assert.equal(x.run('once').status,0); assert.ok(x.state().backoff>Date.now());
 const count=x.calls().filter(c=>c[0]==='gh').length; assert.equal(x.run('once').status,0); assert.equal(x.calls().filter(c=>c[0]==='gh').length,count);
});
