// Full-text search across every recorded session — "which session did I do
// that in?" answered without grepping JSONL by hand.
//
// No index database: sessions are parsed once into compact per-turn docs and
// cached by (mtime, size) by the caller. Case-insensitive substring match.

import { listProjects } from './discover.js';
import { parseSessionFile } from './parser.js';

const DOC_TEXT_CAP = 4000; // per-entry cap keeps the doc cache small
const PER_SESSION_CAP = 5;
const SESSION_CAP = 50;

/** Flatten a parsed session into searchable entries: { t: turn, w: kind, s: text }. */
export function buildDocs(model) {
  const docs = [];
  for (const p of model.prompts) {
    const t = Math.max(0, Math.min(model.turns.length - 1, (p.afterTurn ?? -1) + 1));
    docs.push({ t, w: 'prompt', s: p.text });
  }
  for (const turn of model.turns) {
    if (turn.text) docs.push({ t: turn.index, w: 'assistant', s: turn.text.slice(0, DOC_TEXT_CAP) });
    for (const c of turn.toolCalls) {
      if (c.summary) docs.push({ t: turn.index, w: 'tool', s: c.name + ' ' + c.summary });
      if (c.result?.snippet) docs.push({ t: turn.index, w: 'result', s: c.result.snippet });
    }
  }
  return docs;
}

/** Matches within one session's docs, capped, with a highlightable excerpt. */
export function searchDocs(docs, query, cap = PER_SESSION_CAP) {
  const q = query.toLowerCase();
  const out = [];
  for (const d of docs) {
    const idx = d.s.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    out.push({ t: d.t, w: d.w, excerpt: excerpt(d.s, idx, query.length) });
    if (out.length >= cap) break;
  }
  return out;
}

function excerpt(s, idx, len) {
  const start = Math.max(0, idx - 60);
  const end = Math.min(s.length, idx + len + 60);
  return (
    (start > 0 ? '…' : '') +
    s.slice(start, end).replace(/\s+/g, ' ').trim() +
    (end < s.length ? '…' : '')
  );
}

/**
 * Search every session, newest first. loadDocs(file) -> { docs, title } lets
 * the server plug in its mtime-validated cache; the CLI parses one-shot.
 */
export function searchSessions(query, { root, loadDocs } = {}) {
  const load = loadDocs ?? ((file) => {
    const model = parseSessionFile(file);
    return { docs: buildDocs(model), title: model.session.title };
  });
  const results = [];
  const sessions = listProjects(root)
    .flatMap((p) => p.sessions.map((s) => ({ ...s, slug: p.slug })))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const s of sessions) {
    let entry;
    try {
      entry = load(s.file);
    } catch {
      continue;
    }
    const matches = searchDocs(entry.docs, query);
    if (matches.length) {
      results.push({ id: s.id, slug: s.slug, title: entry.title, mtimeMs: s.mtimeMs, matches });
      if (results.length >= SESSION_CAP) break;
    }
  }
  return results;
}
