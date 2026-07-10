// Local viewer server. No framework, no websockets — the UI refetches on demand.
// Binds to 127.0.0.1 only: transcripts contain your code and your prompts.

import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { listProjects, resolveSession } from './discover.js';
import { parseSessionFile, probeTitle } from './parser.js';
import { detect } from './detect.js';
import { estimateSessionCost } from './cost.js';
import { blameReport } from './report.js';
import { collectUsage } from './usage.js';
import { parseTokenCount } from './assert.js';
import { diffSessions } from './diff.js';

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ui.html');

// Parse results keyed by file, invalidated by (mtime, size). Live mode polls
// every couple of seconds; re-parsing a multi-MB transcript each poll when
// nothing changed would be wasteful.
const CACHE_MAX = 20;
const parseCache = new Map(); // file -> { mtimeMs, size, model, flags, cost }

function loadSession(file) {
  const st = statSync(file);
  const hit = parseCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    parseCache.delete(file); // refresh LRU position on hit too
    parseCache.set(file, hit);
    return hit;
  }
  const model = parseSessionFile(file);
  const flags = detect(model);
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

function loadForUsage(file) {
  const st = statSync(file);
  const hit = usageCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.lite;
  const model = parseSessionFile(file);
  const lite = {
    session: { model: model.session.model },
    turns: model.turns.map((t) => ({ timestamp: t.timestamp, model: t.model, usage: t.usage })),
  };
  usageCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, lite });
  return lite;
}

export function startServer({ port = 4477, initialSession = null, live = false } = {}) {
  const server = createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  });

  // If the requested port is taken (a previous viewer still running), walk up
  // to the next free one instead of dying with EADDRINUSE.
  return new Promise((resolvePromise, reject) => {
    let attempt = port;
    const tryListen = () => {
      server.listen(attempt, '127.0.0.1', () => {
        const qs = live ? '?live=1' : '';
        const url = `http://127.0.0.1:${attempt}/${qs}${initialSession ? `#${initialSession}` : ''}`;
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

  function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      // Read on every request so UI hacking needs no restart.
      res.end(readFileSync(UI_PATH, 'utf8'));
      return;
    }
    if (url.pathname === '/api/sessions') {
      const projects = listProjects().map((p) => ({
        slug: p.slug,
        sessions: p.sessions.slice(0, 20).map((s) => ({
          id: s.id,
          mtimeMs: s.mtimeMs,
          size: s.size,
          title: probeTitle(s.file),
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
      sendJson(res, 200, { ...model, turns, flags, cost, mtimeMs, sizeBytes: size });
      return;
    }
    if (url.pathname === '/api/usage') {
      const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 14));
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
