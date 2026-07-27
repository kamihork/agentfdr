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
    ['intent-drift', () => detectIntentDrift(model, th)],
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

const WRITE_TOOL_RE = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/;
// test/build/lint/install/poll idioms — a command spent re-running one of
// these isn't evidence of being stuck the way an arbitrary repeated command is.
const RETRY_IDIOM_RE =
  /\b(test|jest|mocha|pytest|vitest|rspec|tox|phpunit|go\s+test|cargo\s+test|make\s+test)\b|\b(build|tsc|webpack|vite|cargo\s+build|go\s+build|make\s+build)\b|\b(lint|eslint|flake8|ruff|rubocop|stylelint)\b|\b(install|npm\s+ci|bundle\s+install|pip\s+install)\b|\bpoll(ing)?\b/i;

/**
 * A matched span is "retry-shaped" when it's more plausibly ongoing work than
 * a stuck spin: every call strictly alternates write/non-write (fix, verify,
 * fix, verify...), or every call is a recognized test/build/lint idiom (test,
 * then build, then test...). Classified over the WHOLE matched span, not just
 * the one-period gram — a 4-gram of [edit, test, edit, test] repeated is, at
 * every single position, still edit<->verify alternation, even though the
 * period the n-gram scan happened to lock onto was 4, not 2. Pure single-
 * action spins (the same call over and over with nothing interleaved) are
 * never retry-shaped — that pattern has no ambiguity to give the benefit of
 * the doubt to.
 */
function isRetryShapedSpan(items) {
  if (items.length < 2) return false;
  const writes = items.map((it) => WRITE_TOOL_RE.test(it.call.name));
  const alternates = writes.every((w, k) => k === 0 || w !== writes[k - 1]);
  if (alternates) return true; // edit <-> verify (or verify <-> verify never happens here: alternates implies both present)
  return items.every((it) => {
    const cmd = it.call.input?.command;
    return typeof cmd === 'string' && RETRY_IDIOM_RE.test(cmd);
  });
}

const charsBucket = (chars) => (chars == null ? 'n' : chars < 200 ? 's' : chars < 5000 ? 'm' : 'l');

// English fallback for the convergence hint (i18n.js re-renders it per language).
const CONVERGENCE_EN = {
  converging: 'hint: results still changing (may be converging)',
  spinning: 'hint: identical results each pass (looks stuck)',
};

/**
 * A HINT — never an all-clear — about whether a flagged loop looks like it's
 * making progress or spinning in place. We still flag the loop; this only
 * tells the reader which way to lean when they open it. Judged from the tool
 * RESULTS across periods (the signatures are identical by definition — that's
 * what made it a loop — so only the outcomes carry signal):
 *   - errors thinning out over the run, or
 *   - result shapes that keep changing (error text differs, output size moves)
 * read as "converging"; period after period of the exact same outcome reads as
 * "spinning". Undecidable when results weren't recorded.
 *
 * Ties break toward "spinning" on purpose: the loop was flagged, and a hint
 * that talks the reader out of looking is worse than one that doesn't.
 * Returns 'converging' | 'spinning' | null.
 */
function loopConvergence(span, n) {
  const repeats = span.length / n;
  if (repeats < 2) return null;
  const periodSigs = [];
  const errPerPeriod = [];
  let sawResult = false;
  for (let r = 0; r < repeats; r++) {
    const calls = span.slice(r * n, (r + 1) * n).map((s) => s.call);
    let errs = 0;
    const parts = calls.map((c) => {
      if (!c.result) return '-';
      sawResult = true;
      if (c.result.isError) errs++;
      return (c.result.isError ? 'E' : 'o') + charsBucket(c.result.chars) + ':' + (c.result.snippet ?? '').slice(0, 24);
    });
    periodSigs.push(parts.join('|'));
    errPerPeriod.push(errs);
  }
  if (!sawResult) return null; // nothing observable to judge
  const uniqueSigs = new Set(periodSigs).size;
  if (uniqueSigs === 1) return 'spinning'; // identical outcome every single period
  const errorsThinning = errPerPeriod[repeats - 1] < errPerPeriod[0];
  const resultsMoving = uniqueSigs >= Math.ceil(repeats * 0.6);
  return errorsThinning || resultsMoving ? 'converging' : 'spinning';
}

