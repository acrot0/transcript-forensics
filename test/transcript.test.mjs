/**
 * The transcript reader's contract.
 *
 * Every assertion here is a case a naive implementation gets wrong, and each of
 * them fails silently: a wrong drift classifier produces a warning on every
 * healthy session, a non-streaming reader dies on a 175 MB file, and an
 * unbounded line parser turns one giant record into an out-of-memory.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyModel, isModelDrift, stripTag, parseLine, readSession, windowToMs,
  fmtTokens, fmtBytes, listSessions, decodeProjectName, locateProjects, MAX_LINE_BYTES,
} from '../src/lib/transcript.mjs';

describe('stripTag', () => {
  it('should remove a context-window tag, which is not part of the model id', () => {
    expect(stripTag('tokenrhythm/deepseek-flash[1m]')).toBe('tokenrhythm/deepseek-flash');
    expect(stripTag('opus[1m]')).toBe('opus');
  });
  it('should leave an untagged id alone', () => {
    expect(stripTag('glm-5.3-flash')).toBe('glm-5.3-flash');
    expect(stripTag(undefined)).toBeUndefined();
  });
});

describe('classifyModel', () => {
  it('should call an exact match "same"', () => {
    expect(classifyModel('glm-5.3-flash', 'glm-5.3-flash')).toBe('same');
  });

  it('should ignore the window tag when comparing', () => {
    expect(classifyModel('tokenrhythm/deepseek-flash[1m]', 'tokenrhythm/deepseek-flash')).toBe('same');
  });

  it('should treat a family alias as legitimate expansion, not substitution', () => {
    // The client asks for "sonnet"; a dated snapshot answers. Warning here would
    // fire on every normal session and bury the real finding.
    expect(classifyModel('sonnet', 'claude-sonnet-4-5-20260101')).toBe('alias');
    expect(classifyModel('opus[1m]', 'claude-opus-4-5')).toBe('alias');
  });

  it('should treat a removed provider prefix as the same model', () => {
    expect(classifyModel('relay/glm-5.3-flash', 'glm-5.3-flash')).toBe('equivalent');
  });

  it('should treat a dated snapshot of the requested model as equivalent', () => {
    expect(classifyModel('claude-opus-4-5', 'claude-opus-4-5-20260101')).toBe('equivalent');
  });

  it('should call a genuinely different model "substituted"', () => {
    // Measured case: the client asked for one model and the relay answered with
    // a cheaper one on 5,668 turns. Nothing in the UI says so.
    expect(classifyModel('mythos-magpie-7954806631[1m]', 'glm-5.3-flash')).toBe('substituted');
  });

  it('should never flag locally generated turns', () => {
    expect(classifyModel('claude-opus-4-5', '<synthetic>')).toBe('same');
  });

  it('should not flag a missing requested id', () => {
    expect(classifyModel(undefined, 'glm-5.3-flash')).toBe('same');
  });

  it('should expose the boolean form as "substituted only"', () => {
    expect(isModelDrift('sonnet', 'claude-sonnet-4-5')).toBe(false);
    expect(isModelDrift('a-model', 'b-model')).toBe(true);
  });
});

describe('parseLine', () => {
  it('should return null for a line over the cap without parsing it', () => {
    // A 40 MB "api-request-blob" record parsed into an object graph for no gain:
    // only its type is ever needed, and the memory is real.
    const huge = 'x'.repeat(MAX_LINE_BYTES + 10);
    expect(parseLine(huge, huge.length)).toBeNull();
  });

  it('should return null for malformed JSON rather than throwing', () => {
    expect(parseLine('{not json')).toBeNull();
    expect(parseLine('')).toBeNull();
  });

  it('should parse a well-formed record', () => {
    expect(parseLine('{"type":"user"}')).toEqual({ type: 'user' });
  });
});

describe('readSession', () => {
  it('should stream a file and count bad lines without failing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(f, ['{"type":"user"}', 'garbage', '{"type":"assistant"}', ''].join('\n'));
    const seen = [];
    const stats = await readSession(f, (r) => { seen.push(r.type); });
    expect(seen).toEqual(['user', 'assistant']);
    expect(stats.parsed).toBe(2);
    expect(stats.bad).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('listSessions', () => {
  it('should return newest first, since "why did that just fail" means this morning', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
    const a = path.join(dir, 'a.jsonl');
    const b = path.join(dir, 'b.jsonl');
    fs.writeFileSync(a, '{}');
    fs.writeFileSync(b, '{}');
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(a, old, old);
    const list = listSessions(dir);
    expect(list[0].session).toBe('b');
    expect(list[0].size).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return an empty list for a missing directory instead of throwing', () => {
    expect(listSessions(path.join(os.tmpdir(), 'does-not-exist-' + Date.now()))).toEqual([]);
  });
});

describe('locateProjects', () => {
  it('should honour CLAUDE_CONFIG_DIR over the home default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
    fs.mkdirSync(path.join(dir, 'projects'));
    expect(locateProjects({ CLAUDE_CONFIG_DIR: dir }, os.homedir())).toBe(path.join(dir, 'projects'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should return null when nothing exists, so callers can say "unmeasured"', () => {
    expect(locateProjects({}, path.join(os.tmpdir(), 'nope-' + Date.now()))).toBeNull();
  });
});

describe('decodeProjectName', () => {
  it('should make a readable label for a Windows path', () => {
    expect(decodeProjectName('E--trae-ide-data')).toBe('E:\\trae\\ide\\data');
  });
  it('should leave an unrecognised name as something readable', () => {
    expect(decodeProjectName('subagents')).toBe('subagents');
  });
});

describe('windowToMs', () => {
  it('should parse the units the CLI documents', () => {
    expect(windowToMs('7d')).toBe(7 * 86400000);
    expect(windowToMs('24h')).toBe(24 * 3600000);
    expect(windowToMs('90m')).toBe(90 * 60000);
  });
  it('should fall back rather than guess', () => {
    expect(windowToMs('nonsense')).toBe(7 * 86400000);
    expect(windowToMs(undefined)).toBe(7 * 86400000);
  });
});

describe('formatting', () => {
  it('should keep token counts readable', () => {
    expect(fmtTokens(1798400)).toBe('1.8M');
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(null)).toBe('—');
  });
  it('should keep byte counts readable', () => {
    expect(fmtBytes(859200680)).toBe('819.4MB');
    expect(fmtBytes(0)).toBe('0B');
  });
});
