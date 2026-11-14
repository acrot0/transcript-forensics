/**
 * The cost report's arithmetic.
 *
 * The failure this file exists to prevent: cost-state records are cumulative per
 * session and repeat on every turn. Summing all of them multiplies the bill by
 * the number of turns and produces a confidently wrong total.
 */
import { describe, it, expect } from 'vitest';
import { summarizeCost, costPerPrompt, topModel } from '../src/cf-cost.mjs';
import { dedupeResumed } from '../src/lib/transcript.mjs';

const session = (total, usage = {}) => ({ cost: { totalCostUSD: total, modelUsage: usage } });

describe('summarizeCost', () => {
  it('should sum one cost per session, not one per record', () => {
    const s = summarizeCost([
      session(2, { 'a/m': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, costUSD: 2 } }),
      session(3, { 'a/m': { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 450, costUSD: 3 } }),
    ]);
    expect(s.total).toBe(5);
    expect(s.models[0].costUSD).toBe(5);
    expect(s.models[0].input).toBe(150);
  });

  it('should exclude a session with no cost record rather than counting it as zero', () => {
    const s = summarizeCost([session(1), { cost: null }]);
    expect(s.total).toBe(1);
    expect(s.reported).toBe(1);
    expect(s.unknownCostSessions).toBe(1);
  });

  it('should rank models by spend', () => {
    const s = summarizeCost([session(10, { cheap: { costUSD: 1 }, expensive: { costUSD: 9 } })]);
    expect(s.models.map((m) => m.model)).toEqual(['expensive', 'cheap']);
  });

  it('should compute the cache-read share over prompt tokens only', () => {
    const s = summarizeCost([session(1, { m: { inputTokens: 200, cacheReadInputTokens: 800, costUSD: 1 } })]);
    expect(s.cacheReadShare).toBeCloseTo(0.8, 5);
  });

  it('should report no share when there is no spend at all', () => {
    const s = summarizeCost([{ cost: null }]);
    expect(s.total).toBe(0);
    expect(s.cacheReadShare).toBeNull();
  });
});

describe('resumed sessions', () => {
  /**
   * The defect this pins: cf-cost summed per FILE while cf-analyze summed per
   * SESSION ID, so the same 30-day window produced $3,566 from one tool and $3,562
   * from the other, with 37 sessions vs 34. Both looked authoritative; nothing
   * flagged the disagreement. One shared rule now, in one place.
   */
  const file = (sessionId, total, mtimeMs) => ({ sessionId, mtimeMs, cost: { totalCostUSD: total, modelUsage: { 'a/m': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: total } } } });

  it('should keep the newest file per session id', () => {
    const kept = dedupeResumed([
      file('s1', 100, 1000),
      file('s1', 100, 3000), // the resume — replays the same cumulative cost
      file('s2', 5, 2000),
    ]);
    expect(kept).toHaveLength(2);
    expect(kept.find((r) => r.sessionId === 's1').mtimeMs).toBe(3000);
  });

  it('should not inflate the total when a session was resumed 17 times', () => {
    const files = Array.from({ length: 17 }, (_, i) => file('s1', 397, 1000 + i));
    files.push(file('s2', 3, 500));
    const s = summarizeCost(dedupeResumed(files));
    expect(s.total).toBe(400); // not 397*17 + 3
    expect(s.reported).toBe(2);
  });

  it('should fall back to the filename when a record carries no session id', () => {
    const kept = dedupeResumed([
      { session: 'by-name', file: '/x/a.jsonl', mtimeMs: 1 },
      { session: 'by-name', file: '/x/b.jsonl', mtimeMs: 2 },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].file).toBe('/x/b.jsonl');
  });
});

describe('costPerPrompt', () => {
  it('should divide spend by prompts', () => {
    expect(costPerPrompt(10, 4)).toBe(2.5);
  });
  it('should be null when there were no prompts, not Infinity', () => {
    expect(costPerPrompt(10, 0)).toBeNull();
    expect(costPerPrompt(10, undefined)).toBeNull();
  });
});

describe('topModel', () => {
  it('should return the largest spender', () => {
    expect(topModel([{ model: 'a', costUSD: 1 }, { model: 'b', costUSD: 5 }]).model).toBe('b');
  });
  it('should return null when nothing cost anything', () => {
    expect(topModel([{ model: 'a', costUSD: 0 }])).toBeNull();
    expect(topModel([])).toBeNull();
  });
});
