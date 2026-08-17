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
//   Claude Desktop's session store    ~/Library/Application Support/Claude/
//                                   claude-code-sessions/<account>/<org>/local_*.json:
//                                   the sessions the desktop app lists — title,
//                                   cwd, account — including ones whose process
//                                   the app has parked (no pid, still "open").
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
import { homedir } from 'node:os';
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

let historyCache = { mtimeMs: -1, size: -1, bySession: new Map(), projects: [] };

/** sessionId -> { text, timestamp } of the last typed prompt, from ~/.claude/history.jsonl. */
export function readHistoryIndex(file = historyFile()) {
  return loadHistory(file).bySession;
}

/** Directories you have run Claude Code in, most recently used first — the launcher's suggestions. */
export function knownProjectDirs(file = historyFile(), { limit = 40 } = {}) {
  return loadHistory(file).projects
    .filter((p) => {
      try {
        return statSync(p.dir).isDirectory();
      } catch {
        return false;
      }
    })
    .slice(0, limit);
}

function loadHistory(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { bySession: new Map(), projects: [] };
  }
  if (historyCache.mtimeMs === st.mtimeMs && historyCache.size === st.size) return historyCache;
  const bySession = new Map();
  const lastByDir = new Map();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { bySession, projects: [] };
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e.project === 'string' && e.project) lastByDir.set(e.project, Math.max(lastByDir.get(e.project) ?? 0, numOrNull(e.timestamp) ?? 0));
    if (typeof e?.sessionId !== 'string' || typeof e.display !== 'string') continue;
    if (!e.display.trim() || e.display.startsWith('/')) continue; // slash commands are not tasks
    bySession.set(e.sessionId, { text: e.display, timestamp: numOrNull(e.timestamp) });
  }
  const projects = [...lastByDir].map(([dir, lastAt]) => ({ dir, lastAt })).sort((a, b) => b.lastAt - a.lastAt);
  historyCache = { mtimeMs: st.mtimeMs, size: st.size, bySession, projects };
  return historyCache;
}

// --- Claude Desktop session store --------------------------------------------------

/** Where the Claude desktop app keeps its Claude Code session index. */
export function desktopStoreRoot() {
  if (process.env.AGENTFDR_DESKTOP_DIR) return process.env.AGENTFDR_DESKTOP_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code-sessions');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude', 'claude-code-sessions');
}

export function claudeJsonPath() {
  if (process.env.AGENTFDR_CLAUDE_JSON) return process.env.AGENTFDR_CLAUDE_JSON;
  // A second account on the same machine lives in its own CLAUDE_CONFIG_DIR.
  if (process.env.CLAUDE_CONFIG_DIR) return join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  return join(homedir(), '.claude.json');
}

const desktopCache = new Map(); // file -> { mtimeMs, size, entry }

/**
 * Every session the desktop app knows about, live or parked:
 * [{ desktopId, cliSessionId, cwd, title, model, lastActivityAt, createdAt,
 *    archived, accountUuid, orgUuid, permissionMode, completedTurns }].
 * The store's values are all strings (booleans and numbers included) — parse
 * defensively. Missing store (no desktop app) -> [].
 */
export function readDesktopStore(root = desktopStoreRoot()) {
  if (!existsSync(root)) return [];
  const out = [];
  let accounts;
  try {
    accounts = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const acct of accounts) {
    if (!acct.isDirectory()) continue;
    let orgs;
    try {
      orgs = readdirSync(join(root, acct.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const org of orgs) {
      if (!org.isDirectory()) continue;
      const dir = join(root, acct.name, org.name);
      let files;
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
        const file = join(dir, name);
        try {
          const st = statSync(file);
          const hit = desktopCache.get(file);
          if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
            out.push(hit.entry);
            continue;
          }
          const d = JSON.parse(readFileSync(file, 'utf8'));
          const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
          const entry = {
            desktopId: typeof d.sessionId === 'string' ? d.sessionId : name.slice(0, -5),
            cliSessionId: typeof d.cliSessionId === 'string' ? d.cliSessionId : null,
            cwd: typeof d.cwd === 'string' ? d.cwd : null,
            title: typeof d.title === 'string' && d.title ? d.title : null,
            model: typeof d.model === 'string' ? d.model : null,
            lastActivityAt: num(d.lastActivityAt),
            createdAt: num(d.createdAt),
            archived: d.isArchived === true || d.isArchived === 'True' || d.isArchived === 'true',
            accountUuid: acct.name,
            orgUuid: org.name,
            permissionMode: typeof d.permissionMode === 'string' ? d.permissionMode : null,
            completedTurns: num(d.completedTurns),
          };
          desktopCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entry });
          out.push(entry);
        } catch {
          // malformed or vanished; skip
        }
      }
    }
  }
  return out;
}

