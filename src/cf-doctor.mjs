#!/usr/bin/env node
/**
 * cf-doctor — is this Claude Code installation healthy?
 *
 * The session log says what the model did. This says what the *installation*
 * is doing to it: credentials sitting in plaintext, hooks aimed at files that
 * were deleted, skills whose frontmatter the loader will silently reject, a
 * CLAUDE.md that taxes every single turn, plugins whose install path is gone.
 *
 * Every check here is something that fails *quietly*. A missing hook script
 * does not error — the hook just does not run. A skill with a bad description
 * does not error — it just never fires. That is why they need a checker.
 *
 * Read-only. No file is created, modified or deleted.
 *
 * Usage:
 *   node src/cf-doctor.mjs [--json]
 *
 * Exit: 0 = no failures, 1 = at least one failure. Warnings alone exit 0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { locateProjects, listSessions, fmtBytes, parseArgs } from './lib/transcript.mjs';

export const LEVELS = { ok: 0, warn: 1, fail: 2 };

export function overallLevel(checks) {
  return checks.reduce((acc, c) => (LEVELS[c.level] > LEVELS[acc] ? c.level : acc), 'ok');
}

export function exitCodeFor(checks) {
  return overallLevel(checks) === 'fail' ? 1 : 0;
}

/** Expand a leading ~ and resolve against home. Windows paths pass through untouched. */
export function expandHome(p, home = os.homedir()) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Values that look like a credential.
 *
 * Deliberately shape-based rather than a list of vendor prefixes: the point is
 * "this file holds a bearer token", and a relay's token has no known prefix. A
 * value is reported by length and a masked head only — printing it here would
 * put it in shell history and CI logs, which is the same mistake in a new place.
 */
/**
 * Is this value a filesystem path rather than a credential?
 *
 * Paths are long, mixed-case and have no whitespace once Windows backslashes are
 * involved, so every naive entropy check flags them. A path is a path when it
 * starts like one (drive letter, tilde, or root) or ends in a file extension
 * after a separator.
 */
export function looksLikePath(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (/^[A-Za-z]:[\\/]/.test(v)) return true;
  if (/^~[\\/]/.test(v) || v === '~') return true;
  if (/^[\\/]/.test(v)) return true;
  if (/[\\/][^\\/]*\.[A-Za-z0-9]{1,5}$/.test(v)) return true;
  return false;
}

export function looksLikeSecret(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 16) return false;
  if (/^(true|false|null|undefined|\d+)$/i.test(v)) return false;
  // High-entropy blob: long, no whitespace, mixed classes.
  if (/\s/.test(v)) return false;
  // A path is long and mixed-case too; without this every file reference is a
  // "leaked credential" and the one real secret is buried in noise.
  if (looksLikePath(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(v)).length;
  return v.length >= 20 && classes >= 2;
}

export function maskSecret(value) {
  const v = String(value);
  if (v.length <= 8) return '****';
  return `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`;
}

