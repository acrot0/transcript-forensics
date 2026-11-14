#!/usr/bin/env node
/**
 * transcript-forensics — one entry point.
 *
 * `npx transcript-forensics analyze` is easier to remember than a file path, and a
 * single bin means `npm i -g` adds one command, not three.
 *
 * Every subcommand hands over completely: same stdout, same exit code. A wrapper
 * that swallows an exit code turns a CI gate into a decoration.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const COMMANDS = {
  analyze: './cf-analyze.mjs',
  cost: './cf-cost.mjs',
  doctor: './cf-doctor.mjs',
  atlas: './cf-atlas.mjs',
};

/** Only the three that print a verdict; `atlas` writes a file and has no level. */
export const SWEEP = ['analyze', 'cost', 'doctor'];

export function resolveCommand(name) {
  if (typeof name !== 'string' || !name) return null;
  return COMMANDS[name.replace(/^--?/, '')] ?? null;
}

export function summarize(results) {
  const LEVELS = { ok: 0, warn: 1, unknown: 1, fail: 2 };
  const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const r of results) counts[r.level] = (counts[r.level] || 0) + 1;
  const level = results.reduce((acc, r) => (LEVELS[r.level] > LEVELS[acc] ? r.level : acc), 'ok');
  return { level, ...counts, attention: results.filter((r) => r.level !== 'ok') };
}

/** Map a tool's exit code onto a level. A crash is `unknown`, never `ok`. */
export function levelOf(code) {
  if (code === 0) return 'ok';
  if (code === 1) return 'fail';
  return 'unknown';
}

function run(file, args) {
  const full = path.join(HERE, file.replace(/^\.\//, ''));
  const res = spawnSync(process.execPath, [full, ...args], { encoding: 'utf8' });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? 1 };
}

function parseArgs(argv) {
  const out = { command: null, passthrough: [], list: false };
  for (const a of argv) {
    if (a === '--list' || a === '--help' || a === '-h') out.list = true;
    else if (!out.command && resolveCommand(a)) out.command = a.replace(/^--?/, '');
    else out.passthrough.push(a);
  }
  return out;
}

const icon = { ok: '✅', warn: '⚠️ ', fail: '❌', unknown: '❓' };

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.list || (!args.command && args.list)) {
    console.log('transcript-forensics — read-only forensics for Claude Code\n');
    for (const [name, file] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(9)} ${file}`);
    console.log('\n  transcript-forensics <command> [flags]');
    console.log('  transcript-forensics                run every check, one verdict');
    process.exit(0);
  }

  if (args.command) {
    const res = run(COMMANDS[args.command], args.passthrough);
    process.stdout.write(res.stdout);
    process.stderr.write(res.stderr);
    process.exit(res.code);
  }

  // No subcommand: run the checks, report the worst. Each one gets --json so the
  // verdict comes from its own level, not from scraping human-readable text.
  // `atlas` is excluded: it writes an HTML file and has no pass/fail to report.
  const results = [];
  for (const name of SWEEP) {
    const file = COMMANDS[name];
    const res = run(file, ['--json']);
    let level = levelOf(res.code);
    try {
      const j = JSON.parse(res.stdout);
      if (j && typeof j.level === 'string') level = j.level;
    } catch { /* not JSON: the exit code is all we have */ }
    results.push({ name, level, code: res.code });
  }
  const s = summarize(results);

  if (args.passthrough.includes('--json')) {
    console.log(JSON.stringify({ level: s.level, tools: results }, null, 2));
    process.exit(s.level === 'fail' ? 1 : 0);
  }

  console.log('transcript-forensics — full sweep (read-only)\n');
  for (const r of results) console.log(`  ${icon[r.level]} ${r.name.padEnd(9)} ${r.level.toUpperCase()}`);
  console.log(`\n  ${s.ok} ok, ${s.warn} warn, ${s.fail} fail${s.unknown ? `, ${s.unknown} unmeasured` : ''}`);
  if (s.attention.length) {
    console.log('\n  Needs attention:');
    for (const a of s.attention) console.log(`    transcript-forensics ${a.name}`);
  }
  console.log(`\n  Overall: ${icon[s.level]} ${s.level.toUpperCase()}`);
  process.exit(s.level === 'fail' ? 1 : 0);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();