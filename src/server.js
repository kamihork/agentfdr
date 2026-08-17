// Local viewer server. No framework, no websockets — the UI refetches on demand.
// Binds to 127.0.0.1 only: transcripts contain your code and your prompts.

import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { listAllProjects, resolveSession } from './discover.js';
import { probeTitle } from './parser.js';
import { parseAnySessionFile, probeCodexTitle } from './codex.js';
import { detect } from './detect.js';
import { estimateSessionCost } from './cost.js';
import { blameReport } from './report.js';
import { collectUsage } from './usage.js';
import { parseTokenCount } from './assert.js';
import { diffSessions } from './diff.js';
import { buildDocs, searchSessions } from './search.js';
import { buildSubagentTree, subagentTotals, subagentStamp } from './subagents.js';
import { collectBoard, sendToSession, tmuxAvailable, launchSession } from './board.js';

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ui.html');
const BOARD_PATH = join(dirname(fileURLToPath(import.meta.url)), 'board.html');

// Parse results keyed by file, invalidated by (mtime, size). Live mode polls
// every couple of seconds; re-parsing a multi-MB transcript each poll when
// nothing changed would be wasteful.
const CACHE_MAX = 20;
const parseCache = new Map(); // file -> { mtimeMs, size, model, flags, cost }
let serverConfig = { path: null }; // detector config, fixed for the server's lifetime

function loadSession(file) {
  const st = statSync(file);
  const hit = parseCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    parseCache.delete(file); // refresh LRU position on hit too
    parseCache.set(file, hit);
    return hit;
  }
  const model = parseAnySessionFile(file);
  const flags = detect(model, serverConfig);
  const cost = estimateSessionCost(model);
  const entry = { mtimeMs: st.mtimeMs, size: st.size, model, flags, cost };
  parseCache.delete(file); // refresh LRU position
  parseCache.set(file, entry);
  if (parseCache.size > CACHE_MAX) parseCache.delete(parseCache.keys().next().value);
  return entry;
}

// Usage aggregation touches EVERY session across all projects — routing that
// through the 20-entry parseCache would churn it completely and re-parse the
// world on each call. Keep a separate uncapped cache of just the tiny slice
// usage needs (per-turn timestamp/model/usage): a few KB per session.
const usageCache = new Map(); // file -> { mtimeMs, size, lite }

// Same idea for search: compact per-turn text docs, cached by (mtime, size).
const searchCache = new Map(); // file -> { mtimeMs, size, docs, title }

// Subagent transcripts are separate files; building the tree parses all of them
// (a workflow can leave dozens behind), so it is lazy and cached by a stamp
// over the main session AND every agent file.
const subagentCache = new Map(); // file -> { stamp, payload }

function loadDocsCached(file) {
  const st = statSync(file);
  const hit = searchCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const model = parseAnySessionFile(file);
  const entry = { mtimeMs: st.mtimeMs, size: st.size, docs: buildDocs(model), title: model.session.title };
  searchCache.set(file, entry);
  return entry;
}

function loadForUsage(file) {
  const st = statSync(file);
  const hit = usageCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.lite;
  const model = parseAnySessionFile(file);
  const lite = {
    session: { model: model.session.model },
    turns: model.turns.map((t) => ({ timestamp: t.timestamp, model: t.model, usage: t.usage })),
  };
  usageCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, lite });
  return lite;
}