let cliAccountCache = { mtimeMs: -1, value: null };

/** The account the CLI is logged in as (from ~/.claude.json), or null. */
export function readCliAccount(file = claudeJsonPath()) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (cliAccountCache.mtimeMs === st.mtimeMs) return cliAccountCache.value;
  let value = null;
  try {
    const oa = JSON.parse(readFileSync(file, 'utf8'))?.oauthAccount;
    if (oa && typeof oa === 'object') {
      value = {
        email: typeof oa.emailAddress === 'string' ? oa.emailAddress : null,
        accountUuid: typeof oa.accountUuid === 'string' ? oa.accountUuid : null,
        orgUuid: typeof oa.organizationUuid === 'string' ? oa.organizationUuid : null,
      };
    }
  } catch {
    value = null;
  }
  cliAccountCache = { mtimeMs: st.mtimeMs, value };
  return value;
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

const HEAD_BYTES = 64 * 1024;
const headTitleCache = new Map(); // file -> title|null (the head of a transcript does not change)

/** `ai-title` lines are written early; when the tail window lost them, read the head once. */
export function probeHeadTitle(file) {
  if (headTitleCache.has(file)) return headTitleCache.get(file);
  let title = null;
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
      const text = buf.toString('utf8', 0, n);
      const idx = text.indexOf('"ai-title"');
      if (idx !== -1) {
        const start = text.lastIndexOf('\n', idx) + 1;
        const end = text.indexOf('\n', idx);
        const rec = JSON.parse(text.slice(start, end === -1 ? undefined : end));
        if (typeof rec.aiTitle === 'string' && rec.aiTitle) title = rec.aiTitle;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    title = null;
  }
  headTitleCache.set(file, title);
  if (headTitleCache.size > 256) headTitleCache.delete(headTitleCache.keys().next().value);
  return title;
}

