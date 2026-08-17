// Live session board — every Claude Code process on this machine as a card:
// what it is working on, whether it is busy / idle / waiting on you, and which
// other live sessions it may be stepping on.
//
// Sources (all local, all already on disk):
//   ~/.claude/sessions/<pid>.json   registry Claude Code keeps for every running
//                                   process: sessionId, cwd, name, entrypoint
//                                   (cli | claude-desktop), kind (interactive | bg),
//                                   status (busy | idle | shell | waiting) + waitingFor,
//                                   and the tmux pane the CLI runs in.
//   ~/.claude/projects/**/<id>.jsonl the transcript — read as a TAIL WINDOW only.
//                                   Live transcripts reach 100 MB; a board that
//                                   re-parses them every few seconds is not a board.
//   ~/.claude/history.jsonl          full text + timestamp of every typed prompt.
//
// The registry entry is optional per field and absent for old versions; every
// read here is defensive, and the transcript tail is the fallback for state.
//
// Steering goes through tmux (`tmux send-keys` to the registered pane) — the
// only channel that reaches an interactive Claude Code session without a
// private protocol. Sessions without a tmux pane (Desktop app, background
// jobs) are read-only.

import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname, basename, resolve as resolvePath } from 'node:path';
import { execFile } from 'node:child_process';
import { projectsRoot, listProjects } from './discover.js';
import { parseSessionText } from './parser.js';
import { detect } from './detect.js';
import { estimateSessionCost } from './cost.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const RECENT_ENDED_MS = 6 * 60 * 60 * 1000;
const RECENT_ENDED_CAP = 12;
// A Desktop-app session reports no status; a pending tool call whose transcript
// has been quiet this long is more likely a dialog than a slow tool. Bash's
// default timeout is 120 s, so anything shorter cries wolf on every long build.
const DESKTOP_QUIET_MS = 180 * 1000;
const FILES_CAP = 12;

/** Registry directory: sibling of the projects root, so AGENTFDR_CLAUDE_DIR relocates both. */
export function sessionsRoot() {
  return process.env.AGENTFDR_CLAUDE_SESSIONS_DIR ?? join(dirname(projectsRoot()), 'sessions');
}

export function historyFile() {
  return process.env.AGENTFDR_CLAUDE_HISTORY ?? join(dirname(projectsRoot()), 'history.jsonl');
}

export function tailBytes() {
  const mb = Number(process.env.AGENTFDR_BOARD_TAIL_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : DEFAULT_TAIL_BYTES;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // exists, owned by someone else
  }
}

// --- registry ------------------------------------------------------------------

/**
 * Every `<pid>.json` in the registry, alive or not. `alive` is decided by a
 * signal-0 probe (injectable for tests). Unreadable / malformed files are skipped.
 */
export function readRegistry({ root = sessionsRoot(), isAlive = processAlive } = {}) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    if (!/^\d+\.json$/.test(name)) continue;
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(root, name), 'utf8'));
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const pid = Number(entry.pid ?? name.slice(0, -5));
    if (!Number.isInteger(pid)) continue;
    out.push({
      pid,
      sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      name: typeof entry.name === 'string' ? entry.name : null,
      kind: typeof entry.kind === 'string' ? entry.kind : 'interactive',
      entrypoint: typeof entry.entrypoint === 'string' ? entry.entrypoint : 'cli',
      version: typeof entry.version === 'string' ? entry.version : null,
      status: typeof entry.status === 'string' ? entry.status : null,
      waitingFor: typeof entry.waitingFor === 'string' ? entry.waitingFor : null,
      tmux: typeof entry.tmux === 'string' && entry.tmux ? entry.tmux : null,
      jobId: typeof entry.jobId === 'string' ? entry.jobId : null,
      startedAt: numOrNull(entry.startedAt),
      updatedAt: numOrNull(entry.updatedAt),
      statusUpdatedAt: numOrNull(entry.statusUpdatedAt),
      alive: isAlive(pid),
    });
  }
  return out;
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