/** Read settings.json and settings.local.json, reporting parse errors instead of throwing. */
export function readSettings(home = os.homedir(), env = process.env) {
  // Same rule as the transcript reader: an explicit CLAUDE_CONFIG_DIR is authoritative.
  // Auditing ~/.claude when the user pointed the CLI elsewhere would report a config
  // that is not in use — and the report would look perfectly healthy.
  const roots = env.CLAUDE_CONFIG_DIR ? [env.CLAUDE_CONFIG_DIR] : [path.join(home, '.claude')];

  const out = { root: null, files: [], merged: {}, errors: [] };
  for (const root of roots) {
    const main = path.join(root, 'settings.json');
    const local = path.join(root, 'settings.local.json');
    if (!fs.existsSync(main) && !fs.existsSync(local)) continue;
    out.root = root;
    for (const f of [main, local]) {
      if (!fs.existsSync(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        out.files.push({ path: f, keys: Object.keys(j), data: j });
        out.merged = { ...out.merged, ...j };
      } catch (e) {
        out.errors.push({ path: f, message: e.message });
      }
    }
    break;
  }
  return out;
}

/** Extract filesystem-looking arguments from a shell command string. */
export function pathsInCommand(cmd) {
  if (typeof cmd !== 'string') return [];
  // Quoted absolute paths, home-relative paths, and Windows drive paths.
  const found = [];
  const re = /(?:"|')((?:[A-Za-z]:[\\/]|~[\\/]|\/[\w.])[^"']+)(?:"|')/g;
  let m;
  while ((m = re.exec(cmd)) !== null) found.push(m[1]);
  return found;
}

const CHECKS = [];

/** settings.json: credentials and parse state. */
export function checkSettings(settings) {
  const checks = [];
  for (const e of settings.errors) {
    checks.push({ id: 'settingsParse', level: 'fail', detail: `${e.path} is not valid JSON: ${e.message}. Claude Code ignores a settings file it cannot parse, so every setting in it is silently inactive.` });
  }
  if (!settings.root) {
    checks.push({ id: 'settings', level: 'warn', detail: 'No ~/.claude/settings.json found — nothing configured, or Claude Code has never run under this account.' });
    return checks;
  }

  // Keys whose value is a COMMAND, not a credential. apiKeyHelper exists precisely
  // so the secret lives elsewhere; flagging the path it points at would be a
  // false positive on the one setting that is doing the right thing.
  const COMMAND_VALUED = new Set(['apiKeyHelper', 'command', 'statusLine', 'command']);

  // A credential in settings.json is readable by anything running as this user,
  // and by every backup copy. Name the key; never reproduce the value.
  const leaked = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (COMMAND_VALUED.has(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
      else if (typeof v === 'string' && looksLikeSecret(v) && /(token|key|secret|password|auth)/i.test(k)) {
        leaked.push({ key: p, masked: maskSecret(v) });
      }
    }
  };
  walk(settings.merged, '');
  if (leaked.length > 0) {
    checks.push({
      id: 'inlineSecret', level: 'warn',
      detail: `${leaked.length} credential(s) stored as plaintext in settings.json: ${leaked.map((l) => `${l.key} = ${l.masked}`).join('; ')}. Prefer an apiKeyHelper that reads from a secret store, and treat every *.bak copy of this file as a credential too.`,
      secrets: leaked,
    });
  } else {
    checks.push({ id: 'inlineSecret', level: 'ok', detail: 'No credential-shaped values in settings.json keys that name one' });
  }

  const helper = settings.merged.apiKeyHelper;
  if (helper) {
    // The helper is a shell command; the first quoted path is what must exist.
    const p = pathsInCommand(helper)[0];
    if (p) {
      const abs = expandHome(p);
      checks.push(fs.existsSync(abs)
        ? { id: 'apiKeyHelper', level: 'ok', detail: `apiKeyHelper target exists: ${abs}` }
        : { id: 'apiKeyHelper', level: 'fail', detail: `apiKeyHelper points at ${abs}, which does not exist. Every request that needs a key will fail before it leaves the machine — and the error will not name this path.` });
    } else {
      checks.push({ id: 'apiKeyHelper', level: 'ok', detail: 'apiKeyHelper is a command with no explicit path; not verifiable from here' });
    }
  }

  return checks;
}

/** hooks: every commands' referenced file must exist, or the hook silently never runs. */
export function checkHooks(settings, home = os.homedir()) {
  const hooks = settings.merged?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const missing = [];
  let total = 0;

  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.command === 'string') {
      total++;
      for (const p of pathsInCommand(node.command)) {
        const abs = expandHome(p, home);
        if (!fs.existsSync(abs)) missing.push({ event: currentEvent, path: abs });
      }
    }
    for (const v of Object.values(node)) visit(v);
  };

  let currentEvent = null;
  for (const [event, matchers] of Object.entries(hooks)) {
    currentEvent = event;
    visit(matchers);
  }

  if (missing.length === 0) {
    return [{ id: 'hooks', level: 'ok', detail: `${total} hook command(s); every referenced file exists` }];
  }
  const uniq = [...new Map(missing.map((m) => [m.path, m])).values()];
  return [{
    id: 'hooks', level: 'warn',
    detail: `${uniq.length} hook file(s) referenced but missing: ${uniq.slice(0, 4).map((m) => `${m.event} -> ${m.path}`).join('; ')}. A hook whose command cannot start does not fail the turn — it just does not run, so the behaviour you configured is silently absent.`,
    missing: uniq,
  }];
}

