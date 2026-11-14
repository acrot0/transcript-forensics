/**
 * Format drift — the failure this tool is most likely to die of.
 *
 * Claude Code's transcript format is undocumented and changes between versions.
 * A probe with renamed fields produced a clean `ok` report with zero findings:
 * a confident "nothing happened" on data the tool could not read. That is the
 * single worst answer a diagnostic tool can give, and it is also the easiest one
 * to ship by accident, because the code path that produces it is the happy path.
 *
 * Each test here corresponds to one way the log can stop matching this build.
 */
import { describe, it, expect } from 'vitest';
import { summarizeSession, rollup, familiarity, levelOf, KNOWN_TYPES } from '../src/cf-analyze.mjs';

const asst = (over = {}) => ({
  type: 'assistant',
  timestamp: '2026-11-14T10:00:00Z',
  sessionId: 's',
  requestedModel: 'asked-model',
  message: {
    role: 'assistant',
    model: 'answered-model',
    usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90 },
    content: [],
  },
  ...over,
});

describe('KNOWN_TYPES', () => {
  it('should contain the record types the tools read', () => {
    for (const t of ['user', 'assistant', 'system', 'cost-state']) expect(KNOWN_TYPES.has(t)).toBe(true);
  });
});

describe('familiarity', () => {
  it('should be empty when there were no records at all', () => {
    expect(familiarity({ records: 0, assistant: 0 }).verdict).toBe('empty');
    expect(familiarity(null).verdict).toBe('empty');
  });

  it('should be ok for records this build fully understands', () => {
    const s = summarizeSession([asst()]);
    expect(familiarity(s.fmt)).toMatchObject({ verdict: 'ok', ratio: 1, substitution: 'ok' });
  });

  it('should be unrecognised when assistant records exist but carry none of the fields read', () => {
    // The renamed-field case: model -> modelId, usage -> token_usage.
    const s = summarizeSession([
      { type: 'assistant', sessionId: 's', message: { role: 'assistant', modelId: 'm', token_usage: { input: 10 } } },
    ]);
    const fam = familiarity(s.fmt);
    expect(fam.verdict).toBe('unrecognised');
    expect(fam.ratio).toBe(0);
  });

  it('should be degraded when only some records match', () => {
    const s = summarizeSession([asst(), { type: 'assistant', sessionId: 's', message: { role: 'assistant' } }]);
    const fam = familiarity(s.fmt);
    expect(fam.verdict).toBe('degraded');
    expect(fam.ratio).toBeCloseTo(0.5, 5);
  });

  it('should mark the substitution check unmeasured when no record carries requestedModel', () => {
    // Measured on a real install: only 23.9% of assistant turns carry
    // `requestedModel`. So "zero substitutions" and "no substitution data" look
    // identical in the count, and only this flag tells them apart.
    const s = summarizeSession([asst({ requestedModel: undefined }), asst({ requestedModel: undefined })]);
    const fam = familiarity(s.fmt);
    expect(fam.verdict).toBe('ok');            // the rest of the report is fine
    expect(fam.substitution).toBe('unmeasured'); // this one check had no input
    expect(s.drift).toHaveLength(0);
  });

  it('should record unknown record types without calling them an error', () => {
    const s = summarizeSession([asst(), { type: 'brand-new-record-type', sessionId: 's' }]);
    expect(s.fmt.unknownTypes.get('brand-new-record-type')).toBe(1);
    expect(familiarity(s.fmt).verdict).toBe('ok'); // unknown ≠ unreadable
  });
});

describe('levelOf with format drift', () => {
  const agg = (fmt) => ({ sessions: 1, drift: [], apiErrors: [], compactions: [], fmt });

  it('should be unknown — never ok — when the format is unrecognised', () => {
    // "ok" here would be the tool claiming the user's session was clean while it
    // understood nothing about it.
    const s = summarizeSession([{ type: 'assistant', message: { modelId: 'm' } }]);
    const r = rollup([s]);
    expect(levelOf(r)).toBe('unknown');
  });

  it('should still report ordinary findings when only the substitution input is missing', () => {
    const s = summarizeSession([asst({ requestedModel: undefined })]);
    const r = rollup([s]);
    expect(levelOf(r)).toBe('ok');
  });
});

describe('rollup carries familiarity', () => {
  it('should sum the counters across sessions', () => {
    const a = summarizeSession([asst()]);
    const b = summarizeSession([asst()]);
    const r = rollup([a, b]);
    expect(r.fmt.assistant).toBe(2);
    expect(r.fmt.withModel).toBe(2);
    expect(r.fmt.withRequested).toBe(2);
  });
});