/**
 * Loop: the same n-gram of tool signatures repeated >= loopRepeats times
 * consecutively (n = 1..4), covering at least loopMinCalls calls. Grams that
 * look like ordinary iterative work — an edit alternating with a check, or a
 * test/build/lint idiom repeating — need >= loopRetryRepeats instead: more
 * tolerance for the common case, not immunity, so a session that's still
 * cycling well past that still gets flagged. A loop whose signatures are ALL
 * suppressed via config (legitimate retries etc.) is not flagged at all.
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
      const neededRepeats = isRetryShapedSpan(seq.slice(i, i + span)) ? th.loopRetryRepeats : th.loopRepeats;
      if (repeats >= neededRepeats && span >= th.loopMinCalls) {
        const gramSigs = seq.slice(i, i + n).map((s) => s.sig);
        const already = [...Array(span).keys()].every((k) => covered.has(i + k));
        const legit = gramSigs.every((sig) => isSuppressed(sig, suppress));
        if (!already && !legit) {
          for (let k = 0; k < span; k++) covered.add(i + k);
          const gram = gramSigs.join(' → ');
          const converging = loopConvergence(seq.slice(i, i + span), n);
          flags.push({
            type: 'loop',
            severity: 'critical',
            title: `Tool loop ×${repeats}`,
            detail: `Repeated ${repeats}× (${span} calls): ${gram}` +
              (converging ? ` — ${CONVERGENCE_EN[converging]}` : ''),
            params: { repeats, span, gram, ...(converging ? { converging } : {}) },
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

// --- intent drift ----------------------------------------------------------

const PATH_SEP_RE = /[/\\]/;
const baseOf = (p) => p.split(PATH_SEP_RE).pop() || p;
const dirOf = (p) => p.split(PATH_SEP_RE).slice(0, -1).join('/');
// Everything before the first dot: "detect.test.js" and "detect.js" share the
// stem "detect", which is what makes a file and its test the same work.
const stemOf = (b) => b.split('.')[0];

/** Every path-shaped argument a call touched, lowercased. */
function callPaths(call) {
  const input = call.input ?? {};
  return [input.file_path, input.notebook_path, input.path]
    .filter((v) => typeof v === 'string' && v)
    .map((v) => v.toLowerCase());
}

/**
 * Words in the prompt that could name a file: whole tokens, their path
 * segments, and the stem of anything filename-shaped. Deliberately generous —
 * every extra term can only make drift LESS likely to be flagged.
 */
function promptTerms(text) {
  const terms = new Set();
  for (const m of (text ?? '').toLowerCase().matchAll(/[a-z0-9_.\-/\\]{3,}/g)) {
    terms.add(m[0]);
    for (const seg of m[0].split(PATH_SEP_RE)) {
      if (seg.length < 3) continue;
      terms.add(seg);
      terms.add(stemOf(seg));
    }
  }
  return terms;
}

/**
 * "Related" is answered generously, because the cost of a false drift flag is
 * higher than the cost of a missed one: the same file, the same directory (in
 * either direction — a subdirectory of the work area still counts), the same
 * filename stem as something in the footprint (src/detect.js and
 * test/detect.test.js are one piece of work, not two), or a name the prompt
 * itself mentioned.
 */
function isRelatedPath(path, anchors, terms) {
  if (anchors.paths.has(path)) return true;
  const dir = dirOf(path);
  for (const d of anchors.dirs) {
    if (d === dir || (d && dir.startsWith(d + '/')) || (dir && d.startsWith(dir + '/'))) return true;
  }
  const base = baseOf(path);
  const stem = stemOf(base);
  if (stem.length >= 3 && anchors.stems.has(stem)) return true;
  return terms.has(base) || terms.has(stem);
}

const namesOf = (paths, max = 3) => {
  const names = [...new Set(paths.map(baseOf))];
  return names.slice(0, max).join(', ') + (names.length > max ? ` +${names.length - max}` : '');
};