function loadTailCached(file, config) {
  const st = statSync(file);
  const hit = tailCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
  const { text, truncated } = readTail(file);
  const summary = { ...summarizeTail(text, { truncated, config }), mtimeMs: st.mtimeMs, size: st.size };
  if (!summary.model.session.title && truncated) summary.model.session.title = probeHeadTitle(file);
  tailCache.delete(file); // LRU: re-insert at the end
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
  desktop = readDesktopStore(),
  cliAccount = readCliAccount(),
  rateLimits = readRateLimits(),
  knownDirs = knownProjectDirs(),
  now = Date.now(),
  config = {},
  tmuxAvailable = null,
  loadTail = (file) => loadTailCached(file, config),
} = {}) {
  const sessions = [];
  const seenTranscripts = new Set();
  const desktopByCli = new Map(desktop.filter((d) => d.cliSessionId).map((d) => [d.cliSessionId, d]));
  const accountLabel = (uuid) => (cliAccount?.accountUuid && uuid === cliAccount.accountUuid ? cliAccount.email : null);

  // One card per registered live process...
  const live = registry.filter((e) => e.alive).map((e) => ({ entry: e, desk: e.sessionId ? desktopByCli.get(e.sessionId) ?? null : null }));
  // ...plus the sessions the desktop app still lists but has parked (no
  // process right now). They are what you see in the app's sidebar; without
  // them the board and the app disagree about what is "open".
  const liveIds = new Set(live.map((l) => l.entry.sessionId).filter(Boolean));
  const parked = desktop
    .filter((d) => !d.archived && d.cliSessionId && !liveIds.has(d.cliSessionId))
    .map((d) => ({
      desk: d,
      entry: {
        pid: null, sessionId: d.cliSessionId, cwd: d.cwd, name: d.title, kind: 'interactive',
        entrypoint: 'claude-desktop', version: null, status: 'parked', waitingFor: null, tmux: null,
        startedAt: d.createdAt, updatedAt: d.lastActivityAt, statusUpdatedAt: d.lastActivityAt, alive: false,
      },
    }));

  for (const { entry, desk } of [...live, ...parked]) {
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
    const parkedSession = entry.status === 'parked';
    const { state, waitingFor, derived } = parkedSession
      ? { state: 'idle', waitingFor: null, derived: false }
      : classify(entry, tail, { now });
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

    const isDesktop = entry.entrypoint === 'claude-desktop';
    const accountUuid = isDesktop ? desk?.accountUuid ?? null : cliAccount?.accountUuid ?? null;
    sessions.push({
      key: entry.pid != null ? String(entry.pid) : `d:${desk?.desktopId ?? entry.sessionId}`,
      pid: entry.pid,
      sessionId: entry.sessionId,
      name: entry.name,
      cwd: entry.cwd,
      project: entry.cwd ? basename(entry.cwd) : null,
      repoRoot: repo.worktreeOf ?? repo.repoRoot ?? entry.cwd,
      worktreeOf: repo.worktreeOf,
      gitBranch: model?.session.gitBranch ?? null,
      entrypoint: entry.entrypoint,
      account: isDesktop ? 'desktop' : 'cli',
      accountUuid,
      accountEmail: isDesktop ? accountLabel(accountUuid) : cliAccount?.email ?? null,
      kind: entry.kind,
      version: entry.version,
      tmux: entry.tmux,
      controllable: tmuxAvailable !== false && isSteerable(entry, registry),
      // A child process (claude -p, SDK) registered on the same pane as an
      // interactive session: shown, but not steerable, not an "overlap".
      sharedPane: Boolean(entry.tmux) && !isSteerable(entry, registry) && entry.alive,
      state,
      parked: parkedSession,
      waitingFor,
      stateDerived: derived,
      stateSince,
      registryStatus: entry.status,
      startedAt: entry.startedAt,
      lastActivityAt: tail?.mtimeMs ?? desk?.lastActivityAt ?? null,
      title: desk?.title ?? model?.session.title ?? null,
      desktop: desk ? { id: desk.desktopId, permissionMode: desk.permissionMode, completedTurns: desk.completedTurns } : null,
      model: lastTurn?.model ?? model?.session.model ?? desk?.model ?? null,
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

  sessions.sort((a, b) => stateRank(a.state) - stateRank(b.state) || Number(a.parked) - Number(b.parked) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

  // Which accounts are on the board: the CLI's login and every account the
  // desktop store has sessions for (the desktop app can be signed in to a
  // different account than the CLI).
  const desktopAccounts = new Map();
  for (const d of desktop) {
    if (d.archived) continue;
    const a = desktopAccounts.get(d.accountUuid) ?? { accountUuid: d.accountUuid, email: accountLabel(d.accountUuid), sessions: 0 };
    a.sessions++;
    desktopAccounts.set(d.accountUuid, a);
  }

  return {
    generatedAt: now,
    tmux: tmuxAvailable,
    accounts: { cli: cliAccount, desktop: [...desktopAccounts.values()] },
    rateLimits,
    knownDirs,
    sessions,
    // Parked sessions have no process: they cannot be stepping on anything.
    overlaps: findOverlaps(sessions.filter((s) => !s.parked && !s.sharedPane)),
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

// --- rate limits (statusline tap) ---------------------------------------------------------

/**
 * Where `agentfdr statusline-tap` records the plan usage Claude Code reports
 * to the status line: { [accountUuid]: { email, fiveHour, sevenDay, at, ... } }.
 */
export function rateLimitsFile() {
  return process.env.AGENTFDR_RATE_FILE ?? join(homedir(), '.agentfdr', 'rate-limits.json');
}

let rateCache = { mtimeMs: -1, value: {} };

export function readRateLimits(file = rateLimitsFile()) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return {};
  }
  if (rateCache.mtimeMs === st.mtimeMs) return rateCache.value;
  let value = {};
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    if (d && typeof d === 'object' && d.accounts && typeof d.accounts === 'object') value = d.accounts;
  } catch {
    value = {};
  }
  rateCache = { mtimeMs: st.mtimeMs, value };
  return value;
}

// --- launching sessions ------------------------------------------------------------------

/**
 * POSIX `cksum` CRC (poly 0x04C11DB7, length appended). The user's tmux
 * launcher names sessions `claude-<dir basename>-<cksum of the path>`; using
 * the same name means the session the board starts is the one their shell
 * wrapper attaches to for that directory.
 */
const CKSUM_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 24;
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
  CKSUM_TABLE[i] = c >>> 0;
}
export function cksum(str) {
  const bytes = Buffer.from(str, 'utf8');
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CKSUM_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  let len = bytes.length;
  while (len > 0) {
    crc = ((crc << 8) ^ CKSUM_TABLE[((crc >>> 24) ^ (len & 0xff)) & 0xff]) >>> 0;
    len >>>= 8;
  }
  return (~crc) >>> 0;
}

/** tmux session name for a directory, in the `claude-<slug>-<cksum>` convention. */
export function tmuxSessionName(dir) {
  // tmux forbids ':' and '.' in session names; everything else the wrapper
  // keeps as is (non-ASCII directory names included). Whitespace and shell
  // metacharacters are dropped so the name stays a single safe token.
  const slug = basename(dir).replace(/[.:]/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
  return `claude-${slug || 'dir'}-${cksum(dir)}`;
}

// Session names and pane targets: letters/digits of any script plus tmux's
// own punctuation. Deliberately an allowlist — these strings reach tmux argv.
const NAME_RE = /^[\p{L}\p{N}_.-]{1,80}$/u;
const TARGET_RE = /^[\p{L}\p{N}_.@%:-]+$/u;

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Validate a launch request and build the tmux invocation without running it.
 * Returns { name, dir, argv, command }. Throws with a user-facing message.
 * Only ever launches `claude` — the board is not a general shell.
 */
export function buildLaunch({ dir, prompt, model, resume, name } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('directory is required');
  const abs = resolvePath(dir.trim().replace(/^~(?=\/|$)/, homedir()));
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`no such directory: ${abs}`);
  }
  if (!st.isDirectory()) throw new Error(`not a directory: ${abs}`);
  const args = ['claude'];
  if (model != null && model !== '') {
    if (!/^[\w.:-]{1,64}$/.test(model)) throw new Error('model must be a plain model name');
    args.push('--model', shellQuote(model));
  }
  if (resume) args.push('--continue');
  if (prompt != null && prompt !== '') {
    if (typeof prompt !== 'string') throw new Error('prompt must be text');
    if (prompt.length > 20_000) throw new Error('prompt too long');
    // `claude update` runs the updater and `claude --foo` is a flag; a leading
    // space makes the argument a prompt no matter what it starts with
    // (verified: `claude ' --version'` starts a conversation, `claude '--version'`
    // prints the version). Claude Code trims it.
    args.push(shellQuote(' ' + prompt.replace(/\r\n?/g, '\n')));
  }
  if (name != null && !NAME_RE.test(name)) throw new Error('invalid session name');
  const sessionName = name ?? tmuxSessionName(abs);
  return { name: sessionName, dir: abs, command: args.join(' '), argv: ['new-session', '-d', '-s', sessionName, '-c', abs, args.join(' ')] };
}

/**
 * Start a new Claude Code session in a detached tmux session and wait (briefly)
 * for it to register itself. Returns { ok, name, dir, registered, pid, sessionId }.
 * `registered: false` usually means Claude Code is showing a first-run dialog
 * (workspace trust) in the pane and needs a keypress there.
 */
export async function launchSession(req, { run = tmux, waitMs = 8000, pollMs = 500, registry = () => readRegistry() } = {}) {
  let plan = buildLaunch(req);
  // A session for that directory already open? Start a second one under a
  // numbered name instead of failing — parallel work in one repo is the point.
  const existing = new Set((await run(['list-sessions', '-F', '#{session_name}']).catch(() => '')).split('\n').filter(Boolean));
  if (existing.has(plan.name)) {
    let n = 2;
    while (existing.has(`${plan.name}-${n}`)) n++;
    plan = buildLaunch({ ...req, name: `${plan.name}-${n}` });
  }
  await run(plan.argv);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const hit = registry().find((e) => e.alive && e.tmux && e.tmux.startsWith(plan.name + ':'));
    if (hit) return { ok: true, name: plan.name, dir: plan.dir, registered: true, pid: hit.pid, sessionId: hit.sessionId };
    await sleep(pollMs);
  }
  return { ok: true, name: plan.name, dir: plan.dir, registered: false, pid: null, sessionId: null };
}