// --- transcript tail -------------------------------------------------------------

/**
 * Last `bytes` of a file, aligned to a line start (the first partial line is
 * dropped). Returns { text, truncated, size, mtimeMs }.
 */
export function readTail(file, bytes = tailBytes()) {
  const st = statSync(file);
  const start = Math.max(0, st.size - bytes);
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    let truncated = false;
    if (start > 0) {
      truncated = true;
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return { text, truncated, size: st.size, mtimeMs: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse a transcript tail into what a card needs. Pure: takes text, returns
 * { model, flags, cost, lastPromptRecord, editedFiles, tail: { truncated } }.
 */
export function summarizeTail(text, { truncated = false, config = {} } = {}) {
  const model = parseSessionText(text, '<tail>');
  const flags = detect(model, config);
  const cost = estimateSessionCost(model);

  // `last-prompt` bookkeeping lines carry the (truncated) prompt text even when
  // the prompt itself scrolled out of the window.
  let lastPromptRecord = null;
  const idx = text.lastIndexOf('{"type":"last-prompt"');
  if (idx !== -1) {
    const end = text.indexOf('\n', idx);
    try {
      const rec = JSON.parse(text.slice(idx, end === -1 ? undefined : end));
      if (typeof rec.lastPrompt === 'string' && rec.lastPrompt.trim()) lastPromptRecord = rec.lastPrompt;
    } catch {
      // partial line at the very end; ignore
    }
  }
  return { model, flags, cost, lastPromptRecord, truncated };
}

/** Files edited by turns at index >= from (Edit/Write/...), most recent last, de-duplicated. */
export function editedFiles(model, from = 0) {
  const seen = new Set();
  const out = [];
  for (const t of model.turns) {
    if (t.index < from) continue;
    for (const c of t.toolCalls) {
      if (!EDIT_TOOLS.has(c.name)) continue;
      const f = c.input?.file_path ?? c.input?.notebook_path ?? c.input?.path;
      if (typeof f !== 'string' || !f || seen.has(f)) continue;
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

// --- history ---------------------------------------------------------------------

let historyCache = { mtimeMs: -1, size: -1, bySession: new Map() };

/** sessionId -> { text, timestamp } of the last typed prompt, from ~/.claude/history.jsonl. */
export function readHistoryIndex(file = historyFile()) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return new Map();
  }
  if (historyCache.mtimeMs === st.mtimeMs && historyCache.size === st.size) return historyCache.bySession;
  const bySession = new Map();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return bySession;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e?.sessionId !== 'string' || typeof e.display !== 'string') continue;
    if (!e.display.trim() || e.display.startsWith('/')) continue; // slash commands are not tasks
    bySession.set(e.sessionId, { text: e.display, timestamp: numOrNull(e.timestamp) });
  }
  historyCache = { mtimeMs: st.mtimeMs, size: st.size, bySession };
  return bySession;
}

// --- git root ----------------------------------------------------------------------

const rootCache = new Map(); // cwd -> { repoRoot, worktreeOf }

/**
 * Walk up from cwd to the nearest `.git`. A worktree's `.git` is a FILE
 * pointing into the parent repo (`gitdir: <parent>/.git/worktrees/<name>`);
 * both the worktree and its parent are returned so sessions on the same
 * repository group together even when one runs in a worktree.
 */
export function resolveRepo(cwd) {
  if (!cwd) return { repoRoot: null, worktreeOf: null };
  const hit = rootCache.get(cwd);
  if (hit) return hit;
  let dir = resolvePath(cwd);
  let result = { repoRoot: null, worktreeOf: null };
  for (let i = 0; i < 40; i++) {
    const g = join(dir, '.git');
    let st = null;
    try {
      st = statSync(g);
    } catch {
      // keep walking
    }
    if (st) {
      result = { repoRoot: dir, worktreeOf: null };
      if (st.isFile()) {
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'));
          const gitdir = m ? resolvePath(dir, m[1].trim()) : null;
          const wt = gitdir && /\/\.git\/worktrees\/[^/]+$/.exec(gitdir);
          if (wt) result.worktreeOf = gitdir.slice(0, gitdir.length - wt[0].length);
        } catch {
          // unreadable pointer; treat as a plain repo
        }
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  rootCache.set(cwd, result);
  return result;
}

// --- classification -----------------------------------------------------------------

/**
 * Board state for one session. The registry status is authoritative when
 * present; without it (Desktop app, old versions) the transcript tail decides.
 * Returns { state, waitingFor, derived }.
 *   state: 'waiting' | 'busy' | 'idle' | 'unknown'
 */
export function classify(entry, tail, { now = Date.now() } = {}) {
  if (entry.status === 'waiting') return { state: 'waiting', waitingFor: entry.waitingFor ?? 'input needed', derived: false };
  if (entry.status === 'busy') return { state: 'busy', waitingFor: null, derived: false };
  if (entry.status === 'idle' || entry.status === 'shell') return { state: 'idle', waitingFor: null, derived: false };

  if (!tail?.model) return { state: 'unknown', waitingFor: null, derived: true };
  const last = tail.model.turns.at(-1);
  if (!last) return { state: 'unknown', waitingFor: null, derived: true };
  const pending = last.toolCalls.some((c) => !c.result);
  const quietMs = tail.mtimeMs ? now - tail.mtimeMs : Infinity;
  if (pending) {
    if (quietMs > DESKTOP_QUIET_MS) return { state: 'waiting', waitingFor: 'possibly a dialog', derived: true };
    return { state: 'busy', waitingFor: null, derived: true };
  }
  // stop_reason tool_use with every result in: the next turn is being
  // generated — unless the transcript has been silent long enough that the
  // turn plainly ended (Desktop app sessions record no explicit end).
  if (last.stopReason === 'tool_use' && quietMs <= DESKTOP_QUIET_MS) return { state: 'busy', waitingFor: null, derived: true };
  return { state: 'idle', waitingFor: null, derived: true };
}

// --- board -----------------------------------------------------------------------------

const tailCache = new Map(); // file -> { mtimeMs, size, summary }

function loadTailCached(file, config) {
  const st = statSync(file);
  const hit = tailCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
  const { text, truncated } = readTail(file);
  const summary = { ...summarizeTail(text, { truncated, config }), mtimeMs: st.mtimeMs, size: st.size };
  tailCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
  if (tailCache.size > 64) tailCache.delete(tailCache.keys().next().value);
  return summary;
}

/** Locate a session's transcript by id across every project directory. */
function findTranscript(sessionId, projects) {
  if (!sessionId) return null;
  for (const p of projects) {
    const s = p.sessions.find((x) => x.id === sessionId);
    if (s) return { ...s, slug: p.slug };
  }
  return null;
}

/**
 * The whole board. Injectable pieces exist for tests; defaults read the real
 * machine. Returns { generatedAt, tmux, sessions, overlaps, recent }.
 */
export function collectBoard({
  registry = readRegistry(),
  projects = listProjects(),
  history = readHistoryIndex(),
  now = Date.now(),
  config = {},
  tmuxAvailable = null,
  loadTail = (file) => loadTailCached(file, config),
} = {}) {
  const sessions = [];
  const seenTranscripts = new Set();

  for (const entry of registry) {
    if (!entry.alive) continue;
    const t = findTranscript(entry.sessionId, projects);
    let tail = null;
    if (t) {
      seenTranscripts.add(t.file);
      try {
        tail = loadTail(t.file);
      } catch {
        tail = null;
      }
    }
    const { state, waitingFor, derived } = classify(entry, tail, { now });
    const model = tail?.model ?? null;
    const lastTurn = model?.turns.at(-1) ?? null;
    // The task is the last thing the human TYPED, not the last slash command
    // (/compact, /clear ...) — those are housekeeping, not intent.
    const lastPrompt = model?.prompts.findLast((p) => !p.text.startsWith('/')) ?? null;
    const hist = entry.sessionId ? history.get(entry.sessionId) : null;
    const promptText = cleanPrompt(lastPrompt?.text ?? hist?.text ?? tail?.lastPromptRecord ?? null);
    const promptAt = lastPrompt?.timestamp ? Date.parse(lastPrompt.timestamp) : hist?.timestamp ?? null;
    // Stats "since the prompt": exact when the prompt is inside the window,
    // otherwise the whole window (flagged so the UI can say ≥).
    const from = lastPrompt ? lastPrompt.afterTurn + 1 : 0;
    const windowTurns = model ? model.turns.filter((x) => x.index >= from) : [];
    const toolCalls = windowTurns.reduce((n, x) => n + x.toolCalls.length, 0);
    const toolErrors = windowTurns.reduce((n, x) => n + x.toolCalls.filter((c) => c.result?.isError).length, 0);
    const outTokens = windowTurns.reduce((n, x) => n + x.usage.output, 0);
    const files = model ? editedFiles(model, from).slice(-FILES_CAP) : [];
    const currentTool = lastTurn?.toolCalls.find((c) => !c.result) ?? null;
    const lastText = lastTurn?.text?.trim() ? lastTurn.text.trim().slice(0, 600) : findLastText(model);
    const repo = resolveRepo(entry.cwd);
    const stateSince = entry.status ? entry.statusUpdatedAt ?? entry.updatedAt : tail?.mtimeMs ?? null;

    sessions.push({
      pid: entry.pid,
      sessionId: entry.sessionId,
      name: entry.name,
      cwd: entry.cwd,
      project: entry.cwd ? basename(entry.cwd) : null,
      repoRoot: repo.worktreeOf ?? repo.repoRoot ?? entry.cwd,
      worktreeOf: repo.worktreeOf,
      gitBranch: model?.session.gitBranch ?? null,
      entrypoint: entry.entrypoint,
      account: entry.entrypoint === 'claude-desktop' ? 'desktop' : 'cli',
      kind: entry.kind,
      version: entry.version,
      tmux: entry.tmux,
      controllable: Boolean(entry.tmux) && tmuxAvailable !== false,
      state,
      waitingFor,
      stateDerived: derived,
      stateSince,
      registryStatus: entry.status,
      startedAt: entry.startedAt,
      lastActivityAt: tail?.mtimeMs ?? null,
      title: model?.session.title ?? null,
      model: lastTurn?.model ?? model?.session.model ?? null,
      prompt: promptText ? { text: promptText.slice(0, 1200), at: promptAt, inWindow: Boolean(lastPrompt) } : null,
      lastText: lastText ?? null,
      currentTool: currentTool ? { name: currentTool.name, summary: currentTool.summary, since: currentTool.timestamp ? Date.parse(currentTool.timestamp) : null } : null,
      window: {
        turns: windowTurns.length,
        toolCalls,
        toolErrors,
        outTokens,
        contextTokens: lastTurn?.contextTokens ?? 0,
        estUsd: tail?.cost?.usd ?? null,
        truncated: Boolean(tail?.truncated) && !lastPrompt,
        files,
        // Only anomalies that touch the current task window; older ones belong
        // to the timeline, not the card.
        flags: (tail?.flags ?? [])
          .filter((f) => (f.turnEnd ?? f.turnStart ?? 0) >= from)
          .map((f) => ({ type: f.type, severity: f.severity, title: f.title ?? null, detail: f.detail ?? null })),
      },
      recentTurns: model ? recentTurns(model, from) : [],
      transcript: t ? { id: t.id, file: t.file, slug: t.slug, sizeBytes: t.size, mtimeMs: t.mtimeMs } : null,
    });
  }

  sessions.sort((a, b) => stateRank(a.state) - stateRank(b.state) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

  return {
    generatedAt: now,
    tmux: tmuxAvailable,
    sessions,
    overlaps: findOverlaps(sessions),
    recent: recentEnded(projects, seenTranscripts, now),
  };
}

function stateRank(s) {
  return { waiting: 0, busy: 1, idle: 2, unknown: 3 }[s] ?? 4;
}

const RECENT_TURNS_CAP = 8;

/** Messages relayed from another session arrive wrapped in a tag; keep the sender, drop the markup. */
function cleanPrompt(text) {
  if (!text) return null;
  const m = /^<cross-session-message\s+from="([^"]*)"[^>]*>\s*([\s\S]*?)\s*(<\/cross-session-message>)?\s*$/.exec(text);
  if (!m) return text;
  const pid = /cc-socks\/(\d+)\.sock/.exec(m[1])?.[1];
  return `↪ ${pid ? `pid ${pid}` : m[1]}: ${m[2]}`;
}

/** The last few turns of the current task, compact enough for a drawer. */
function recentTurns(model, from) {
  return model.turns
    .filter((t) => t.index >= from)
    .slice(-RECENT_TURNS_CAP)
    .map((t) => ({
      index: t.index,
      at: t.timestamp ? Date.parse(t.timestamp) : null,
      text: t.text?.trim() ? t.text.trim().slice(0, 300) : null,
      tools: t.toolCalls.map((c) => ({
        name: c.name,
        summary: c.summary,
        error: c.result?.isError === true,
        pending: !c.result,
        ms: c.result?.durationMs ?? null,
      })),
    }));
}

function findLastText(model) {
  if (!model) return null;
  for (let i = model.turns.length - 1; i >= 0; i--) {
    const txt = model.turns[i].text?.trim();
    if (txt) return txt.slice(0, 600);
  }
  return null;
}

/**
 * Cross-session influence: live sessions sharing a repository, and within
 * them, files edited by more than one session in its current window.
 */
export function findOverlaps(sessions) {
  const byRepo = new Map();
  for (const s of sessions) {
    if (!s.repoRoot) continue;
    if (!byRepo.has(s.repoRoot)) byRepo.set(s.repoRoot, []);
    byRepo.get(s.repoRoot).push(s);
  }
  const out = [];
  for (const [repo, group] of byRepo) {
    if (group.length < 2) continue;
    const fileOwners = new Map();
    for (const s of group) {
      for (const f of s.window.files) {
        if (!fileOwners.has(f)) fileOwners.set(f, []);
        fileOwners.get(f).push(s.pid);
      }
    }
    const files = [...fileOwners].filter(([, pids]) => pids.length > 1).map(([file, pids]) => ({ file, pids }));
    out.push({ repo, pids: group.map((s) => s.pid), files });
  }
  return out;
}

const probeCache = new Map(); // file -> { mtimeMs, size, info }
const PROBE_BYTES = 256 * 1024;

/**
 * Cheap identity probe for a transcript nobody is running: title, cwd, the last
 * prompt and the last thing the agent said — from the tail only (these files
 * can be 100 MB; `probeTitle` reads them whole, which is fine for `list`, not
 * for a poll loop).
 */
export function probeEnded(file) {
  const st = statSync(file);
  const hit = probeCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;
  const { text } = readTail(file, PROBE_BYTES);
  const model = parseSessionText(text, '<probe>');
  const lastPrompt = model.prompts.findLast((p) => !p.text.startsWith('/')) ?? null;
  const info = {
    title: model.session.title,
    cwd: model.session.cwd,
    gitBranch: model.session.gitBranch,
    prompt: cleanPrompt(lastPrompt?.text)?.slice(0, 300) ?? null,
    lastText: findLastText(model),
    endedAt: model.session.endedAt ? Date.parse(model.session.endedAt) : null,
  };
  probeCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
  if (probeCache.size > 64) probeCache.delete(probeCache.keys().next().value);
  return info;
}

/** Sessions whose transcript changed recently but which no live process owns. */
function recentEnded(projects, seen, now) {
  const out = [];
  for (const p of projects) {
    for (const s of p.sessions) {
      if (seen.has(s.file)) continue;
      if (now - s.mtimeMs > RECENT_ENDED_MS) continue;
      out.push({ id: s.id, slug: p.slug, file: s.file, mtimeMs: s.mtimeMs, sizeBytes: s.size });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, RECENT_ENDED_CAP).map((r) => {
    let info = {};
    try {
      info = probeEnded(r.file);
    } catch {
      // vanished mid-poll
    }
    return { ...r, ...info, project: info.cwd ? basename(info.cwd) : null };
  });
}

// --- steering (tmux) ---------------------------------------------------------------------

const KEY_ACTIONS = {
  approve: ['Enter'],   // permission dialogs default to "Yes"; Enter takes it
  deny: ['Escape'],     // Escape rejects a dialog / interrupts a running turn
  interrupt: ['Escape'],
};

/**
 * Build the tmux invocations for a steering request without running them.
 * { pid, text } types the text and submits it; { pid, action } presses a key.
 * Throws on anything the board should refuse. Exported for tests.
 */
export function buildSendCommands(target, { text, action } = {}) {
  if (typeof target !== 'string' || !/^[\w.@%:-]+$/.test(target)) throw new Error('session has no controllable tmux pane');
  if (action) {
    const keys = KEY_ACTIONS[action];
    if (!keys) throw new Error(`unknown action "${action}"`);
    return [['send-keys', '-t', target, ...keys]];
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('nothing to send');
  if (text.length > 20_000) throw new Error('message too long');
  const clean = text.replace(/\r\n?/g, '\n');
  if (clean.includes('\n')) {
    // Multi-line: paste it as one buffer (bracketed paste, so newlines do not
    // submit halfway), then press Enter separately.
    return [
      ['set-buffer', '-b', 'agentfdr', '--', clean],
      ['paste-buffer', '-p', '-d', '-b', 'agentfdr', '-t', target],
      ['send-keys', '-t', target, 'Enter'],
    ];
  }
  return [
    ['send-keys', '-t', target, '-l', '--', clean],
    ['send-keys', '-t', target, 'Enter'],
  ];
}

function tmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

/** Is a tmux server reachable? Cached for a few seconds. */
let tmuxProbe = { at: 0, ok: null };
export async function tmuxAvailable() {
  const now = Date.now();
  if (tmuxProbe.ok !== null && now - tmuxProbe.at < 10_000) return tmuxProbe.ok;
  let ok;
  try {
    await tmux(['list-sessions']);
    ok = true;
  } catch {
    ok = false;
  }
  tmuxProbe = { at: now, ok };
  return ok;
}

/**
 * Deliver a steering request to a live session. Refuses when the pid is not a
 * live registered session or has no tmux pane. Returns { ok, target, sent }.
 */
export async function sendToSession(pid, req, { registry = readRegistry(), run = tmux, delayMs = 150 } = {}) {
  const entry = registry.find((e) => e.pid === Number(pid));
  if (!entry || !entry.alive) throw new Error(`no live session with pid ${pid}`);
  if (!entry.tmux) throw new Error('this session is not running in a tmux pane agentfdr can reach (Desktop app / background job) — it is read-only');
  const cmds = buildSendCommands(entry.tmux, req);
  for (let i = 0; i < cmds.length; i++) {
    if (i > 0 && cmds[i][0] === 'send-keys' && cmds[i].at(-1) === 'Enter') await sleep(delayMs);
    await run(cmds[i]);
  }
  return { ok: true, target: entry.tmux, sent: req.action ?? 'text' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
