/**
 * The install checker, tested against synthetic config trees.
 *
 * Each case is a quiet failure: a hook whose script is gone simply does not run,
 * a skill with a mismatched name simply never fires, a plugin pointing at a
 * deleted path simply does not load. None of them produce an error message, so
 * the checker has to be right about them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  looksLikeSecret, maskSecret, expandHome, pathsInCommand, readSettings,
  checkSettings, checkHooks, checkSkills, checkMemoryFiles, checkPlugins,
  overallLevel, exitCodeFor,
} from '../src/cf-doctor.mjs';

let home;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfd-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
};

describe('looksLikeSecret', () => {
  it('should accept a long high-entropy token', () => {
    expect(looksLikeSecret('sk-Ab3dEf9hIj2kLm4nOp6qRs8tUv0w')).toBe(true);
  });
  it('should reject short, boolean, and spaced values', () => {
    expect(looksLikeSecret('short')).toBe(false);
    expect(looksLikeSecret('true')).toBe(false);
    expect(looksLikeSecret('a long value with spaces in it')).toBe(false);
    expect(looksLikeSecret(undefined)).toBe(false);
  });
  it('should reject a plain command line even when it is long', () => {
    // Paths are long and mixed-case; they are not credentials.
    expect(looksLikeSecret('C:/Users/x/AppData/Roaming/ccr/bin/ccr-claude-code-api-key.cmd')).toBe(false);
  });
});

describe('maskSecret', () => {
  it('should never reproduce the value', () => {
    const masked = maskSecret('sk-Ab3dEf9hIj2kLm4nOp6qRs8tUv0w');
    expect(masked).not.toContain('Ab3dEf9hIj2kLm4');
    expect(masked).toContain('chars');
  });
});

describe('expandHome', () => {
  it('should expand a leading tilde', () => {
    expect(expandHome('~/hooks/a.sh', '/home/u')).toBe(path.join('/home/u', 'hooks/a.sh'));
  });
  it('should leave absolute paths untouched', () => {
    expect(expandHome('C:\\x\\y.cmd', '/home/u')).toBe('C:\\x\\y.cmd');
  });
});

describe('pathsInCommand', () => {
  it('should pull quoted paths out of a shell command', () => {
    const cmd = 'node "C:\\Users\\x\\.tokentracker\\bin\\notify.cjs" --source=claude';
    expect(pathsInCommand(cmd)).toEqual(['C:\\Users\\x\\.tokentracker\\bin\\notify.cjs']);
  });
  it('should return nothing for a command with no quoted path', () => {
    expect(pathsInCommand('echo hi')).toEqual([]);
    expect(pathsInCommand(null)).toEqual([]);
  });
});

describe('readSettings with CLAUDE_CONFIG_DIR', () => {
  it('should read the configured tree and not fall back to ~/.claude', () => {
    // Falling back would audit a config the CLI is not using, and the report would
    // read as a clean bill of health for the wrong directory.
    const configured = path.join(home, 'elsewhere');
    fs.mkdirSync(configured, { recursive: true });
    writeJson(path.join(configured, 'settings.json'), { model: 'x' });
    writeJson(path.join(home, '.claude', 'settings.json'), { model: 'y' });
    const s = readSettings(home, { CLAUDE_CONFIG_DIR: configured });
    expect(s.root).toBe(configured);
    expect(s.merged.model).toBe('x');
  });
});

describe('checkSettings', () => {
  it('should fail loudly on a settings file it cannot parse', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ broken');
    const s = readSettings(home, {});
    const checks = checkSettings(s);
    expect(checks.some((c) => c.id === 'settingsParse' && c.level === 'fail')).toBe(true);
  });

  it('should not flag apiKeyHelper as a leaked credential', () => {
    // apiKeyHelper exists so the secret lives elsewhere. Flagging the path it
    // points at is a false positive on the one setting doing the right thing.
    writeJson(path.join(home, '.claude', 'settings.json'), {
      apiKeyHelper: '"C:/x/bin/key.cmd"',
      env: { SOME_TOKEN: 'sk-Ab3dEf9hIj2kLm4nOp6qRs8tUv0w' },
    });
    const checks = checkSettings(readSettings(home, {}));
    const secret = checks.find((c) => c.id === 'inlineSecret');
    expect(secret.secrets.map((x) => x.key)).toEqual(['env.SOME_TOKEN']);
  });

  it('should report a missing apiKeyHelper target as a failure', () => {
    writeJson(path.join(home, '.claude', 'settings.json'), { apiKeyHelper: '"C:/nope/key.cmd"' });
    const checks = checkSettings(readSettings(home, {}));
    const c = checks.find((x) => x.id === 'apiKeyHelper');
    expect(c.level).toBe('fail');
    expect(c.detail).toContain('does not exist');
  });
});

describe('checkHooks', () => {
  it('should name a hook whose script no longer exists', () => {
    const settings = { merged: { hooks: { Stop: [{ hooks: [{ command: 'node "/gone/notify.cjs"' }] }] } } };
    const checks = checkHooks(settings, home);
    expect(checks[0].level).toBe('warn');
    expect(checks[0].missing[0].path).toContain('notify.cjs');
  });

  it('should pass when every referenced file exists', () => {
    const script = path.join(home, 'hook.cjs');
    fs.writeFileSync(script, '//');
    const settings = { merged: { hooks: { Stop: [{ hooks: [{ command: `node "${script}"` }] }] } } };
    expect(checkHooks(settings, home)[0].level).toBe('ok');
  });
});

describe('checkSkills', () => {
  const mkSkill = (name, body) => {
    const d = path.join(home, '.claude', 'skills', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), body);
  };

  it('should accept a spec-shaped skill', () => {
    mkSkill('good', '---\nname: good\ndescription: Does a thing when you need the thing done.\n---\n\nbody');
    expect(checkSkills(path.join(home, '.claude'))[0].level).toBe('ok');
  });

  it('should catch a name that does not match its directory', () => {
    // The loader keys off the directory; a mismatch means the skill does not fire
    // and nothing reports it.
    mkSkill('dir-name', '---\nname: other-name\ndescription: x\n---\n');
    const c = checkSkills(path.join(home, '.claude'))[0];
    expect(c.level).toBe('warn');
    expect(c.problems[0].issue).toMatch(/does not match/);
  });

  it('should catch a missing description and an over-cap one', () => {
    mkSkill('no-desc', '---\nname: no-desc\n---\n');
    mkSkill('too-long', `---\nname: too-long\ndescription: ${'x'.repeat(1100)}\n---\n`);
    const problems = checkSkills(path.join(home, '.claude'))[0].problems;
    expect(problems.some((p) => p.name === 'no-desc')).toBe(true);
    expect(problems.some((p) => p.name === 'too-long' && /1024/.test(p.issue))).toBe(true);
  });

  it('should catch a skill directory with no SKILL.md', () => {
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'empty'), { recursive: true });
    const c = checkSkills(path.join(home, '.claude'))[0];
    expect(c.problems[0].issue).toBe('no SKILL.md');
  });
});

describe('checkMemoryFiles', () => {
  it('should warn when the always-injected file is large', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'x'.repeat(40000));
    const c = checkMemoryFiles(path.join(home, '.claude'), home)[0];
    expect(c.level).toBe('warn');
    expect(c.detail).toContain('every turn');
  });

  it('should say nothing when no memory file exists', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    expect(checkMemoryFiles(path.join(home, '.claude'), home)).toEqual([]);
  });
});

describe('checkPlugins', () => {
  it('should find a plugin whose install path is gone', () => {
    writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
      plugins: { 'a@m': [{ installPath: path.join(home, 'gone') }], 'b@m': [{ installPath: home }] },
    });
    const c = checkPlugins(path.join(home, '.claude'))[0];
    expect(c.level).toBe('warn');
    expect(c.missing.map((m) => m.plugin)).toEqual(['a@m']);
  });

  it('should report invalid JSON instead of throwing', () => {
    const f = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'nope');
    expect(checkPlugins(path.join(home, '.claude'))[0].level).toBe('warn');
  });
});

describe('level aggregation', () => {
  it('should take the worst level', () => {
    expect(overallLevel([{ level: 'ok' }, { level: 'fail' }, { level: 'warn' }])).toBe('fail');
  });
  it('should exit 1 only on a failure', () => {
    expect(exitCodeFor([{ level: 'ok' }, { level: 'warn' }])).toBe(0);
    expect(exitCodeFor([{ level: 'fail' }])).toBe(1);
  });
});
