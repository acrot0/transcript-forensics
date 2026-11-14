
import { listSessions, readSession, locateProjects } from './src/lib/transcript.mjs';
const dir = locateProjects();
const since = Date.now() - 30*86400000;
const sessions = listSessions(dir).filter(s => s.mtimeMs >= since);
let flagged = 0, total = 0, flaggedCost = 0, totalCost = 0;
const unknownModels = new Map();
for (const s of sessions) {
  await readSession(s.path, async (r) => {
    if (r.type !== 'cost-state') return;
    total++;
    totalCost += r.totalCostUSD || 0;
    if (r.hasUnknownModelCost) { flagged++; flaggedCost += r.totalCostUSD || 0; }
  });
}
console.log({ costStates: total, flaggedUnknown: flagged, totalCost: totalCost.toFixed(2), flaggedCost: flaggedCost.toFixed(2) });
