// Failure-pattern detectors. Each takes the parsed session model and returns
// flags: { type, severity: 'critical'|'warning', title, detail, turnStart, turnEnd }.
//
// These are deliberately simple heuristics. They exist to answer "where should
// I look first?", not to be a verdict — the timeline is the evidence.
// Thresholds, suppressions and custom rules come from .agentfdr.json (config.js).

import { toolSignature } from './parser.js';
import { DEFAULT_THRESHOLDS } from './config.js';

export function detect(model, config = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...(config.thresholds ?? {}) };
  const disabled = new Set(config.disable ?? []);
  const detectors = [
    ['loop', () => detectToolLoops(model, th, config.suppressLoops ?? [])],
    ['error-streak', () => detectErrorStreaks(model, th)],
    ['context-bloat', () => detectContextBloat(model, th)],
    ['token-spike', () => detectTokenSpikes(model, th)],
    ['cache-thrash', () => detectCacheThrash(model, th)],
    ['file-churn', () => detectFileChurn(model, th)],
    ['refusal', () => detectRefusals(model)],
    ['stalled-call', () => detectStalledCalls(model)],
    ['api-error', () => detectApiErrors(model)],
  ];

  const flags = [];
  for (const [type, run] of detectors) {
    if (!disabled.has(type)) flags.push(...run());
  }
  flags.push(...detectCustom(model, config.custom ?? []));

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

/** "Bash:npm test" matches exactly; "Edit:*" matches by prefix. */
function isSuppressed(sig, patterns) {
  return patterns.some((p) => (p.endsWith('*') ? sig.startsWith(p.slice(0, -1)) : sig === p));
}

/**
 * Loop: the same n-gram of tool signatures repeated >= loopRepeats times
 * consecutively (n = 1..4), covering at least loopMinCalls calls. A loop whose
 * signatures are ALL suppressed (legitimate retries etc.) is not flagged.
 */
