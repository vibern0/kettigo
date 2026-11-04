// Read-only status for the local runner/heartbeat. No RPC, signer or SDK access.
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '../soak-results.json');
if (!fs.existsSync(file)) { console.log(JSON.stringify({status:'not_started'})); process.exit(0); }
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const entries = Object.entries(s.transactions ?? {}), rows = entries.map(([,t]) => t);
const percentile = (a, p) => a.length ? a[Math.max(0, Math.ceil(a.length * p) - 1)] : null;
const groups = {
  transactionConfirmation: 'tx-cycle-', publicAdmissionProof: 'public-proof-cycle-',
  coldAwardDecryption: 'cold-award-', coldBalanceDecryption: 'cold-balance-', archive: 'archive-',
};
const latencyMs = Object.fromEntries(Object.entries(groups).map(([name,prefix]) => {
  const selected = (s.measurements ?? []).filter(m => m.ok && m.label.startsWith(prefix)).map(m => m.elapsedMs).sort((a,b) => a-b);
  return [name, {count:selected.length,p50:percentile(selected,.5),p95:percentile(selected,.95),p99:percentile(selected,.99)}];
}));
let alive = false; if (Number.isSafeInteger(s.pid) && s.pid > 0) { try { process.kill(s.pid,0); alive=true; } catch {} }
const cycles = Object.values(s.cycles ?? {}).filter(c => !c.canary);
const completeCycles = cycles.filter(c=>c.status==='completed');
const scheduleLags = s.startedAt ? cycles.map(c=>Math.max(0,Date.parse(c.startedAt)-Date.parse(s.startedAt)-Number(c.key.slice(6))*30*60000)) : [];
const lateCycles = scheduleLags.filter(ms=>ms>5*60000).length;
const http = {};
for (const counts of Object.values(s.http ?? {})) for (const [key,n] of Object.entries(counts)) http[key] = (http[key] ?? 0)+n;
const completedActions = Object.fromEntries(Object.entries({deposits:'deposit',admissions:'admit',exits:'exit',prizeChecks:'check'}).map(([name,verb])=>[
  name,entries.filter(([label,t])=>t.status==='confirmed'&&new RegExp(`^cycle-\\d+-${verb}-\\d+$`).test(label)).length,
]));
console.log(JSON.stringify({
  status:s.status,processAlive:alive,pid:s.pid,updatedAt:s.updatedAt,
  heartbeatAgeSeconds:s.updatedAt?(Date.now()-Date.parse(s.updatedAt))/1000:null,
  startedAt:s.startedAt??null,stopAt:s.stopAt??null,
  elapsedHours:s.startedAt?((s.completedAt?Date.parse(s.completedAt):Date.now())-Date.parse(s.startedAt))/3600000:null,
  coverage:{targetCycles:s.limits?.maxCycles??48,completedCycles:completeCycles.length,lateCycles,
    maxSchedulingLagMs:scheduleLags.length?Math.max(...scheduleLags):null,
    allScheduledCyclesObserved:completeCycles.length===(s.limits?.maxCycles??48)&&lateCycles===0},
  transactions:{total:rows.length,confirmed:rows.filter(t=>t.status==='confirmed').length,
    reverted:rows.filter(t=>t.status==='reverted').length,pending:rows.filter(t=>['signed','pending'].includes(t.status)).length,
    actualFeeWei:String(rows.reduce((n,t)=>n+BigInt(t.feeWei??0),0n)),gasFundingWei:String(rows.reduce((n,t)=>n+BigInt(t.valueWei??0),0n))},
  uniqueCompletedLoadActions:completedActions,
  cycles:cycles.map(c=>({key:c.key,size:c.size,status:c.status,drawId:c.drawId,elapsedMs:c.elapsedMs})),
  clientOutstanding:s.outstanding??0,peakClientOutstanding:s.peakOutstanding??0,
  latencyMs,latencySampleUnit:'successful operation attempt; repeated labels after recovery count again',http,errors:s.errors??[],readinessRetries:s.readinessRetries??[],aclReadRetries:s.aclReadRetries??[],userAclReadRetries:s.userAclReadRetries??[],transactionLookupRetries:s.transactionLookupRetries??[],failure:s.status==='needs_attention'?(s.failure??null):null,lastConservationAt:s.lastConservationAt??null,
  agedBaseline:s.agedBaseline??null,retentionCanary:s.retentionCanary?{drawId:s.retentionCanary.drawId,createdAt:s.retentionCanary.createdAt,
    earliestDay60:s.retentionCanary.earliestDay60,users:s.retentionCanary.proofs.length,policy:s.retentionCanary.policy}:null,
},null,2));