/** skills: the loader rejects these quietly, so the checks have to be explicit. */
export function checkSkills(configRoot) {
  if (!configRoot) return [];
  const dir = path.join(configRoot, 'skills');
  if (!fs.existsSync(dir)) return [{ id: 'skills', level: 'ok', detail: 'No personal skills directory' }];

  const problems = [];
  let count = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(file)) { problems.push({ name: e.name, issue: 'no SKILL.md' }); continue; }
    count++;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { problems.push({ name: e.name, issue: 'unreadable' }); continue; }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) { problems.push({ name: e.name, issue: 'no frontmatter on line 1' }); continue; }
    const name = /^name:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
    const desc = /^description:\s*(.+)$/m.exec(m[1])?.[1]?.trim();
    if (!name) problems.push({ name: e.name, issue: 'frontmatter has no name' });
    else if (name !== e.name) problems.push({ name: e.name, issue: `name "${name}" does not match the directory` });
    if (!desc) problems.push({ name: e.name, issue: 'frontmatter has no description' });
    else if (desc.length > 1024) problems.push({ name: e.name, issue: `description is ${desc.length} chars, over the 1024 cap` });
  }

  if (problems.length === 0) {
    return [{ id: 'skills', level: 'ok', detail: `${count} personal skill(s), all with loadable frontmatter` }];
  }
  return [{
    id: 'skills', level: 'warn',
    detail: `${problems.length} skill problem(s): ${problems.slice(0, 5).map((p) => `${p.name}: ${p.issue}`).join('; ')}. These load as broken or not at all, and nothing in the UI says so.`,
    problems,
  }];
}

/** Always-injected files: they tax every turn, so size is a real cost. */
export function checkMemoryFiles(configRoot, cwd = process.cwd()) {
  if (!configRoot) return [];
  const candidates = [
    { label: 'user CLAUDE.md', path: path.join(configRoot, 'CLAUDE.md') },
    { label: 'project CLAUDE.md', path: path.join(cwd, 'CLAUDE.md') },
  ];
  const checks = [];
  for (const c of candidates) {
    if (!fs.existsSync(c.path)) continue;
    const bytes = fs.statSync(c.path).size;
    // ~4 bytes/token is the rule of thumb; the number only needs to be the right order.
    const tokens = Math.round(bytes / 4);
    checks.push(bytes > 32768
      ? { id: 'memoryFile', level: 'warn', detail: `${c.label} is ${fmtBytes(bytes)} (~${tokens} tok) and is injected into every turn, including subagents. Move procedures into skills, which load only when used.`, path: c.path, bytes }
      : { id: 'memoryFile', level: 'ok', detail: `${c.label} is ${fmtBytes(bytes)} (~${tokens} tok, paid every turn)`, path: c.path, bytes });
  }
  return checks;
}

/** plugins: an enabled plugin whose install path is gone fails to load, silently. */
export function checkPlugins(configRoot) {
  if (!configRoot) return [];
  const registry = path.join(configRoot, 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(registry)) return [];
  let data;
  try { data = JSON.parse(fs.readFileSync(registry, 'utf8')); } catch (e) {
    return [{ id: 'plugins', level: 'warn', detail: `installed_plugins.json is not valid JSON: ${e.message}` }];
  }
  const entries = data.plugins || {};
  const missing = [];
  let total = 0;
  for (const [key, list] of Object.entries(entries)) {
    for (const inst of Array.isArray(list) ? list : [list]) {
      total++;
      if (inst?.installPath && !fs.existsSync(inst.installPath)) missing.push({ plugin: key, path: inst.installPath });
    }
  }
  return [missing.length === 0
    ? { id: 'plugins', level: 'ok', detail: `${total} installed plugin(s); every install path exists` }
    : { id: 'plugins', level: 'warn', detail: `${missing.length} of ${total} installed plugin(s) point at a path that no longer exists: ${missing.slice(0, 4).map((m) => m.plugin).join(', ')}. They are registered but cannot load.`, missing }];
}

