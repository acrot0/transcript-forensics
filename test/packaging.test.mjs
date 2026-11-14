/**
 * The packaging contract.
 *
 * A skill that names a script it does not ship fails after the user has it — not
 * at build time. That is the whole reason this test exists: every assertion here
 * is a promise made by the plugin form that has to survive the zip form.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_DEPS, packSkill } from '../scripts/pack-skill.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, 'skills');
const dirs = fs.readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const read = (p) => fs.readFileSync(p, 'utf8');

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

describe('skills', () => {
  it('should ship at least one skill', () => {
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const name of dirs) {
    describe(name, () => {
      const text = read(path.join(SKILLS, name, 'SKILL.md'));
      const fm = frontmatter(text);

      it('should start with frontmatter', () => {
        expect(fm, `${name} has no frontmatter on line 1`).not.toBeNull();
      });
      it('should use a spec-legal name matching its directory', () => {
        expect(fm.name).toBe(name);
        expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(fm.name.length).toBeLessThanOrEqual(64);
      });
      it('should keep its description under the 1024-character cap', () => {
        expect(fm.description.length).toBeGreaterThan(40);
        expect(fm.description.length).toBeLessThanOrEqual(1024);
      });
      it('should declare MIT', () => {
        expect(fm.license).toBe('MIT');
      });
      it('should only reference scripts it actually ships', () => {
        const refs = [...text.matchAll(/\$TOOLKIT\/src\/([\w./-]+)/g)].map((m) => m[1]);
        expect(refs.length).toBeGreaterThan(0);
        for (const r of refs) {
          expect(fs.existsSync(path.join(ROOT, 'src', r)), `${name} references missing src/${r}`).toBe(true);
          expect(SKILL_DEPS[name], `${name} runs ${r} but does not ship it`).toContain(r);
        }
      });
      it('should say it is read-only', () => {
        expect(text).toMatch(/read-only|never (modifies|writes)/i);
      });
      it('should forbid claiming an unverified fix', () => {
        // The one sentence these tools must never put in an agent's mouth.
        expect(text).toMatch(/never claim a fix|do not claim a fix|not an accusation|never present|do not retry/i);
      });
    });
  }

  it('should have an explicit dependency list for every skill and no orphans', () => {
    expect(Object.keys(SKILL_DEPS).sort()).toEqual([...dirs].sort());
    for (const [name, deps] of Object.entries(SKILL_DEPS)) {
      expect(deps.length).toBeGreaterThan(0);
      for (const d of deps) expect(fs.existsSync(path.join(ROOT, 'src', d)), `${name} lists missing src/${d}`).toBe(true);
    }
  });

  it('should produce a packable directory with the code inside', () => {
    const out = fs.mkdtempSync(path.join(ROOT, '.pack-test-'));
    try {
      const r = packSkill('read-sessions', out);
      expect(fs.existsSync(path.join(r.dest, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(r.dest, 'src', 'cf-analyze.mjs'))).toBe(true);
      // The library is imported, not executed — the classic thing to forget.
      expect(fs.existsSync(path.join(r.dest, 'src', 'lib', 'transcript.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(r.dest, 'LICENSE'))).toBe(true);
      // The listing copy travels with the zip; without it the buyer sees only the
      // frontmatter description.
      expect(fs.existsSync(path.join(r.dest, 'README.md'))).toBe(true);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('manifests', () => {
  const pluginDir = path.join(ROOT, '.claude-plugin');
  const plugin = JSON.parse(read(path.join(pluginDir, 'plugin.json')));
  const market = JSON.parse(read(path.join(pluginDir, 'marketplace.json')));

  it('should keep marketplace, plugin.json and package.json on one version', () => {
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
    expect(market.plugins[0].name).toBe(plugin.name);
    expect(plugin.version).toBe(pkg.version);
    expect(market.plugins[0].version).toBe(pkg.version);
  });

  it('should attribute authorship to a person', () => {
    expect(plugin.author.name).toBe('acrot0');
    expect(plugin.license).toBe('MIT');
  });

  it('should list every shipped skill in both READMEs', () => {
    // build-atlas shipped while both READMEs still said "four skills". A skill
    // nobody is told about is a skill nobody installs, and no other test looks
    // at prose.
    for (const doc of ['README.md', path.join('skills', 'README.md')]) {
      const text = read(path.join(ROOT, doc));
      for (const name of dirs) {
        expect(text, `${doc} never mentions the ${name} skill`).toContain(name);
      }
    }
  });

  it('should rely on skill auto-discovery rather than a second list', () => {
    expect(plugin.skills).toBeUndefined();
    expect(fs.existsSync(SKILLS)).toBe(true);
  });

  it('should point every bin at a file that exists', () => {
    const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
    for (const [name, target] of Object.entries(pkg.bin)) {
      expect(fs.existsSync(path.join(ROOT, target)), `bin ${name} -> ${target} is missing`).toBe(true);
    }
  });
});
