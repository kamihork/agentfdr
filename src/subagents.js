// Subagent (sidechain) discovery and tree building.
//
// Claude Code records subagent work in two different shapes depending on the
// version, and both must keep working:
//
//   1. Separate files, current:
//        ~/.claude/projects/<slug>/<session-id>.jsonl          the main session
//        ~/.claude/projects/<slug>/<session-id>/subagents/
//            agent-<id>.jsonl        the subagent's own transcript
//            agent-<id>.meta.json    { agentType, description, toolUseId, spawnDepth }
//            workflows/<wf-id>/agent-<id>.jsonl   agents belonging to one workflow
//      `toolUseId` is the id of the tool call that spawned the agent, which is
//      what lets a subagent be attached to the exact turn it came from — in the
//      main session, or in ANOTHER subagent when agents spawn agents.
//
//   2. Inline, older transcripts: sidechain turns live in the main file, marked
//      isSidechain. There is no spawn id there, so a run of them is attributed
//      to the turn that precedes it.
//
// Nothing here throws on a missing/# unreadable directory: a session with no
// subagents is the normal case, not an error.

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseSessionFile } from './parser.js';
import { detect } from './detect.js';

/** `<dir>/<id>.jsonl` -> `<dir>/<id>/subagents`, or null for non-transcript paths. */
export function subagentsDir(sessionFile) {
  return sessionFile?.endsWith('.jsonl') ? join(sessionFile.slice(0, -6), 'subagents') : null;
}

/** [{ file, workflow }] for every agent transcript under a session, recursively. */
export function listSubagentFiles(sessionFile) {
  const root = subagentsDir(sessionFile);
  if (!root || !existsSync(root)) return [];
  const out = [];
  const walk = (dir, workflow, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable: report the agents we can see, not an error
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      // Only wf_* directories name a workflow; `workflows/` is just a container.
      if (e.isDirectory()) {
        if (depth < 6) walk(p, /^wf_/.test(e.name) ? e.name : workflow, depth + 1);
      } else if (e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) {
        out.push({ file: p, workflow });
      }
    }
  };
  walk(root, null, 0);
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

function readMeta(file) {
  try {
    const raw = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {}; // meta is a convenience, not a requirement
  }
}

const billed = (tk) => tk.input + tk.cacheCreation + tk.output;

/** The stat line shown for one agent — the same numbers the session header shows. */
function summarize(model, flags) {
  const t = model.totals;
  return {
    turns: t.turns,
    toolCalls: t.toolCalls,
    toolErrors: t.toolErrors,
    billedTokens: billed(t.tokens),
    wallMs: t.wallMs,
    model: model.session.models?.[0]?.model ?? model.session.model ?? null,
    critical: flags.filter((f) => f.severity === 'critical').length,
    warnings: flags.filter((f) => f.severity !== 'critical').length,
  };
}

/** First non-empty line of the agent's opening prompt — its de-facto title. */
function describe(model) {
  const text = model.prompts[0]?.text ?? '';
  const line = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return line.length > 120 ? line.slice(0, 120) + '…' : line;
}

/**
 * The subagent forest for a session, flat, each node carrying who it hangs off:
 *   { id, type, description, workflow, depth, turn, parentId, file, summary }
 * `turn` is the main-session turn the work descends from (null when it can't be
 * placed); `parentId` is another node's id when an agent spawned an agent. The
 * viewer nests by parentId and groups by workflow; the flat list keeps the
 * wire format and the CLI simple.
 *
 * Attribution is by spawn id where the transcript records one, and by
 * timestamp otherwise (the last main turn that had started when the agent
 * began) — a placement, not a guess at causality.
 */
