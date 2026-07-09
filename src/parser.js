// Claude Code transcript (JSONL) -> normalized session model.
//
// Design principles:
// - Never throw on malformed/unknown lines: count them, keep going. A flight
//   recorder that loses data on a schema change is useless.
// - The transcript format is NOT a published API. Everything here is defensive:
//   optional chaining everywhere, unknown line types preserved as meta events.
//
// Model shape (all fields may be null when absent from the source):
// {
//   session: { id, file, title, cwd, gitBranch, version, model, startedAt, endedAt },
//   turns: [ Turn ],          // one per assistant API message (grouped by message.id)
//   prompts: [ Prompt ],      // visible user prompts
//   metaEvents: [ Meta ],     // mode changes, compaction, hooks, unknown lines
//   totals: { turns, toolCalls, toolErrors, tokens, wallMs, parseErrors }
// }

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const SNIPPET_LEN = 400;

export function parseSessionFile(file) {
  const text = readFileSync(file, 'utf8');
  return parseSessionText(text, file);
}

export function parseSessionText(text, file = '<memory>') {
  const session = {
    id: null,
    file,
    title: null,
    cwd: null,
    gitBranch: null,
    version: null,
    model: null,
    startedAt: null,
    endedAt: null,
  };

  const turnsById = new Map(); // message.id -> turn
  const turns = [];
  const prompts = [];
  const metaEvents = [];
  const pendingTools = new Map(); // tool_use id -> { call, turn }
  let parseErrors = 0;

  const touchTime = (ts) => {
    if (!ts) return;
    if (!session.startedAt || ts < session.startedAt) session.startedAt = ts;
    if (!session.endedAt || ts > session.endedAt) session.endedAt = ts;
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }

    session.id ??= entry.sessionId ?? entry.session_id ?? null;
    session.cwd ??= entry.cwd ?? null;
    session.gitBranch ??= entry.gitBranch ?? null;
    session.version ??= entry.version ?? null;
    touchTime(entry.timestamp);

    switch (entry.type) {
      case 'assistant':
        handleAssistant(entry);
        break;
      case 'user':
        handleUser(entry);
        break;
      case 'system':
        handleSystem(entry);
        break;
      case 'ai-title':
        if (entry.aiTitle) session.title = entry.aiTitle;
        break;
      case 'summary':
        metaEvents.push(meta('compaction', entry.timestamp, truncate(entry.summary, 200)));
        break;
      case 'mode':
        metaEvents.push(meta('mode', entry.timestamp, entry.mode));
        break;
      case 'permission-mode':
        metaEvents.push(meta('permission-mode', entry.timestamp, entry.permissionMode));
        break;
      case 'queue-operation':
        metaEvents.push(meta('queue', entry.timestamp, entry.operation));
        break;
      case 'attachment':
      case 'file-history-snapshot':
      case 'last-prompt':
        break; // high-volume bookkeeping lines; not useful on the timeline
      default:
        metaEvents.push(meta(`unknown:${entry.type}`, entry.timestamp, null));
    }
  }

  // Assign turn indices in encounter order.
  turns.forEach((t, i) => {
    t.index = i;
    t.contextTokens = t.usage.input + t.usage.cacheRead + t.usage.cacheCreation;
  });

  const totals = computeTotals(turns, metaEvents, session, parseErrors);
  return { session, turns, prompts, metaEvents, totals };

  // --- line handlers -------------------------------------------------------

  function handleAssistant(entry) {
    const msg = entry.message;
    if (!msg) return;
    const mid = msg.id ?? entry.uuid; // fall back: treat the line as its own turn
    let turn = turnsById.get(mid);
    if (!turn) {
      turn = {
        index: -1,
        messageId: mid,
        requestId: entry.requestId ?? null,
        promptId: entry.promptId ?? null,
        timestamp: entry.timestamp ?? null,
        model: msg.model ?? null,
        stopReason: null,
        isSidechain: entry.isSidechain === true,
        usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        contextTokens: 0,
        thinkingChars: 0,
        text: '',
        toolCalls: [],
      };
      turnsById.set(mid, turn);
      turns.push(turn);
      if (!session.model && msg.model) session.model = msg.model;
    }
    if (msg.stop_reason) turn.stopReason = msg.stop_reason;
    // The same message.id appears on multiple lines (one per content block),
    // each carrying the full usage object — overwrite, never accumulate.
    if (msg.usage) {
      // Top-level input/cache numbers are summed across `iterations` (server-side
      // retries/continuations), which inflates them past the real context size.
      // The last iteration reflects the context the model actually saw; output
      // stays the summed top-level figure because every iteration's output was paid for.
      const iters = Array.isArray(msg.usage.iterations) ? msg.usage.iterations : null;
      const ctx = iters?.length ? iters[iters.length - 1] : msg.usage;
      turn.usage = {
        input: ctx.input_tokens ?? 0,
        output: msg.usage.output_tokens ?? 0,
        cacheRead: ctx.cache_read_input_tokens ?? 0,
        cacheCreation: ctx.cache_creation_input_tokens ?? 0,
      };
    }
    for (const block of asArray(msg.content)) {
      if (block.type === 'thinking') {
        turn.thinkingChars += (block.thinking ?? '').length;
      } else if (block.type === 'text') {
        turn.text += (turn.text ? '\n' : '') + (block.text ?? '');
      } else if (block.type === 'tool_use') {
        const call = {
          id: block.id ?? null,
          name: block.name ?? '?',
          input: block.input ?? {},
          summary: summarizeInput(block.name, block.input),
          timestamp: entry.timestamp ?? null,
          result: null,
        };
        turn.toolCalls.push(call);
        if (call.id) pendingTools.set(call.id, { call, turn });
      }
    }
  }

  function handleUser(entry) {
    const content = entry.message?.content;
    let sawToolResult = false;

    for (const block of asArray(content)) {
      if (block.type !== 'tool_result') continue;
      sawToolResult = true;
      const pending = pendingTools.get(block.tool_use_id);
      if (!pending) continue;
      pendingTools.delete(block.tool_use_id);
      const resultText = extractText(block.content);
      pending.call.result = {
        isError: block.is_error === true,
        chars: resultText.length,
        snippet: truncate(resultText, SNIPPET_LEN),
        durationMs: msBetween(pending.call.timestamp, entry.timestamp),
      };
      // Bash-style results carry structured stdout/stderr alongside.
      const tur = entry.toolUseResult;
      if (tur && typeof tur === 'object' && !Array.isArray(tur)) {
        if (typeof tur.stdout === 'string' || typeof tur.stderr === 'string') {
          const full = (tur.stdout ?? '') + (tur.stderr ?? '');
          pending.call.result.chars = Math.max(pending.call.result.chars, full.length);
        }
      }
    }
    if (sawToolResult) return;

    if (entry.isCompactSummary === true) {
      metaEvents.push(meta('compaction', entry.timestamp, null));
      return;
    }

    const textContent = typeof content === 'string' ? content : extractText(content);
    if (!textContent) return;
    if (entry.isMeta === true || /^<(local-command|command-name|command-message)/.test(textContent)) {
      const cmd = /<command-name>([^<]*)<\/command-name>/.exec(textContent)?.[1];
      if (cmd) metaEvents.push(meta('command', entry.timestamp, cmd.trim()));
      return;
    }
    prompts.push({
      promptId: entry.promptId ?? null,
      timestamp: entry.timestamp ?? null,
      text: truncate(textContent, 2000),
      afterTurn: turns.length - 1, // index of the last turn seen before this prompt
    });
  }

  function handleSystem(entry) {
    if (entry.subtype === 'turn_duration') {
      metaEvents.push({
        ...meta('turn_duration', entry.timestamp, null),
        durationMs: entry.durationMs ?? null,
        afterTurn: turns.length - 1,
      });
      return;
    }
    if (entry.isCompactSummary === true || entry.subtype === 'compact_boundary') {
      metaEvents.push(meta('compaction', entry.timestamp, entry.subtype ?? null));
      return;
    }
    metaEvents.push(meta(`system:${entry.subtype ?? '?'}`, entry.timestamp, truncate(extractText(entry.content), 200) || null));
  }

  function meta(kind, timestamp, info) {
    return { kind, timestamp: timestamp ?? null, info: info ?? null, afterTurn: turns.length - 1 };
  }
}