export function detectToolLoops(model, th = DEFAULT_THRESHOLDS, suppress = []) {
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
      if (repeats >= th.loopRepeats && span >= th.loopMinCalls) {
        const gramSigs = seq.slice(i, i + n).map((s) => s.sig);
        const already = [...Array(span).keys()].every((k) => covered.has(i + k));
        const legit = gramSigs.every((sig) => isSuppressed(sig, suppress));
        if (!already && !legit) {
          for (let k = 0; k < span; k++) covered.add(i + k);
          const gram = gramSigs.join(' → ');
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

/** errorStreak+ consecutive tool results that are errors. */
export function detectErrorStreaks(model, th = DEFAULT_THRESHOLDS) {
  const seq = callSequence(model).filter((s) => s.call.result);
  const flags = [];
  let start = -1;
  for (let i = 0; i <= seq.length; i++) {
    const isErr = i < seq.length && seq[i].call.result.isError;
    if (isErr && start === -1) start = i;
    if (!isErr && start !== -1) {
      const len = i - start;
      if (len >= th.errorStreak) {
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

/** A single tool result large enough to crowd the context window. */
export function detectContextBloat(model, th = DEFAULT_THRESHOLDS) {
  const flags = [];
  for (const turn of model.turns) {
    for (const call of turn.toolCalls) {
      if ((call.result?.chars ?? 0) >= th.contextBloatChars) {
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

/** Context tokens jumped by more than ratio × previous and spike tokens between turns. */
export function detectTokenSpikes(model, th = DEFAULT_THRESHOLDS) {
  const flags = [];
  const main = model.turns.filter((t) => !t.isSidechain);
  for (let i = 1; i < main.length; i++) {
    const prev = main[i - 1].contextTokens;
    const cur = main[i].contextTokens;
    if (prev > 0 && cur - prev > th.tokenSpikeTokens && cur > prev * th.tokenSpikeRatio) {
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

/** cacheThrashTurns+ consecutive non-trivial turns paying full input price (no cache hits). */
export function detectCacheThrash(model, th = DEFAULT_THRESHOLDS) {
  const flags = [];
  const main = model.turns.filter((t) => !t.isSidechain);
  let start = -1;
  for (let i = 0; i <= main.length; i++) {
    const t = main[i];
    const miss = t && i > 2 && t.usage.cacheRead === 0 && t.usage.input + t.usage.cacheCreation > 20_000;
    if (miss && start === -1) start = i;
    if (!miss && start !== -1) {
      if (i - start >= th.cacheThrashTurns) {
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

/** The same file edited fileChurnEdits+ times — usually an edit/test/edit spiral. */
export function detectFileChurn(model, th = DEFAULT_THRESHOLDS) {
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
    if (c.n >= th.fileChurnEdits) {
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

/**
 * A tool call whose result never came back, in a turn the session moved past —
 * "stuck waiting" as opposed to "failing repeatedly". The final turn is exempt:
 * a live session is legitimately still waiting there.
 */
export function detectStalledCalls(model) {
  const last = model.turns.length - 1;
  const flags = [];
  for (const turn of model.turns) {
    if (turn.index >= last) continue;
    const stalled = turn.toolCalls.filter((c) => !c.result);
    if (!stalled.length) continue;
    const first = stalled[0];
    flags.push({
      type: 'stalled-call',
      severity: 'warning',
      title: `${stalled.length} tool call(s) never returned`,
      detail: stalled.slice(0, 3).map((c) => `${c.name}(${c.summary ?? ''})`).join(', '),
      params: { count: stalled.length, first: `${first.name}:${first.summary ?? ''}` },
      turnStart: turn.index,
      turnEnd: turn.index,
    });
  }
  return flags.slice(0, 10);
}

// Only strong, unambiguous API-error shapes, and only on results the tool
// itself marked as errors — docs or prose that merely MENTION "rate limit"
// must not trip this. Broader patterns belong in user-defined custom rules.
const API_ERROR_RE = /rate.?limit(_error|ed)?|overloaded_error|quota\s+(exceeded|reached)|too many requests|\b(429|529)\b|service unavailable/i;

/** Upstream provider/API failures, distinct from ordinary tool errors. */
export function detectApiErrors(model) {
  const flags = [];
  for (const turn of model.turns) {
    for (const call of turn.toolCalls) {
      if (!call.result?.isError) continue;
      const m = API_ERROR_RE.exec(call.result.snippet ?? '');
      if (!m) continue;
      flags.push({
        type: 'api-error',
        severity: 'warning',
        title: 'API/provider error',
        detail: `${call.name}: …${excerpt(call.result.snippet, m)}…`,
        params: { name: call.name, match: m[0] },
        turnStart: turn.index,
        turnEnd: turn.index,
      });
    }
  }
  return flags.slice(0, 10);
}

/** User-defined regex rules from .agentfdr.json (validated at load time). */
export function detectCustom(model, rules) {
  const flags = [];
  for (const rule of rules) {
    let re;
    try {
      re = new RegExp(rule.match, rule.flags ?? 'i');
    } catch {
      continue; // loadConfig validates; stay defensive for direct API users
    }
    const where = rule.in ?? 'tool-results';
    const severity = rule.severity === 'critical' ? 'critical' : 'warning';
    let count = 0;
    for (const turn of model.turns) {
      const texts = [];
      if (where !== 'assistant-text') {
        for (const c of turn.toolCalls) {
          if (c.result?.snippet) texts.push([c.result.snippet, c.name]);
        }
      }
      if (where !== 'tool-results' && turn.text) texts.push([turn.text, null]);

      for (const [text, tool] of texts) {
        const m = re.exec(text);
        if (!m) continue;
        flags.push({
          type: 'custom',
          severity,
          title: rule.name,
          detail: (tool ? tool + ': ' : '') + '…' + excerpt(text, m) + '…',
          params: { name: rule.name, match: m[0] },
          turnStart: turn.index,
          turnEnd: turn.index,
        });
        count++;
        break; // one flag per turn per rule
      }
      if (count >= 10) break;
    }
  }
  return flags;
}

function excerpt(text, m) {
  return text
    .slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)
    .replace(/\s+/g, ' ')
    .trim();
}
