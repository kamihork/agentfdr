// Codex CLI rollout (JSONL) -> the same normalized session model as parser.js.
//
// Codex (openai/codex, Rust CLI) records every session under
// ~/.codex/sessions/YYYY/MM/DD/rollout-<date>T<time>-<uuid>.jsonl.
// Each line is an envelope: { timestamp, type, payload } where type is
// session_meta | turn_context | response_item | event_msg | compacted | ...
// response_item payloads are Responses-API items (message / function_call /
// function_call_output / reasoning / local_shell_call / web_search_call ...).
//
// Like the Claude parser, everything here is defensive: unknown line types are
// preserved as meta events and malformed lines are counted, never thrown on.

import { readFileSync } from 'node:fs';
import { computeTotals, summarizeInput, parseSessionText } from './parser.js';

const SNIPPET_LEN = 400;
const HARNESS_TAG_RE = /^<(environment_context|user_instructions|ENVIRONMENT|turn_aborted|permissions|AGENTS)/;

/** Cheap format sniff: does this JSONL text look like a Codex rollout? */
export function looksLikeCodex(text) {
  const nl = text.indexOf('\n');
  const first = (nl === -1 ? text : text.slice(0, nl)).trim();
  if (!first) return false;
  try {
    const entry = JSON.parse(first);
    return entry && typeof entry === 'object' && 'payload' in entry &&
      ['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted'].includes(entry.type);
  } catch {
    return false;
  }
}

/** Parse any supported transcript: Claude Code or Codex, sniffed from content. */
export function parseAnySessionText(text, file) {
  return looksLikeCodex(text) ? parseCodexText(text, file) : parseSessionText(text, file);
}

export function parseAnySessionFile(file) {
  return parseAnySessionText(readFileSync(file, 'utf8'), file);
}

export function parseCodexText(text, file = '<memory>') {
  const session = {
    id: null, file, title: null, cwd: null, gitBranch: null, version: null,
    model: null, models: [], effort: null, startedAt: null, endedAt: null,
    agent: 'codex',
  };

  const turns = [];
  const prompts = [];
  const metaEvents = [];
  const pendingTools = new Map(); // call_id -> call
  let parseErrors = 0;
  let currentModel = null;
  let cur = null; // turn being accumulated; flushed on each token_count event

  const touchTime = (ts) => {
    if (!ts) return;
    if (!session.startedAt || ts < session.startedAt) session.startedAt = ts;
    if (!session.endedAt || ts > session.endedAt) session.endedAt = ts;
  };
  const meta = (kind, timestamp, info) =>
    ({ kind, timestamp: timestamp ?? null, info: info ?? null, afterTurn: turns.length - 1 });
  const openTurn = (ts) => {
    cur ??= {
      index: -1, messageId: null, requestId: null, promptId: null,
      timestamp: ts ?? null, model: null, speed: null, stopReason: null,
      isSidechain: false,
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      contextTokens: 0, thinkingChars: 0, webSearch: 0, webFetch: 0,
      text: '', toolCalls: [],
    };
    return cur;
  };
  const flushTurn = (usage, ts) => {
    if (!cur && !usage) return;
    const t = openTurn(ts);
    if (usage) {
      // Per codex-rs protocol, input_tokens excludes cached tokens; cache
      // writes are recorded but not billed by OpenAI (usually 0).
      t.usage = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cached_input_tokens ?? 0,
        cacheCreation: usage.cache_write_input_tokens ?? 0,
      };
    }
    t.model = currentModel;
    t.timestamp ??= ts ?? null;
    turns.push(t);
    if (!session.model && currentModel) session.model = currentModel;
    cur = null;
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
    const ts = entry.timestamp ?? null;
    const p = entry.payload ?? {};
    touchTime(ts);

    switch (entry.type) {
      case 'session_meta': {
        const m = p.meta && typeof p.meta === 'object' ? p.meta : p;
        session.id ??= m.id ?? null;
        session.cwd ??= m.cwd ?? null;
        session.version ??= m.cli_version ?? null;
        session.gitBranch ??= p.git?.branch ?? m.git?.branch ?? null;
        break;
      }
      case 'turn_context':
        currentModel = p.model ?? currentModel;
        session.effort = p.effort ?? p.reasoning_effort ?? p.model_reasoning_effort ?? session.effort;
        session.cwd ??= p.cwd ?? null;
        break;
      case 'response_item':
        handleItem(p, ts);
        break;
      case 'event_msg':
        if (p.type === 'token_count') {
          const info = p.info ?? p;
          const usage = info.last_token_usage ?? info.usage ?? null;
          if (usage || cur) flushTurn(usage, ts);
        }
        break; // other event_msg types duplicate response_item lines
      case 'compacted': {
        const last = metaEvents.findLast((m) => m.kind === 'compaction');
        if (!(last && last.afterTurn === turns.length - 1)) {
          metaEvents.push(meta('compaction', ts, truncate(p.message, 200) || null));
        }
        break;
      }
      default:
        metaEvents.push(meta(`unknown:${entry.type}`, ts, null));
    }
  }
  if (cur) flushTurn(null, session.endedAt); // trailing turn without a token_count

  turns.forEach((t, i) => {
    t.index = i;
    t.contextTokens = t.usage.input + t.usage.cacheRead + t.usage.cacheCreation;
  });
  const modelCounts = new Map();
  for (const t of turns) {
    if (t.model) modelCounts.set(t.model, (modelCounts.get(t.model) ?? 0) + 1);
  }
  session.models = [...modelCounts].map(([model, n]) => ({ model, turns: n }));
  session.title ??= prompts[0] ? truncate(prompts[0].text, 80) : null;

  const totals = computeTotals(turns, metaEvents, session, parseErrors);
  return { session, turns, prompts, metaEvents, totals };

  // --- response_item handlers ----------------------------------------------

  function handleItem(item, ts) {
    switch (item.type) {
      case 'message': {
        const text = itemText(item.content);
        if (item.role === 'assistant') {
          if (text) openTurn(ts).text += (cur.text ? '\n' : '') + text;
        } else if (item.role === 'user') {
          if (!text || HARNESS_TAG_RE.test(text.trim())) return;
          prompts.push({
            promptId: null, timestamp: ts, text: truncate(text, 2000),
            afterTurn: turns.length - 1,
          });
        }
        break;
      }
      case 'reasoning': {
        const t = openTurn(ts);
        for (const s of asArray(item.summary)) t.thinkingChars += (s?.text ?? '').length;
        for (const c of asArray(item.content)) t.thinkingChars += (c?.text ?? '').length;
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const input = parseArgs(item.arguments ?? item.input);
        addCall(ts, item.name ?? '?', input, item.call_id ?? item.id);
        break;
      }
      case 'local_shell_call': {
        const input = normalizeCommand(item.action ?? {});
        addCall(ts, 'shell', input, item.call_id ?? item.id);
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const call = pendingTools.get(item.call_id);
        if (!call) return;
        pendingTools.delete(item.call_id);
        call.result = parseOutput(item.output, call.timestamp, ts);
        break;
      }
      case 'web_search_call': {
        const t = openTurn(ts);
        t.webSearch += 1;
        const q = item.action?.query ?? '';
        t.toolCalls.push({
          id: item.id ?? null, name: 'web_search', input: q ? { query: q } : {},
          summary: truncate(q, 120), timestamp: ts,
          // searches complete inline; a null result would read as "stalled"
          result: { isError: false, chars: 0, snippet: '', durationMs: null },
        });
        break;
      }
      default:
        break; // other item kinds carry no timeline signal
    }
  }

  function addCall(ts, name, input, callId) {
    const t = openTurn(ts);
    const call = {
      id: callId ?? null, name, input,
      summary: summarizeCodexInput(name, input),
      timestamp: ts, result: null,
    };
    t.toolCalls.push(call);
    if (call.id) pendingTools.set(call.id, call);
  }
}

