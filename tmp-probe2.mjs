
import { listSessions, readSession, locateProjects } from './src/lib/transcript.mjs';
import { summarizeSession, dedupeResumed } from './src/cf-analyze.mjs';
const dir = locateProjects();
const since = Date.now() - 30*86400000;
const sessions = listSessions(dir).filter(s => s.mtimeMs >= since);
const sums = [];
for (const s of sessions) {
  const recs = [];
  await readSession(s.path, async (r) => { if (r.timestamp && Date.parse(r.timestamp) < since) return; recs.push(r); });
  const sum = summarizeSession(recs);
  if (!sum.sessionId) sum.sessionId = s.session;
  sum.mtimeMs = s.mtimeMs; sum.file = s.path;
  // how many cost-state records did this file carry, and first vs last?
  sums.push(sum);
}
const withCost = sums.filter(s => s.cost && s.cost.totalCostUSD != null);
console.log('sessions with cost', withCost.length, 'of', sums.length);
const sorted = withCost.sort((a,b)=>b.cost.totalCostUSD-a.cost.totalCostUSD);
console.log('top10:');
for (const s of sorted.slice(0,10)) {
  const d = new Date(s.mtimeMs).toISOString().slice(0,10);
  console.log('  $' + s.cost.totalCostUSD.toFixed(2), d, s.sessionId.slice(0,8), (s.file||'').split(/[\\/]/).pop());
}
console.log('total', withCost.reduce((n,s)=>n+s.cost.totalCostUSD,0).toFixed(2));
// same sessionId in multiple files?
const byId = new Map();
for (const s of withCost) { const k=s.sessionId; if(!byId.has(k))byId.set(k,[]); byId.get(k).push(s.cost.totalCostUSD); }
for (const [k,v] of [...byId].filter(([,v])=>v.length>1).slice(0,6)) console.log('dup id', k.slice(0,8), v.map(x=>x.toFixed(2)).join(', '));