export function buildSubagentTree(model, sessionFile, config = {}) {
  const files = listSubagentFiles(sessionFile);
  if (!files.length) return inlineSidechains(model);

  const nodes = [];
  for (const { file, workflow } of files) {
    let sub;
    try {
      sub = parseSessionFile(file);
    } catch {
      continue; // a transcript we can't read shouldn't take the tree down
    }
    if (!sub.turns.length && !sub.prompts.length) continue;
    const meta = readMeta(file);
    nodes.push({
      id: meta.agentId ?? basename(file).replace(/^agent-/, '').replace(/\.jsonl$/, ''),
      type: meta.agentType ?? 'subagent',
      description: meta.description || describe(sub),
      workflow: workflow ?? null,
      depth: meta.spawnDepth ?? 1,
      spawnId: meta.toolUseId ?? null,
      startedAt: sub.session.startedAt,
      file,
      turn: null,
      parentId: null,
      summary: summarize(sub, detect(sub, config)),
      calls: sub.turns.flatMap((t) => t.toolCalls.map((c) => c.id).filter(Boolean)),
    });
  }

  // Where did each spawn id come from: a main-session turn, or another agent?
  const turnOfCall = new Map();
  for (const t of model.turns) {
    for (const c of t.toolCalls) if (c.id) turnOfCall.set(c.id, t.index);
  }
  const agentOfCall = new Map();
  for (const n of nodes) for (const id of n.calls) agentOfCall.set(id, n.id);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.spawnId != null && turnOfCall.has(n.spawnId)) {
      n.turn = turnOfCall.get(n.spawnId);
    } else if (n.spawnId != null && agentOfCall.has(n.spawnId) && agentOfCall.get(n.spawnId) !== n.id) {
      n.parentId = agentOfCall.get(n.spawnId);
    } else {
      n.turn = turnAt(model, n.startedAt);
    }
    delete n.calls; // internal, not worth the wire
  }
  // A nested agent shows up under the turn its whole branch came from.
  for (const n of nodes) {
    let hop = 0;
    let p = n.parentId ? byId.get(n.parentId) : null;
    while (p && n.turn == null && hop++ < 8) {
      n.turn = p.turn;
      p = p.parentId ? byId.get(p.parentId) : null;
    }
  }

  nodes.sort((a, b) => (a.turn ?? Infinity) - (b.turn ?? Infinity) || String(a.startedAt).localeCompare(String(b.startedAt)));
  return nodes;
}

/** The last main-thread turn that had started by `ts`. */
function turnAt(model, ts) {
  if (!ts) return null;
  let best = null;
  for (const t of model.turns) {
    if (t.isSidechain || !t.timestamp) continue;
    if (t.timestamp <= ts) best = t.index;
    else break;
  }
  return best;
}

const AGENT_TOOL_RE = /^(Task|Agent|Workflow)$/;

/**
 * Older transcripts: sidechain turns sit inline in the main session. One node
 * per consecutive run, attributed to the agent-spawning call that precedes it
 * (or just to the preceding turn). `inline: true` marks that the turns are
 * already on the main timeline rather than in a file of their own.
 */
function inlineSidechains(model) {
  const nodes = [];
  let run = null;
  let lastSpawn = null; // { turn, description }
  for (const t of model.turns) {
    if (!t.isSidechain) {
      if (run) {
        nodes.push(run);
        run = null;
      }
      const spawn = t.toolCalls.find((c) => AGENT_TOOL_RE.test(c.name));
      if (spawn) lastSpawn = { turn: t.index, description: spawn.summary ?? '' };
      else lastSpawn = { turn: t.index, description: '' };
      continue;
    }
    if (!run) {
      run = {
        id: 'inline-' + t.index,
        type: 'sidechain',
        description: lastSpawn?.description ?? '',
        workflow: null,
        depth: 1,
        spawnId: null,
        startedAt: t.timestamp,
        file: null,
        inline: true,
        turn: lastSpawn?.turn ?? null,
        turnStart: t.index,
        turnEnd: t.index,
        parentId: null,
        summary: { turns: 0, toolCalls: 0, toolErrors: 0, billedTokens: 0, wallMs: null, model: t.model, critical: 0, warnings: 0 },
      };
    }
    run.turnEnd = t.index;
    run.summary.turns++;
    run.summary.toolCalls += t.toolCalls.length;
    run.summary.toolErrors += t.toolCalls.filter((c) => c.result?.isError).length;
    run.summary.billedTokens += billed(t.usage);
  }
  if (run) nodes.push(run);
  return nodes;
}

/** Rolled-up numbers for the whole forest, for a one-line header. */
export function subagentTotals(nodes) {
  return nodes.reduce(
    (a, n) => ({
      agents: a.agents + 1,
      turns: a.turns + n.summary.turns,
      toolCalls: a.toolCalls + n.summary.toolCalls,
      toolErrors: a.toolErrors + n.summary.toolErrors,
      billedTokens: a.billedTokens + n.summary.billedTokens,
      critical: a.critical + n.summary.critical,
      warnings: a.warnings + n.summary.warnings,
      workflows: a.workflows,
    }),
    { agents: 0, turns: 0, toolCalls: 0, toolErrors: 0, billedTokens: 0, critical: 0, warnings: 0,
      workflows: new Set(nodes.map((n) => n.workflow).filter(Boolean)).size }
  );
}

/** Cheap change probe so callers can cache a parsed tree (files are immutable once written). */
export function subagentStamp(sessionFile) {
  const files = listSubagentFiles(sessionFile);
  let stamp = files.length + ':';
  for (const { file } of files) {
    try {
      const st = statSync(file);
      stamp += `${st.size}-${st.mtimeMs};`;
    } catch {
      stamp += 'x;';
    }
  }
  return stamp;
}