// --- helpers -----------------------------------------------------------------

function asArray(v) {
  return Array.isArray(v) ? v : [];
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

function itemText(content) {
  if (typeof content === 'string') return content;
  return asArray(content)
    .filter((c) => c && typeof c.text === 'string' && /text/.test(c.type ?? ''))
    .map((c) => c.text)
    .join('\n');
}

/** arguments is a JSON string; shell command arrays become one flat string so
 *  the loop detector's signature ("first token of command") works unchanged. */
function parseArgs(args) {
  let input = args;
  if (typeof args === 'string') {
    try {
      input = JSON.parse(args);
    } catch {
      return args.trim() ? { input: truncate(args, 500) } : {};
    }
  }
  if (!input || typeof input !== 'object') return {};
  return normalizeCommand(input);
}

function normalizeCommand(input) {
  if (Array.isArray(input.command)) {
    let cmd = input.command;
    // ["bash", "-lc", "actual command"] -> "actual command"
    if (cmd.length === 3 && /^(bash|sh|zsh)$/.test(cmd[0]) && /^-l?c$/.test(cmd[1])) cmd = [cmd[2]];
    return { ...input, command: cmd.join(' ') };
  }
  return input;
}

function summarizeCodexInput(name, input) {
  // apply_patch input is a patch blob — the touched files ARE the summary.
  if (typeof input?.input === 'string' && /apply_patch/i.test(name)) {
    const files = [...input.input.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)].map((m) => m[1].trim());
    if (files.length) return truncate(files.join(', '), 120);
  }
  const s = summarizeInput(name, input);
  if (s) return s;
  if (typeof input?.input === 'string') return truncate(input.input.replace(/\s+/g, ' '), 120);
  const keys = input && typeof input === 'object' ? Object.keys(input) : [];
  return keys.length ? truncate(keys.join(', '), 120) : '';
}

/** Output is untagged: a plain string, or JSON like
 *  {"output": "...", "metadata": {"exit_code": 1, "duration_seconds": 2.3}},
 *  or {"content": "...", "success": false}. */
function parseOutput(output, callTs, ts) {
  let text = typeof output === 'string' ? output : '';
  let isError = false;
  let durationMs = msBetween(callTs, ts);
  let parsed = output;
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output);
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.output === 'string') text = parsed.output;
    else if (typeof parsed.content === 'string') text = parsed.content;
    if (parsed.success === false) isError = true;
    const metaInfo = parsed.metadata;
    if (metaInfo && typeof metaInfo === 'object') {
      if (metaInfo.exit_code != null && metaInfo.exit_code !== 0) isError = true;
      if (typeof metaInfo.duration_seconds === 'number') durationMs = Math.round(metaInfo.duration_seconds * 1000);
    }
  }
  return { isError, chars: text.length, snippet: truncate(text, SNIPPET_LEN), durationMs };
}

/** Cheap title probe for `list`/the session picker: first real user prompt. */
export function probeCodexTitle(file) {
  try {
    const text = readFileSync(file, 'utf8');
    let seen = 0;
    for (const line of text.split('\n')) {
      if (!line.includes('"user"')) continue;
      if (++seen > 50) return null;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'response_item' || entry.payload?.type !== 'message' || entry.payload?.role !== 'user') continue;
        const t = itemText(entry.payload.content);
        if (t && !HARNESS_TAG_RE.test(t.trim())) return truncate(t.replace(/\s+/g, ' '), 80);
      } catch {
        // malformed line; keep scanning
      }
    }
    return null;
  } catch {
    return null;
  }
}
