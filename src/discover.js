// Find Claude Code transcript files on disk. No configuration needed:
// ~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl
// Override the root with AGENTFDR_CLAUDE_DIR (useful for tests and forks).

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function projectsRoot() {
  return process.env.AGENTFDR_CLAUDE_DIR ?? join(homedir(), '.claude', 'projects');
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
  const all = listProjects(root).flatMap((p) => p.sessions.map((s) => ({ ...s, slug: p.slug })));
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