export function startServer({ port = 4477, initialSession = null, live = false, config, page = '/' } = {}) {
  if (config) serverConfig = config;
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() => route(req, res))
      .catch((err) => sendJson(res, 500, { error: String(err?.message ?? err) }));
  });

  // If the requested port is taken (a previous viewer still running), walk up
  // to the next free one instead of dying with EADDRINUSE.
  return new Promise((resolvePromise, reject) => {
    let attempt = port;
    const tryListen = () => {
      server.listen(attempt, '127.0.0.1', () => {
        const qs = live ? '?live=1' : '';
        const url = `http://127.0.0.1:${attempt}${page}${qs}${initialSession ? `#${initialSession}` : ''}`;
        resolvePromise({ server, url, port: attempt });
      });
    };
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < port + 10) {
        attempt++;
        setImmediate(tryListen);
      } else {
        reject(err);
      }
    });
    tryListen();
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // Read on every request so UI hacking needs no restart.
      res.end(readFileSync(UI_PATH, 'utf8'));
      return;
    }
    if (url.pathname === '/board' || url.pathname === '/board/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(BOARD_PATH, 'utf8'));
      return;
    }
    if (url.pathname === '/api/board') {
      const board = collectBoard({ config: serverConfig, tmuxAvailable: await tmuxAvailable() });
      sendJson(res, 200, board);
      return;
    }
    if (url.pathname === '/api/board/send') {
      // This endpoint types into a live agent session. It only ever runs for
      // requests the board page itself made: POST + JSON body (a cross-origin
      // page can't send that without a preflight we never answer) AND a
      // same-origin fetch, so a stray tab can't drive your agents.
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' });
        return;
      }
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: 'cross-origin request refused' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await sendToSession(body.pid, { text: body.text, action: body.action });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: String(err?.message ?? err) });
      }
      return;
    }
    if (url.pathname === '/api/board/launch') {
      // Starts a NEW Claude Code session (detached tmux). Same guards as send:
      // POST, JSON, same-origin, loopback host.
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' });
        return;
      }
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: 'cross-origin request refused' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await launchSession({ dir: body.dir, prompt: body.prompt, model: body.model, resume: Boolean(body.resume) });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: String(err?.message ?? err) });
      }
      return;
    }
    if (url.pathname === '/api/sessions') {
      const projects = listAllProjects().map((p) => ({
        slug: p.slug,
        agent: p.agent,
        sessions: p.sessions.slice(0, 20).map((s) => ({
          id: s.id,
          mtimeMs: s.mtimeMs,
          size: s.size,
          title: p.agent === 'codex' ? probeCodexTitle(s.file) : probeTitle(s.file),
        })),
      }));
      sendJson(res, 200, { projects });
      return;
    }
    if (url.pathname === '/api/session') {
      const ref = url.searchParams.get('id');
      const { file } = resolveSession(ref || undefined);
      // Cheap freshness probe for live mode. Compare BOTH mtime and size —
      // coarse-mtime filesystems can absorb an append into the same timestamp,
      // and an mtime-only probe would then hide the session's final turns.
      const since = url.searchParams.get('since');
      const sz = url.searchParams.get('sz');
      const st = statSync(file);
      if (since && Number(since) === st.mtimeMs && sz != null && Number(sz) === st.size) {
        sendJson(res, 200, { unchanged: true, mtimeMs: st.mtimeMs });
        return;
      }
      const { model, flags, cost, mtimeMs, size } = loadSession(file);
      // Strip full tool inputs from the wire; the UI shows summaries + snippets.
      const turns = model.turns.map((t) => ({
        ...t,
        toolCalls: t.toolCalls.map(({ input, ...call }) => call),
      }));
      sendJson(res, 200, { ...model, turns, flags, cost, mtimeMs, sizeBytes: size, configPath: serverConfig.path });
      return;
    }
    if (url.pathname === '/api/subagents') {
      const ref = url.searchParams.get('id');
      const { file } = resolveSession(ref || undefined);
      const st = statSync(file);
      const stamp = `${st.mtimeMs}-${st.size}|${subagentStamp(file)}`;
      const hit = subagentCache.get(file);
      if (hit?.stamp === stamp) {
        sendJson(res, 200, hit.payload);
        return;
      }
      const { model } = loadSession(file);
      const agents = buildSubagentTree(model, file, serverConfig);
      const payload = { agents, totals: subagentTotals(agents) };
      subagentCache.set(file, { stamp, payload });
      if (subagentCache.size > CACHE_MAX) subagentCache.delete(subagentCache.keys().next().value);
      sendJson(res, 200, payload);
      return;
    }
    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length < 2) {
        sendJson(res, 400, { error: 'query must be at least 2 characters' });
        return;
      }
      sendJson(res, 200, { query: q, results: searchSessions(q, { loadDocs: loadDocsCached }) });
      return;
    }
    if (url.pathname === '/api/usage') {
      const days = Math.min(371, Math.max(1, Number(url.searchParams.get('days')) || 14));
      const usage = collectUsage({ days, loadModel: loadForUsage });
      usage.budgets = {
        fiveHour: parseTokenCount(process.env.AGENTFDR_BUDGET_5H) ?? null,
        week: parseTokenCount(process.env.AGENTFDR_BUDGET_WEEK) ?? null,
      };
      sendJson(res, 200, usage);
      return;
    }
    if (url.pathname === '/api/diff') {
      const refA = url.searchParams.get('a');
      const refB = url.searchParams.get('b');
      if (!refA || !refB) {
        sendJson(res, 400, { error: 'diff needs ?a=<session>&b=<session>' });
        return;
      }
      const load = (ref) => {
        const { model, flags } = loadSession(resolveSession(ref).file);
        return { model, flags };
      };
      sendJson(res, 200, diffSessions(load(refA), load(refB)));
      return;
    }
    if (url.pathname === '/api/blame') {
      const ref = url.searchParams.get('id');
      const lang = url.searchParams.get('lang') === 'ja' ? 'ja' : 'en';
      const { file } = resolveSession(ref || undefined);
      const { model, flags } = loadSession(file);
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(blameReport(model, flags, lang));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  }
}

/**
 * A request counts as same-origin when the browser says so. Sec-Fetch-Site is
 * authoritative when present; otherwise the Origin header must match the Host
 * we are bound to; a request with neither is not from a modern browser page.
 */
export function isSameOrigin(req) {
  // Host must be loopback FIRST: under DNS rebinding a page from evil.example
  // resolves to 127.0.0.1 and the browser sends Sec-Fetch-Site: same-origin
  // in good faith — the Host header still says evil.example, which we refuse.
  const host = req.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) {
      reject(new Error('expected application/json'));
      return;
    }
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Fine — the URL is printed either way.
  }
}