/** Backup sprawl: every settings.json.bak is a stale copy of your credentials and config. */
export function checkBackups(configRoot) {
  if (!configRoot) return [];
  let files = [];
  try {
    files = fs.readdirSync(configRoot).filter((f) => /\.(bak|backup)([.-]|$)/i.test(f));
  } catch { return []; }
  const bytes = files.reduce((s, f) => { try { return s + fs.statSync(path.join(configRoot, f)).size; } catch { return s; } }, 0);
  if (files.length === 0) return [{ id: 'backups', level: 'ok', detail: 'No stray *.bak copies at the config root' }];
  return [{
    id: 'backups', level: files.length > 10 ? 'warn' : 'ok',
    detail: `${files.length} backup file(s) at ${configRoot} (${fmtBytes(bytes)}). Each one is a frozen copy of your settings — including any credential in it — and none of them is being used.`,
    count: files.length,
  }];
}

/** Transcript footprint. Not an error, but the only place this number exists. */
export function checkTranscripts(settings) {
  const projects = locateProjects();
  if (!projects) return [{ id: 'transcripts', level: 'warn', detail: 'No session directory found — session checks cannot run. That is unmeasured, not clean.' }];
  const sessions = listSessions(projects);
  if (sessions.length === 0) return [{ id: 'transcripts', level: 'ok', detail: 'Session directory exists and is empty' }];
  const bytes = sessions.reduce((s, x) => s + x.size, 0);
  // listSessions sorts by mtime (what "most recent" needs); the largest file is a
  // different question, and reporting the newest as the largest was simply wrong.
  const biggest = sessions.reduce((a, b) => (b.size > a.size ? b : a), sessions[0]);
  const staleMs = 90 * 86400000;
  const stale = sessions.filter((s) => s.mtimeMs < Date.now() - staleMs).length;
  return [{
    id: 'transcripts', level: bytes > 5e9 ? 'warn' : 'ok',
    detail: `${sessions.length} session file(s), ${fmtBytes(bytes)} total; largest ${fmtBytes(biggest.size)} (${biggest.session.slice(0, 8)}…). ${stale} older than 90 days. ` +
      `cleanupPeriodDays in settings.json sets the retention window; the value in effect here is ` +
      (settings?.merged?.cleanupPeriodDays != null ? String(settings.merged.cleanupPeriodDays) : 'unset (the built-in default applies)') + '.',
    sessions: sessions.length, bytes, largest: { session: biggest.session, size: biggest.size }, stale,
  }];
}

export function runChecks({ home = os.homedir(), env = process.env, cwd = process.cwd() } = {}) {
  const settings = readSettings(home, env);
  const checks = [
    ...checkSettings(settings),
    ...checkHooks(settings, home),
    ...checkSkills(settings.root),
    ...checkMemoryFiles(settings.root, cwd),
    ...checkPlugins(settings.root),
    ...checkBackups(settings.root),
    ...checkTranscripts(settings),
  ];
  return { settings, checks };
}

const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' };

export function renderText(checks, settings) {
  const lines = ['Claude Code install check (read-only)', ''];
  if (settings?.root) lines.push(`  config: ${settings.root}`);
  lines.push('');
  for (const c of checks) lines.push(`  ${icon[c.level]} ${String(c.id).padEnd(14)} ${c.detail}`);
  const level = overallLevel(checks);
  lines.push('');
  lines.push(`  Overall: ${icon[level]} ${level.toUpperCase()}`);
  if (checks.some((c) => c.level === 'warn' && /not found|unmeasured|No .* found/i.test(c.detail))) {
    lines.push('  A check that could not run is UNMEASURED — it is not a pass.');
  }
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { settings, checks } = runChecks();

  if (args.json) {
    const level = overallLevel(checks);
    console.log(JSON.stringify({ level, checks, configRoot: settings.root }, null, 2));
    process.exit(exitCodeFor(checks));
  }

  console.log(renderText(checks, settings));
  process.exit(exitCodeFor(checks));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
