/**
 * What the analyzer reports, given records shaped exactly like the ones Claude
 * Code writes.
 *
 * The fixtures below are reduced from real session files (field names, the
 * nested usage object, the compact boundary metadata), because the failure mode
 * this file exists to prevent is a report that looks right and counts the wrong
 * thing.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeSession, rollup, cacheRate, dedupeCompactions, dedupeApiErrors, levelOf,
} from '../src/cf-analyze.mjs';

const user = (text) => ({ type: 'user', timestamp: '2026-11-14T10:00:00.000Z', sessionId: 's1', message: { role: 'user', content: text } });

const assistant = ({ model = 'glm-5.3-flash', requested, input = 1000, output = 100, cacheRead = 9000, tools = [], stop = 'end_turn' } = {}) => ({
  type: 'assistant',
  timestamp: '2026-11-14T10:00:01.000Z',
  sessionId: 's1',
  requestedModel: requested,
  message: {
    role: 'assistant',
    model,
    stop_reason: stop,
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 },
    content: tools.map((name) => ({ type: 'tool_use', name, input: {} })),
  },
});

const apiError = (message = 'boom', status = 500, at = '2026-11-14T10:00:02.000Z') => ({
  type: 'system', subtype: 'api_error', timestamp: at,
  error: { message, status, formatted: `${status} ${message}` }, retryAttempt: 1, maxRetries: 10,
});

const compaction = (at = '2026-11-14T10:05:00.000Z', pre = 169200, post = 28800) => ({
  type: 'system', subtype: 'compact_boundary', timestamp: at,
  compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post, cumulativeDroppedTokens: pre - post, durationMs: 1000 },
});

describe('summarizeSession', () => {
  it('should count a prompt and not count tool results as prompts', () => {
    const s = summarizeSession([
      user('do the thing'),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    ]);
    expect(s.prompts).toBe(1);
  });

  it('should sum cache reads separately from fresh input', () => {
    // Getting these two confused is the difference between a 90% hit rate and a
    // 10% one. They are different quantities and are kept apart.
    const s = summarizeSession([assistant({ input: 1000, cacheRead: 9000 })]);
    expect(s.tokens.input).toBe(1000);
    expect(s.tokens.cacheRead).toBe(9000);
  });

  it('should record a substitution only when the model really changed', () => {
    const s = summarizeSession([
      assistant({ model: 'glm-5.3-flash', requested: 'mythos-magpie-7954806631[1m]' }),
      assistant({ model: 'claude-sonnet-4-5-20260101', requested: 'sonnet' }),
    ]);
    expect(s.drift).toHaveLength(1);
    expect(s.drift[0]).toEqual({ requested: 'mythos-magpie-7954806631', actual: 'glm-5.3-flash', at: '2026-11-14T10:00:01.000Z' });
    expect(s.aliases).toBe(1);
  });

  it('should tally tool calls by name', () => {
    const s = summarizeSession([assistant({ tools: ['Bash', 'Bash', 'Edit'] })]);
    expect(s.toolCalls.get('Bash')).toBe(2);
    expect(s.toolCalls.get('Edit')).toBe(1);
  });

  it('should capture the upstream explanation, not just the status', () => {
    const s = summarizeSession([apiError('429 ZCode: quota exhausted', 429)]);
    expect(s.apiErrors[0].status).toBe(429);
    expect(s.apiErrors[0].message).toContain('quota exhausted');
    expect(s.apiErrors[0].maxRetries).toBe(10);
  });

  it('should read the compaction boundary the way the log stores it', () => {
    const s = summarizeSession([compaction()]);
    expect(s.compactions[0]).toMatchObject({ trigger: 'auto', preTokens: 169200, postTokens: 28800, dropped: 140400 });
  });

  it('should keep the client-reported cost, which is the only spend figure available', () => {
    const s = summarizeSession([{ type: 'cost-state', totalCostUSD: 2.83, modelUsage: {} }]);
    expect(s.cost.totalCostUSD).toBe(2.83);
  });

  it('should count sidechain turns separately', () => {
    const s = summarizeSession([{ ...assistant(), isSidechain: true }, assistant()]);
    expect(s.assistantTurns).toBe(2);
    expect(s.sidechainTurns).toBe(1);
  });
});

describe('cacheRate', () => {
  it('should be hits over hits-plus-misses', () => {
    expect(cacheRate({ input: 1000, cacheRead: 9000 })).toBe(90);
  });
  it('should be null rather than 0 when nothing was measured', () => {
    // 0% and "no data" are different claims; a 0 here would read as "fully cold".
    expect(cacheRate({ input: 0, cacheRead: 0 })).toBeNull();
  });
});

describe('rollup', () => {
  const mk = (id, records) => {
    const s = summarizeSession(records);
    s.sessionId = id;
    return s;
  };

  it('should sum tokens and cost across sessions', () => {
    const agg = rollup([
      mk('a', [assistant({ input: 100, cacheRead: 900 }), { type: 'cost-state', totalCostUSD: 1 }]),
      mk('b', [assistant({ input: 200, cacheRead: 800 }), { type: 'cost-state', totalCostUSD: 2 }]),
    ]);
    expect(agg.tokens.input).toBe(300);
    expect(agg.tokens.cacheRead).toBe(1700);
    expect(agg.costUSD).toBe(3);
    expect(agg.costKnown).toBe(true);
  });

  it('should say cost is unknown when no session reported it', () => {
    const agg = rollup([mk('a', [assistant()])]);
    expect(agg.costKnown).toBe(false);
  });

  it('should count one session with substitutions once', () => {
    const agg = rollup([
      mk('a', [assistant({ model: 'x', requested: 'y' }), assistant({ model: 'x', requested: 'y' })]),
      mk('b', [assistant({ model: 'x', requested: 'y' })]),
    ]);
    expect(agg.drift).toHaveLength(3);
    expect(agg.driftSessions.size).toBe(2);
  });
});

describe('dedupe', () => {
  it('should collapse a replayed compaction record', () => {
    // A resumed session rewrites the boundary into a new file. Counting both
    // makes one compaction look like two, and the report states it as a fact.
    const one = { at: '2026-11-14T10:05:00Z', preTokens: 100, postTokens: 10 };
    expect(dedupeCompactions([one, { ...one }, { ...one, postTokens: 20 }])).toHaveLength(2);
  });

  it('should collapse a replayed error record', () => {
    const e = { at: '2026-11-14T10:00:00Z', status: 429, message: 'quota' };
    expect(dedupeApiErrors([e, { ...e }])).toHaveLength(1);
  });

  it('should keep errors that differ in status or message', () => {
    const a = { at: '2026-11-14T10:00:00Z', status: 429, message: 'quota' };
    const b = { at: '2026-11-14T10:00:00Z', status: 500, message: 'boom' };
    expect(dedupeApiErrors([a, b])).toHaveLength(2);
  });
});

describe('levelOf', () => {
  it('should be unknown for a run with no sessions, never ok', () => {
    expect(levelOf({ sessions: 0, drift: [], apiErrors: [], compactions: [] })).toBe('unknown');
  });
  it('should warn on substitution by default — nothing is broken, only different', () => {
    expect(levelOf({ sessions: 1, drift: [{ requested: 'a', actual: 'b' }], apiErrors: [], compactions: [] })).toBe('warn');
  });

  it('should fail on substitution when strict, for a policy gate', () => {
    expect(levelOf({ sessions: 1, drift: [{ requested: 'a', actual: 'b' }], apiErrors: [], compactions: [] }, { strict: true })).toBe('fail');
  });
  it('should fail on a 5xx but only warn on a 429 that was retried', () => {
    expect(levelOf({ sessions: 1, drift: [], apiErrors: [{ status: 503 }], compactions: [] })).toBe('fail');
    expect(levelOf({ sessions: 1, drift: [], apiErrors: [{ status: 429 }], compactions: [] })).toBe('warn');
  });
  it('should be ok when nothing was flagged', () => {
    expect(levelOf({ sessions: 1, drift: [], apiErrors: [], compactions: [] })).toBe('ok');
  });
});