/**
 * Intent drift: inside one prompt's stretch of turns, the EDITS walk away from
 * both the prompt and the files that stretch started on, and stay away.
 *
 * The baseline is the footprint of the first driftAnchorTurns file-touching
 * turns after the prompt — what the agent reached for when the request was
 * still fresh. From there on, an editing turn whose every path is unrelated to
 * that footprint and to the prompt's own words counts as drifted; a single
 * related edit means it's back on task and resets the count. Turns that only
 * read or search are neutral: looking around is not drifting.
 *
 * Only a drift that is still going when the next prompt arrives is reported.
 * An excursion the agent comes back from is how normal work looks — it's the
 * departure that never returns that answers "when did this stop being my task".
 *
 * A warning, not a verdict — a genuinely cross-cutting change can trip it.
 * Raise driftEditTurns if your work is routinely wide.
 */
export function detectIntentDrift(model, th = DEFAULT_THRESHOLDS) {
  const main = model.turns.filter((t) => !t.isSidechain);
  const prompts = (model.prompts ?? []).filter((p) => p.text);
  const flags = [];

  for (let pi = 0; pi < prompts.length; pi++) {
    const after = prompts[pi].afterTurn ?? -1;
    const until = pi + 1 < prompts.length ? (prompts[pi + 1].afterTurn ?? Infinity) : Infinity;
    const segment = main.filter((t) => t.index > after && t.index <= until);
    if (segment.length < th.driftAnchorTurns + th.driftEditTurns) continue;

    // Establish the footprint from the opening turns: at least driftAnchorTurns
    // of them, and always through the first turn that actually touched a file —
    // otherwise a segment that opens with a few pathless turns would spend its
    // anchor window on nothing and adopt the drift itself as the baseline.
    const anchorPaths = new Set();
    let j = 0;
    for (; j < segment.length; j++) {
      segment[j].toolCalls.flatMap(callPaths).forEach((p) => anchorPaths.add(p));
      if (j + 1 >= th.driftAnchorTurns && anchorPaths.size) {
        j++;
        break;
      }
    }
    // No footprint means nothing to drift from — say nothing rather than guess.
    if (!anchorPaths.size) continue;
    const terms = promptTerms(prompts[pi].text);
    // Intent drift needs evidence of intent. If nothing the segment opened on
    // is anything the prompt named, then either the prompt carried no target
    // ("続けて", "continue", a pasted URL, a harness notification) or the work
    // was already under way — and a footprint we can't tie to the request is
    // not a baseline worth measuring departures from.
    if (![...anchorPaths].some((p) => terms.has(baseOf(p)) || terms.has(stemOf(baseOf(p))))) continue;
    const anchors = {
      paths: anchorPaths,
      dirs: new Set([...anchorPaths].map(dirOf)),
      stems: new Set([...anchorPaths].map((p) => stemOf(baseOf(p)))),
    };

    let streak = 0;
    let first = null;
    let last = null;
    let drifted = [];
    for (; j < segment.length; j++) {
      const edits = segment[j].toolCalls
        .filter((c) => WRITE_TOOL_RE.test(c.name))
        .flatMap(callPaths);
      if (!edits.length) continue; // reading/searching is not drifting
      if (edits.some((p) => isRelatedPath(p, anchors, terms))) {
        streak = 0; // back on task: whatever that was, it was an excursion
        first = null;
        drifted = [];
        continue;
      }
      streak++;
      first ??= segment[j].index;
      last = segment[j].index;
      drifted.push(...edits);
    }
    if (streak < th.driftEditTurns) continue;

    const files = namesOf(drifted);
    const anchorNames = namesOf([...anchorPaths]);
    const prompt = prompts[pi].text.replace(/\s+/g, ' ').trim().slice(0, 60);
    flags.push({
      type: 'intent-drift',
      severity: 'warning',
      title: 'Edits drifted off the prompt',
      detail: `From turn ${first}: ${files} — unrelated to the prompt ("${prompt}") or to where this stretch started (${anchorNames})`,
      params: { turn: first, turns: streak, files, anchors: anchorNames, prompt },
      turnStart: first,
      turnEnd: last,
    });
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
