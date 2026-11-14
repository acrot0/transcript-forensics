
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
  sum.mtimeMs = s.mtimeMs; sum.file = s.path; sum.project = s.project;
  sums.push(sum);
}
const deduped = dedupeResumed(sums);
const cost = (arr) => arr.reduce((n,s)=> n + (s.cost?.totalCostUSD ?? 0), 0);
console.log('files', sessions.length, 'raw summaries', sums.length, 'deduped', deduped.length);
console.log('raw cost', cost(sums).toFixed(2), 'deduped cost', cost(deduped).toFixed(2));
const ids = new Map();
for (const s of sums) ids.set(s.sessionId, (ids.get(s.sessionId)||0)+1);
const dupes = [...ids.entries()].filter(([,n]) => n>1).sort((a,b)=>b[1]-a[1]).slice(0,5);
console.log('top duplicated ids', dupes);