// --- steering (tmux) ---------------------------------------------------------------------

/**
 * Only an interactive CLI process owns the pane it registered. `claude -p` /
 * SDK children started from that session inherit the same tmux target; typing
 * "into" them would land in the parent's prompt. When several registry
 * entries share a pane, the interactive `cli` one (oldest first) is steerable.
 */
export function isSteerable(entry, registry) {
  if (!entry.tmux || !entry.alive) return false;
  if (entry.entrypoint !== 'cli' || entry.kind !== 'interactive') return false;
  const owner = registry
    .filter((e) => e.alive && e.tmux === entry.tmux && e.entrypoint === 'cli' && e.kind === 'interactive')
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.pid - b.pid)[0];
  return owner?.pid === entry.pid;
}

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
  if (typeof target !== 'string' || !TARGET_RE.test(target)) throw new Error('session has no controllable tmux pane');
  if (action) {
    const keys = KEY_ACTIONS[action];
    if (!keys) throw new Error(`unknown action "${action}"`);
    return [['send-keys', '-t', target, ...keys]];
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('nothing to send');
  if (text.length > 20_000) throw new Error('message too long');
  // Newlines and tabs are text; other control characters (including ESC,
  // which could end a bracketed paste and turn the rest into keystrokes) are not.
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  if (clean.includes('\n')) {
    // Multi-line: paste it as one buffer (bracketed paste, so newlines do not
    // submit halfway), then press Enter separately. The buffer name is unique
    // per call so concurrent sends cannot paste each other's text.
    const buf = `agentfdr-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return [
      ['set-buffer', '-b', buf, '--', clean],
      ['paste-buffer', '-p', '-d', '-b', buf, '-t', target],
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
  if (!isSteerable(entry, registry)) throw new Error('this process shares its pane with another session (e.g. `claude -p` started from it) — steer the owning session instead');
  // A key press is only meaningful against the dialog/turn the user SAW. The
  // page sends what it displayed; if the registry moved on since (dialog A
  // answered, dialog B open), refuse rather than answer B with A's click.
  if (req.action && req.expect) {
    const e = req.expect;
    const same = (e.status ?? null) === (entry.status ?? null) &&
      (e.waitingFor ?? null) === (entry.waitingFor ?? null) &&
      (e.stateSince == null || Number(e.stateSince) === (entry.statusUpdatedAt ?? entry.updatedAt ?? null));
    if (!same) {
      const err = new Error('the session\'s state changed since the board was drawn — nothing was sent; look again');
      err.code = 'STATE_CHANGED';
      throw err;
    }
  }
  const cmds = buildSendCommands(entry.tmux, req);
  for (let i = 0; i < cmds.length; i++) {
    if (i > 0 && cmds[i][0] === 'send-keys' && cmds[i].at(-1) === 'Enter') await sleep(delayMs);
    await run(cmds[i]);
  }
  return { ok: true, target: entry.tmux, sent: req.action ?? 'text' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
