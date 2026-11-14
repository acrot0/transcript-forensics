#!/usr/bin/env node
/**
 * Assemble one skill as a standalone, zip-ready directory.
 *
 * A skill that tells an agent to run `$TOOLKIT/src/cf-analyze.mjs` is only honest
 * if that script ships with it. In the plugin the path resolves to the plugin
 * root; in a zip handed to someone else there is no plugin root, so the code has
 * to be copied in beside SKILL.md.
 *
 * Usage:  node scripts/pack-skill.mjs <skill> [--out <dir>]
 *         node scripts/pack-skill.mjs --all
 *
 * Output: dist/<skill>/ — zip the CONTENTS, not the folder: the spec wants
 * SKILL.md at the archive root.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What each skill needs, stated explicitly.
 *
 * Derived-from-usage would look tidier and would silently drop `lib/`, which is
 * imported rather than executed — the skill would then fail at run time, after
 * someone had already downloaded it.
 */
export const SKILL_DEPS = {
  'read-sessions': ['cf-analyze.mjs', 'lib/transcript.mjs'],
  // The skill runs cf-analyze to cross-check which model answered; without it the
  // headline claim of the skill is unverifiable in the zip form.
  'audit-spend': ['cf-cost.mjs', 'cf-analyze.mjs', 'lib/transcript.mjs'],
  'audit-install': ['cf-doctor.mjs', 'lib/transcript.mjs'],
  'triage-failure': ['cf-analyze.mjs', 'lib/transcript.mjs'],
  // The atlas imports the analyzer and the doctor, so a zip without them fails at
  // the first line it executes — after download.
  'build-atlas': ['cf-atlas.mjs', 'cf-analyze.mjs', 'cf-doctor.mjs', 'lib/transcript.mjs'],
};

export function packSkill(name, outDir = path.join(ROOT, 'dist')) {
  const deps = SKILL_DEPS[name];
  if (!deps) throw new Error(`unknown skill "${name}" — known: ${Object.keys(SKILL_DEPS).join(', ')}`);
  const srcSkill = path.join(ROOT, 'skills', name, 'SKILL.md');
  if (!fs.existsSync(srcSkill)) throw new Error(`missing ${srcSkill}`);
  const dest = path.join(outDir, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(srcSkill, path.join(dest, 'SKILL.md'));
  // The README is the listing copy: a marketplace shows it before install, and a
  // zip without it forces the buyer to guess what the skill does.
  const readme = path.join(ROOT, 'skills', name, 'README.md');
  if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(dest, 'README.md'));
  for (const dep of deps) {
    const from = path.join(ROOT, 'src', dep);
    const to = path.join(dest, 'src', dep);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(dest, 'LICENSE'));
  return { name, dest, files: ['SKILL.md', 'README.md', 'LICENSE', ...deps.map((d) => `src/${d}`)] };
}

export function main(argv) {
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : undefined;
  const names = argv.includes('--all') ? Object.keys(SKILL_DEPS) : argv.filter((a) => !a.startsWith('--') && a !== outDir);
  if (names.length === 0) {
    console.error('usage: node scripts/pack-skill.mjs <skill> | --all [--out <dir>]');
    console.error(`known: ${Object.keys(SKILL_DEPS).join(', ')}`);
    process.exit(2);
  }
  for (const n of names) {
    const r = packSkill(n, outDir);
    console.log(`${r.name} -> ${path.relative(process.cwd(), r.dest)}`);
    for (const f of r.files) console.log(`  ${f}`);
  }
  console.log('\nZip the CONTENTS of each directory (SKILL.md must be at the archive root).');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2));