// Local viewer server. No framework, no websockets — the UI refetches on demand.
// Binds to 127.0.0.1 only: transcripts contain your code and your prompts.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { listProjects, resolveSession } from './discover.js';
import { parseSessionFile, probeTitle } from './parser.js';
import { detect } from './detect.js';

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ui.html');

export function startServer({ port = 4477, initialSession = null } = {}) {
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
        const url = `http://127.0.0.1:${attempt}/${initialSession ? `#${initialSession}` : ''}`;
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
      const model = parseSessionFile(file);
      const flags = detect(model);
      // Strip full tool inputs from the wire; the UI shows summaries + snippets.
      const turns = model.turns.map((t) => ({
        ...t,
        toolCalls: t.toolCalls.map(({ input, ...call }) => call),
      }));
      sendJson(res, 200, { ...model, turns, flags });
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
