#!/usr/bin/env node
/**
 * End-to-end acceptance against a running ZERO.
 *
 *     node scripts/verify-zero.mjs
 *
 * Drives the live system through the gateway exactly as the browser does — the
 * three acceptance scenarios, the security properties, the kill switch and the
 * audit trail. Nothing is stubbed: it starts real missions, raises a real
 * permission gate, denies it, and checks the server agreed.
 *
 * Safe to run against your own machine: every mission it creates is low-risk,
 * the one gated action is denied or spent on a database write that reports
 * itself unavailable, and no external message or post is ever sent.
 */
import { readFileSync } from 'node:fs';
const tokenFile = process.env.ZERO_TOKEN_FILE ?? new URL('../.zero/gateway-token', import.meta.url).pathname;
const token = readFileSync(tokenFile, 'utf8').trim();
const B = process.env.ZERO_URL ?? 'http://127.0.0.1:3000';
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const get = (p) => fetch(B+p,{headers:H}).then(r=>r.json());
const post = (p,b={}) => fetch(B+p,{method:'POST',headers:H,body:JSON.stringify(b)}).then(async r=>({status:r.status,body:await r.json()}));
const ok = (c,m) => console.log(`${c?'  PASS':'  FAIL'}  ${m}`);
let fails = 0;
const check = (c,m) => { if(!c) fails++; ok(c,m); };

console.log('\n=== TEST 1 — roster question (§89) ===');
const t1 = await post('/api/voice/transcript',{text:'ZERO, analysiere den aktuellen Status meiner Agenten und sag mir, welcher gerade verfügbar ist.'});
console.log('  ZERO:', t1.body.response);
check(t1.body.kind === 'answer', 'answered from the registry, no agent invoked');
check(t1.body.agents.length === 8, 'exactly eight child agents considered');
check(/Lead Scraper/.test(t1.body.response), 'names the agent that is actually available');

console.log('\n=== TEST 2 — real multi-step mission (§90) ===');
const t2 = await post('/api/missions',{objective:'Analysiere Leads und bereite einen Outreach-Funnel vor.'});
const m2 = t2.body;
console.log('  mission', m2.id, '->', m2.state);
for (const s of m2.steps) console.log(`    ${s.id} ${s.agent_id}.${s.action} = ${s.state}  ${(s.result?.summary||s.error||'').slice(0,60)}`);
check(m2.steps.length > 0, 'a plan was produced from real agents');
check(m2.steps.some(s=>s.state==='DONE'), 'at least one step did real work');
check(!m2.steps.some(s=>s.agent_id==='website_outreach' && s.state==='DONE'), 'no external message was sent');

console.log('\n=== TEST 3 — permission gate (§91) ===');
const t3 = await post('/api/missions',{objective:'Analysiere Leads und speichere sie in der Datenbank.'});
check(t3.body.state === 'AWAITING_APPROVAL', 'mission stopped at the gate');
const pend = (await get('/api/approvals')).pending.filter(a=>a.mission_id===t3.body.id);
check(pend.length === 1, 'exactly one approval raised');
const a = pend[0];
console.log(`  gate: ${a.agent_id}.${a.action} needs ${a.capability} (${a.risk_level})`);
const blocked = t3.body.steps.find(s=>s.approval_id===a.id);
check(Object.keys(blocked.result||{}).length===0, 'nothing executed before approval');

const denied = await post(`/api/approvals/${a.id}/deny`);
check(denied.body.state==='denied','DENY recorded');
const after = await get(`/api/missions/${t3.body.id}`);
check(after.steps.find(s=>s.approval_id===a.id).state==='SKIPPED','denied step never ran');

const t3b = await post('/api/missions',{objective:'Analysiere Leads und speichere sie in der Datenbank.'});
const a2 = (await get('/api/approvals')).pending.find(x=>x.mission_id===t3b.body.id);
await post(`/api/approvals/${a2.id}/approve`);
const replay = await post(`/api/approvals/${a2.id}/approve`);
check(replay.status===403, 'an approval cannot be reused');

console.log('\n=== SECURITY ===');
const noauth = await fetch(B+'/api/status').then(r=>r.status);
check(noauth===401,'LAN request without a token is refused');
const policy = await post('/api/policy/grant',{capability:'external.publish',operator_confirmed:true});
check(policy.status===403,'the always-human floor cannot be promoted, even confirmed');
const unconfirmed = await post('/api/policy/grant',{capability:'repo.write'});
check(unconfirmed.status===403,'a policy grant needs explicit operator confirmation');
const agents = await get('/api/agents');
const names = agents.agents.map(a=>a.repo.toLowerCase());
for (const bad of ['website-building','loop-engeneering','loop-engeniering','prompt-optimizer','more-available-tokens'])
  check(!names.includes(bad), `${bad} is not registered`);
check(agents.excluded.length>0, 'excluded repositories present on disk are reported as excluded');

console.log('\n=== KILL SWITCH ===');
await post('/api/system/stop',{reason:'e2e'});
const blockedM = await post('/api/missions',{objective:'Analysiere Leads'});
check(blockedM.status===423,'SAFE_MODE refuses new missions server-side');
await post('/api/system/resume');
check((await get('/api/status')).safe_mode.safe_mode===false,'resume lifts SAFE_MODE');

console.log('\n=== AUDIT ===');
const audit = await get('/api/audit?limit=500');
const raw = JSON.stringify(audit);
check(audit.entries.some(e=>e.action==='agent.invoked'),'invocations are audited');
check(audit.entries.some(e=>e.action==='approval.requested'),'gates are audited');
check(audit.entries.every(e=>!e.arguments_hash || e.arguments_hash.startsWith('sha256:')),'arguments are hashed');
check(!/sk-|ghp_|Bearer /.test(raw),'no credential-shaped strings in the audit log');

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
