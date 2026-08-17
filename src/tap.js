// `agentfdr statusline-tap` — a pass-through for Claude Code's status line.
//
// Claude Code hands its status-line command a JSON document on stdin that
// includes the plan's real rate-limit usage (`rate_limits.five_hour` /
// `seven_day`: used_percentage + resets_at). Nothing else on disk carries
// those numbers, so the board cannot show them unless something records them.
// This tap does exactly that — writes the latest reading per account to
// ~/.agentfdr/rate-limits.json — and echoes stdin unchanged so it can sit in
// front of whatever status line you already use:
//
//   "statusLine": { "type": "command",
//                   "command": "agentfdr statusline-tap | bash ~/.claude/statusline-command.sh" }
//
// or, with no status line of your own, `agentfdr statusline-tap --line`
// prints a compact one: [model] dir · 5h 26% · 7d 9%.
//
// Kept dependency-free and separate from cli.js so it starts fast: the status
// line runs many times a minute.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export function rateLimitsFile() {
  return process.env.AGENTFDR_RATE_FILE ?? join(homedir(), '.agentfdr', 'rate-limits.json');
}

export function claudeJsonPath() {
  if (process.env.AGENTFDR_CLAUDE_JSON) return process.env.AGENTFDR_CLAUDE_JSON;
  if (process.env.CLAUDE_CONFIG_DIR) return join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  return join(homedir(), '.claude.json');
}

/** The account this Claude Code process is signed in as (best effort). */
export function currentAccount(file = claudeJsonPath()) {
  try {
    const oa = JSON.parse(readFileSync(file, 'utf8'))?.oauthAccount ?? {};
    return {
      accountUuid: typeof oa.accountUuid === 'string' ? oa.accountUuid : null,
      email: typeof oa.emailAddress === 'string' ? oa.emailAddress : null,
    };
  } catch {
    return { accountUuid: null, email: null };
  }
}

/** Pull the reading out of a status-line payload; null when it carries none. */
export function extractRateLimits(payload) {
  const rl = payload?.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const win = (w) =>
    w && typeof w === 'object' && typeof w.used_percentage === 'number'
      ? { pct: w.used_percentage, resetsAt: typeof w.resets_at === 'number' ? w.resets_at * 1000 : null }
      : null;
  const fiveHour = win(rl.five_hour);
  const sevenDay = win(rl.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

/**
 * Merge one reading into the store, keyed by account. Returns the store.
 * The file is written atomically (rename) — the board reads it concurrently.
 */
export function recordRateLimits(reading, { file = rateLimitsFile(), account = currentAccount(), now = Date.now(), payload = {} } = {}) {
  let store = { version: 1, accounts: {} };
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d && typeof d === 'object' && d.accounts && typeof d.accounts === 'object') store = d;
  } catch {
    // first write
  }
  const key = account.accountUuid ?? 'unknown';
  store.accounts[key] = {
    email: account.email ?? null,
    accountUuid: account.accountUuid ?? null,
    fiveHour: reading.fiveHour,
    sevenDay: reading.sevenDay,
    at: now,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    model: typeof payload.model?.id === 'string' ? payload.model.id : null,
    version: typeof payload.version === 'string' ? payload.version : null,
  };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, file);
  return store;
}

/** A compact one-line status for people without a status line of their own. */
export function formatLine(payload, reading) {
  const parts = [];
  if (payload?.model?.display_name) parts.push(`[${payload.model.display_name}]`);
  const dir = payload?.workspace?.current_dir ?? payload?.cwd;
  if (dir) parts.push(dir.split('/').filter(Boolean).slice(-2).join('/'));
  if (reading?.fiveHour) parts.push(`5h ${reading.fiveHour.pct}%`);
  if (reading?.sevenDay) parts.push(`7d ${reading.sevenDay.pct}%`);
  return parts.join(' · ');
}

/** CLI entry: read stdin, record, then pass through (or print --line). */
export async function runTap(argv = process.argv.slice(3), { stdin = process.stdin, stdout = process.stdout } = {}) {
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  const reading = extractRateLimits(payload);
  if (reading) {
    try {
      recordRateLimits(reading, { payload });
    } catch {
      // never break the status line over our bookkeeping
    }
  }
  if (argv.includes('--line')) stdout.write(formatLine(payload, reading) + '\n');
  else stdout.write(raw);
}