// --- helpers ---------------------------------------------------------------

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function msBetween(a, b) {
  if (!a || !b) return null;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/** One-line human summary of a tool call's input, keyed by well-known arg names. */
export function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.file_path ?? input.path ?? input.notebook_path ??
    input.command ?? input.pattern ?? input.query ?? input.url ??
    input.description ?? input.prompt ?? input.skill;
  if (typeof pick === 'string') return truncate(pick.replace(/\s+/g, ' '), 120);
  const keys = Object.keys(input);
  return keys.length ? truncate(keys.join(', '), 120) : '';
}

/**
 * Signature used by the loop detector: tool name + the "target" of the call
 * (file path, first token of a command, search pattern...). Two calls with the
 * same signature are "the same action" for repetition purposes.
 */
export function toolSignature(call) {
  const input = call.input ?? {};
  let target =
    input.file_path ?? input.path ?? input.notebook_path ??
    input.pattern ?? input.query ?? input.url ?? null;
  if (target == null && typeof input.command === 'string') {
    target = input.command.trim().split(/\s+/).slice(0, 2).join(' ');
  }
  return `${call.name}:${typeof target === 'string' ? target : ''}`;
}

function computeTotals(turns, metaEvents, session, parseErrors) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let toolCalls = 0;
  let toolErrors = 0;
  for (const t of turns) {
    tokens.input += t.usage.input;
    tokens.output += t.usage.output;
    tokens.cacheRead += t.usage.cacheRead;
    tokens.cacheCreation += t.usage.cacheCreation;
    toolCalls += t.toolCalls.length;
    toolErrors += t.toolCalls.filter((c) => c.result?.isError).length;
  }
  return {
    turns: turns.length,
    toolCalls,
    toolErrors,
    tokens,
    wallMs: msBetween(session.startedAt, session.endedAt),
    parseErrors,
  };
}

/** Cheap title probe without a full parse (used by `agentfdr list`). */
export function probeTitle(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const idx = text.lastIndexOf('"ai-title"');
    if (idx === -1) return null;
    const lineStart = text.lastIndexOf('\n', idx) + 1;
    const lineEnd = text.indexOf('\n', idx);
    const entry = JSON.parse(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd));
    return entry.aiTitle ?? null;
  } catch {
    return null;
  }
}

export function sessionIdFromFile(file) {
  return basename(file, '.jsonl');
}
