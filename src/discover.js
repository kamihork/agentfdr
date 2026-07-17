// Find agent transcript files on disk. No configuration needed:
//   Claude Code: ~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl
//   Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-<date>-<uuid>.jsonl
// Override the roots with AGENTFDR_CLAUDE_DIR / AGENTFDR_CODEX_DIR
// (useful for tests and forks).

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function projectsRoot() {
  return process.env.AGENTFDR_CLAUDE_DIR ?? join(homedir(), '.claude', 'projects');
}

export function codexRoot() {
  return process.env.AGENTFDR_CODEX_DIR ?? join(homedir(), '.codex', 'sessions');
}

const ROLLOUT_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Codex sessions as one project-shaped group ({ slug: 'codex', agent: 'codex' }), or null. */
export function listCodexSessions(root = codexRoot()) {
  if (!existsSync(root)) return null;
  const sessions = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(p, depth + 1); // YYYY/MM/DD nesting
      } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          const st = statSync(p);
          const id = ROLLOUT_ID_RE.exec(e.name)?.[1] ?? e.name.slice(0, -6);
          sessions.push({ id, file: p, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // race with deletion; skip
        }
      }
    }
  };
  walk(root, 0);
  if (!sessions.length) return null;
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { slug: 'codex', path: root, sessions, agent: 'codex' };
}

/** Claude projects plus the Codex group, newest first. */
export function listAllProjects({ claudeRoot = projectsRoot(), codexDir = codexRoot() } = {}) {
  const projects = listProjects(claudeRoot).map((p) => ({ ...p, agent: 'claude' }));
  const codex = listCodexSessions(codexDir);
  if (codex) projects.push(codex);
  projects.sort((a, b) => b.sessions[0].mtimeMs - a.sessions[0].mtimeMs);
  return projects;
}

/** [{ slug, path, sessions: [{ id, file, mtimeMs, size }] }], newest session first. */
export function listProjects(root = projectsRoot()) {
  if (!existsSync(root)) return [];
  const projects = [];
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // not a directory / unreadable
    }
    const sessions = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(dir, name);
      try {
        const st = statSync(file);
        sessions.push({ id: name.slice(0, -6), file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // race with deletion; skip
      }
    }
    if (sessions.length) {
      sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
      projects.push({ slug, path: dir, sessions });
    }
  }
  projects.sort((a, b) => b.sessions[0].mtimeMs - a.sessions[0].mtimeMs);
  return projects;
}

/**
 * Resolve a user-supplied session reference to a transcript file:
 * a direct path to a .jsonl, a full session id, or an id prefix.
 * Returns { file, id } or throws with a helpful message.
 */
export function resolveSession(ref, root = projectsRoot()) {
  if (ref && ref.endsWith('.jsonl')) {
    const p = resolve(ref);
    if (existsSync(p)) return { file: p, id: p.replace(/^.*\//, '').slice(0, -6) };
    throw new Error(`No such file: ${ref}`);
  }
  const all = listAllProjects({ claudeRoot: root })
    .flatMap((p) => p.sessions.map((s) => ({ ...s, slug: p.slug })));
  if (!ref) {
    if (!all.length) throw new Error(`No sessions found under ${root}`);
    const newest = all.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    return { file: newest.file, id: newest.id };
  }
  const matches = all.filter((s) => s.id.startsWith(ref));
  if (matches.length === 1) return { file: matches[0].file, id: matches[0].id };
  if (matches.length === 0) throw new Error(`No session matches "${ref}". Try \`agentfdr list\`.`);
  throw new Error(
    `"${ref}" is ambiguous (${matches.length} matches):\n` +
      matches.slice(0, 8).map((m) => `  ${m.id}  (${m.slug})`).join('\n')
  );
}
