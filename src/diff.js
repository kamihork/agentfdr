// Session diff — compare a failed attempt with the successful retry.
//
// Answers three questions:
//   1. How different was the outcome?   (stats: errors, tokens, cost, anomalies)
//   2. Where did the behavior diverge?  (anomaly flags, tool mix)
//   3. Did they touch the same code?    (edited files: both / only A / only B)

import { estimateSessionCost } from './cost.js';

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const FILE_LIST_CAP = 20;
const TOOL_LIST_CAP = 12;

function sessionSummary(model, flags) {
  return {
    id: model.session.id,
    title: model.session.title,
    startedAt: model.session.startedAt,
    models: model.session.models ?? [],
    stats: {
      turns: model.totals.turns,
      prompts: model.prompts.length,
      toolCalls: model.totals.toolCalls,
      toolErrors: model.totals.toolErrors,
      wallMs: model.totals.wallMs,
      outputTokens: model.totals.tokens.output,
      billedTokens:
        model.totals.tokens.input + model.totals.tokens.cacheCreation + model.totals.tokens.output,
      contextPeak: Math.max(0, ...model.turns.map((t) => t.contextTokens)),
      estUsd: estimateSessionCost(model).usd,
      compactions: model.totals.compactions,
      anomalies: flags.length,
      critical: flags.filter((f) => f.severity === 'critical').length,
    },
  };
}

function flagCounts(flags) {
  const counts = new Map();
  for (const f of flags) counts.set(f.type, (counts.get(f.type) ?? 0) + 1);
  return counts;
}

function toolCounts(model) {
  const counts = new Map();
  for (const t of model.turns) {
    for (const c of t.toolCalls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  }
  return counts;
}

function editedFiles(model) {
  const files = new Set();
  const cwd = model.session.cwd;
  for (const t of model.turns) {
    for (const c of t.toolCalls) {
      if (!EDIT_TOOLS.includes(c.name)) continue;
      let p = c.input?.file_path ?? c.input?.notebook_path ?? c.summary;
      if (typeof p !== 'string' || !p) continue;
      if (cwd && p.startsWith(cwd + '/')) p = p.slice(cwd.length + 1);
      files.add(p);
    }
  }
  return files;
}

/**
 * a, b: { model, flags } (parsed session + detector output).
 * Returns a language-neutral structure; CLI and viewer render it.
 */
export function diffSessions(a, b) {
  const fa = flagCounts(a.flags);
  const fb = flagCounts(b.flags);
  const flagTypes = [...new Set([...fa.keys(), ...fb.keys()])].sort();

  const ta = toolCounts(a.model);
  const tb = toolCounts(b.model);
  const tools = [...new Set([...ta.keys(), ...tb.keys()])]
    .map((name) => ({ name, a: ta.get(name) ?? 0, b: tb.get(name) ?? 0 }))
    .sort((x, y) => y.a + y.b - (x.a + x.b))
    .slice(0, TOOL_LIST_CAP);

  const ea = editedFiles(a.model);
  const eb = editedFiles(b.model);
  const both = [...ea].filter((f) => eb.has(f)).sort();
  const onlyA = [...ea].filter((f) => !eb.has(f)).sort();
  const onlyB = [...eb].filter((f) => !ea.has(f)).sort();

  return {
    a: sessionSummary(a.model, a.flags),
    b: sessionSummary(b.model, b.flags),
    flags: flagTypes.map((type) => ({ type, a: fa.get(type) ?? 0, b: fb.get(type) ?? 0 })),
    tools,
    files: {
      both: both.slice(0, FILE_LIST_CAP),
      onlyA: onlyA.slice(0, FILE_LIST_CAP),
      onlyB: onlyB.slice(0, FILE_LIST_CAP),
      truncated: {
        both: Math.max(0, both.length - FILE_LIST_CAP),
        onlyA: Math.max(0, onlyA.length - FILE_LIST_CAP),
        onlyB: Math.max(0, onlyB.length - FILE_LIST_CAP),
      },
    },
  };
}
