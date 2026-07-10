// Failure-pattern detectors. Each takes the parsed session model and returns
// flags: { type, severity: 'critical'|'warning', title, detail, turnStart, turnEnd }.
//
// These are deliberately simple heuristics. They exist to answer "where should
// I look first?", not to be a verdict — the timeline is the evidence.

import { toolSignature } from './parser.js';

export function detect(model) {
  const flags = [
    ...detectToolLoops(model),
    ...detectErrorStreaks(model),
    ...detectContextBloat(model),
    ...detectTokenSpikes(model),
    ...detectCacheThrash(model),
    ...detectFileChurn(model),
    ...detectRefusals(model),
  ];
  const order = { critical: 0, warning: 1 };
  flags.sort((a, b) => order[a.severity] - order[b.severity] || a.turnStart - b.turnStart);
  return flags;
}

/** Flattened (turnIndex, call) sequence in execution order. */
function callSequence(model) {
  const seq = [];
  for (const turn of model.turns) {
    for (const call of turn.toolCalls) seq.push({ turn: turn.index, call, sig: toolSignature(call) });
  }
  return seq;
}

/**
 * Loop: the same n-gram of tool signatures repeated >= 3 times consecutively
 * (n = 1..4), covering at least 6 calls. Reports the longest span at each
 * start position, skipping spans contained in an already-reported one.
 */
export function detectToolLoops(model) {
  const seq = callSequence(model);
  const flags = [];
  const covered = new Set();

  for (let n = 4; n >= 1; n--) {
    for (let i = 0; i + 2 * n <= seq.length; i++) {
      let repeats = 1;
      while (
        i + (repeats + 1) * n <= seq.length &&
        sameGram(seq, i, i + repeats * n, n)
      ) {
        repeats++;
      }
      const span = repeats * n;
      if (repeats >= 3 && span >= 6) {
        const already = [...Array(span).keys()].every((k) => covered.has(i + k));
        if (!already) {
          for (let k = 0; k < span; k++) covered.add(i + k);
          const gram = seq.slice(i, i + n).map((s) => s.sig).join(' → ');
          flags.push({
            type: 'loop',
            severity: 'critical',
            title: `Tool loop ×${repeats}`,
            detail: `Repeated ${repeats}× (${span} calls): ${gram}`,
            params: { repeats, span, gram },
            turnStart: seq[i].turn,
            turnEnd: seq[i + span - 1].turn,
          });
        }
        i += span - 1;
      }
    }
  }
  flags.sort((a, b) => a.turnStart - b.turnStart);
  return flags;
}

function sameGram(seq, a, b, n) {
  for (let k = 0; k < n; k++) {
    if (seq[a + k].sig !== seq[b + k].sig) return false;
  }
  return true;
}

/** 3+ consecutive tool results that are errors. */
export function detectErrorStreaks(model) {
  const seq = callSequence(model).filter((s) => s.call.result);
  const flags = [];
  let start = -1;
  for (let i = 0; i <= seq.length; i++) {
    const isErr = i < seq.length && seq[i].call.result.isError;
    if (isErr && start === -1) start = i;
    if (!isErr && start !== -1) {
      const len = i - start;
      if (len >= 3) {
        flags.push({
          type: 'error-streak',
          severity: 'critical',
          title: `${len} consecutive tool errors`,
          detail: `Starting with ${seq[start].sig}`,
          params: { count: len, firstSig: seq[start].sig },
          turnStart: seq[start].turn,
          turnEnd: seq[i - 1].turn,
        });
      }
      start = -1;
    }
  }
  return flags;
}

const BLOAT_CHARS = 50_000;

/** A single tool result large enough to crowd the context window. */
export function detectContextBloat(model) {
  const flags = [];
  for (const turn of model.turns) {
    for (const call of turn.toolCalls) {
      if ((call.result?.chars ?? 0) >= BLOAT_CHARS) {
        flags.push({
          type: 'context-bloat',
          severity: 'warning',
          title: `Huge tool result (${Math.round(call.result.chars / 1000)}k chars)`,
          detail: `${call.name}: ${call.summary}`,
          params: { kchars: Math.round(call.result.chars / 1000), name: call.name, summary: call.summary },
          turnStart: turn.index,
          turnEnd: turn.index,
        });
      }
    }
  }
  return flags.slice(0, 10);
}

/** Context tokens jumped by >60% and >50k between consecutive turns. */
export function detectTokenSpikes(model) {
  const flags = [];
  const main = model.turns.filter((t) => !t.isSidechain);
  for (let i = 1; i < main.length; i++) {
    const prev = main[i - 1].contextTokens;
    const cur = main[i].contextTokens;
    if (prev > 0 && cur - prev > 50_000 && cur > prev * 1.6) {
      flags.push({
        type: 'token-spike',
        severity: 'warning',
        title: `Context jumped +${Math.round((cur - prev) / 1000)}k tokens`,
        detail: `${Math.round(prev / 1000)}k → ${Math.round(cur / 1000)}k in one turn`,
        params: { fromK: Math.round(prev / 1000), toK: Math.round(cur / 1000), deltaK: Math.round((cur - prev) / 1000) },
        turnStart: main[i].index,
        turnEnd: main[i].index,
      });
    }
  }
  return flags;
}

/** 2+ consecutive non-trivial turns paying full input price (no cache hits). */
export function detectCacheThrash(model) {
  const flags = [];
  const main = model.turns.filter((t) => !t.isSidechain);
  let start = -1;
  for (let i = 0; i <= main.length; i++) {
    const t = main[i];
    const miss = t && i > 2 && t.usage.cacheRead === 0 && t.usage.input + t.usage.cacheCreation > 20_000;
    if (miss && start === -1) start = i;
    if (!miss && start !== -1) {
      if (i - start >= 2) {
        flags.push({
          type: 'cache-thrash',
          severity: 'warning',
          title: `${i - start} turns with zero cache hits`,
          detail: 'Full input re-read each turn — check for context churn',
          params: { count: i - start },
          turnStart: main[start].index,
          turnEnd: main[i - 1].index,
        });
      }
      start = -1;
    }
  }
  return flags;
}

/** A safety classifier or the model itself declined: stop_reason "refusal". */
export function detectRefusals(model) {
  return model.turns
    .filter((t) => t.stopReason === 'refusal')
    .map((t) => ({
      type: 'refusal',
      severity: 'critical',
      title: 'Model refusal',
      detail: 'stop_reason: refusal — the request was declined',
      params: {},
      turnStart: t.index,
      turnEnd: t.index,
    }));
}

/** The same file edited 6+ times — usually an edit/test/edit spiral. */
export function detectFileChurn(model) {
  const counts = new Map(); // path -> { n, first, last }
  for (const turn of model.turns) {
    for (const call of turn.toolCalls) {
      if (!['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(call.name)) continue;
      const path = call.input?.file_path ?? call.input?.notebook_path;
      if (typeof path !== 'string') continue;
      const c = counts.get(path) ?? { n: 0, first: turn.index, last: turn.index };
      c.n++;
      c.last = turn.index;
      counts.set(path, c);
    }
  }
  const flags = [];
  for (const [path, c] of counts) {
    if (c.n >= 6) {
      flags.push({
        type: 'file-churn',
        severity: 'warning',
        title: `Same file edited ${c.n}×`,
        detail: path,
        params: { count: c.n, path },
        turnStart: c.first,
        turnEnd: c.last,
      });
    }
  }
  return flags;
}
