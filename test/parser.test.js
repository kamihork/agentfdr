import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionText, toolSignature } from '../src/parser.js';
import { detect, detectToolLoops, detectErrorStreaks } from '../src/detect.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const ts = (i) => new Date(T0 + i * 1000).toISOString();

function assistantLine(i, mid, blocks, usage = {}) {
  return {
    type: 'assistant',
    uuid: 'u' + i,
    timestamp: ts(i),
    sessionId: 'sess-1',
    cwd: '/tmp/proj',
    version: '2.1.201',
    gitBranch: 'main',
    message: {
      id: mid,
      model: 'claude-test-1',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: blocks,
      usage: {
        input_tokens: usage.input ?? 100,
        output_tokens: usage.output ?? 50,
        cache_read_input_tokens: usage.cacheRead ?? 1000,
        cache_creation_input_tokens: usage.cacheCreation ?? 0,
      },
    },
  };
}

function toolResultLine(i, toolUseId, { isError = false, text = 'ok' } = {}) {
  return {
    type: 'user',
    uuid: 'u' + i,
    timestamp: ts(i),
    sessionId: 'sess-1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] },
  };
}

function jsonl(lines) {
  return lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
}

test('parses turns, grouping multi-line assistant messages by message.id', () => {
  const model = parseSessionText(jsonl([
    { type: 'ai-title', aiTitle: 'Test session', sessionId: 'sess-1' },
    { type: 'user', uuid: 'p1', timestamp: ts(0), sessionId: 'sess-1', message: { role: 'user', content: 'please fix the bug' } },
    assistantLine(1, 'msg_A', [{ type: 'thinking', thinking: 'hmm' }]),
    assistantLine(2, 'msg_A', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.js' } }]),
    toolResultLine(3, 't1', { text: 'file contents' }),
    assistantLine(4, 'msg_B', [{ type: 'text', text: 'done' }], { output: 9 }),
  ]));

  assert.equal(model.session.id, 'sess-1');
  assert.equal(model.session.title, 'Test session');
  assert.equal(model.session.model, 'claude-test-1');
  assert.equal(model.turns.length, 2); // msg_A merged, not duplicated
  assert.equal(model.prompts.length, 1);
  assert.equal(model.prompts[0].text, 'please fix the bug');

  const a = model.turns[0];
  assert.equal(a.thinkingChars, 3);
  assert.equal(a.toolCalls.length, 1);
  assert.equal(a.toolCalls[0].name, 'Read');
  assert.equal(a.toolCalls[0].summary, '/a.js');
  assert.equal(a.toolCalls[0].result.isError, false);
  assert.equal(a.toolCalls[0].result.durationMs, 1000);
  // usage taken once per message, never summed across its lines
  assert.equal(a.usage.input, 100);
  assert.equal(a.contextTokens, 1100);
  assert.equal(model.totals.tokens.output, 59);
});

test('malformed lines are counted, not fatal', () => {
  const model = parseSessionText(jsonl([
    'this is not json{{{',
    assistantLine(0, 'msg_A', [{ type: 'text', text: 'hi' }]),
  ]));
  assert.equal(model.totals.parseErrors, 1);
  assert.equal(model.turns.length, 1);
});

test('unknown line types become meta events', () => {
  const model = parseSessionText(jsonl([
    { type: 'brand-new-thing', timestamp: ts(0), sessionId: 'sess-1' },
  ]));
  assert.ok(model.metaEvents.some((m) => m.kind === 'unknown:brand-new-thing'));
});

test('tool signature keys on the call target', () => {
  assert.equal(toolSignature({ name: 'Edit', input: { file_path: '/x.js', old_string: 'a' } }), 'Edit:/x.js');
  assert.equal(toolSignature({ name: 'Bash', input: { command: 'npm test -- --watch' } }), 'Bash:npm test');
  assert.equal(toolSignature({ name: 'Task', input: {} }), 'Task:');
});

test('detects a tool loop (same edit-test cycle repeated)', () => {
  // Edit<->test is an ambiguous ("could be real iteration") gram shape, so it
  // needs loopRetryRepeats (6), not the base loopRepeats (3) — see detect.js.
  const lines = [];
  let i = 0;
  for (let rep = 0; rep < 6; rep++) {
    lines.push(assistantLine(i, 'msg_' + i, [
      { type: 'tool_use', id: 'e' + i, name: 'Edit', input: { file_path: '/same.js' } },
    ]));
    lines.push(toolResultLine(i + 100, 'e' + i));
    i++;
    lines.push(assistantLine(i, 'msg_' + i, [
      { type: 'tool_use', id: 'b' + i, name: 'Bash', input: { command: 'npm test' } },
    ]));
    lines.push(toolResultLine(i + 100, 'b' + i, { isError: true, text: 'FAIL' }));
    i++;
  }
  const model = parseSessionText(jsonl(lines));
  const loops = detectToolLoops(model);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].severity, 'critical');
  assert.match(loops[0].detail, /Edit:\/same\.js → Bash:npm test/);
  assert.equal(loops[0].turnStart, 0);
  assert.equal(loops[0].turnEnd, 11);
});

test('a short edit-test cycle (ordinary iteration) is not flagged as a loop', () => {
  const lines = [];
  let i = 0;
  for (let rep = 0; rep < 4; rep++) {
    lines.push(assistantLine(i, 'msg_' + i, [
      { type: 'tool_use', id: 'e' + i, name: 'Edit', input: { file_path: '/same.js' } },
    ]));
    lines.push(toolResultLine(i + 100, 'e' + i));
    i++;
    lines.push(assistantLine(i, 'msg_' + i, [
      { type: 'tool_use', id: 'b' + i, name: 'Bash', input: { command: 'npm test' } },
    ]));
    lines.push(toolResultLine(i + 100, 'b' + i, { isError: true, text: 'FAIL' }));
    i++;
  }
  const model = parseSessionText(jsonl(lines));
  assert.equal(detectToolLoops(model).length, 0);
});

test('no loop flag for varied work', () => {
  const lines = [];
  const files = ['/a.js', '/b.js', '/c.js', '/d.js', '/e.js', '/f.js', '/g.js', '/h.js'];
  files.forEach((f, i) => {
    lines.push(assistantLine(i, 'msg_' + i, [
      { type: 'tool_use', id: 't' + i, name: 'Edit', input: { file_path: f } },
    ]));
    lines.push(toolResultLine(i + 100, 't' + i));
  });
  const model = parseSessionText(jsonl(lines));
  assert.equal(detectToolLoops(model).length, 0);
});

test('detects consecutive error streaks', () => {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(assistantLine(i, 'msg_' + i, [
      { type: 'tool_use', id: 't' + i, name: 'Bash', input: { command: 'make build-' + i } },
    ]));
    lines.push(toolResultLine(i + 100, 't' + i, { isError: true, text: 'boom' }));
  }
  const model = parseSessionText(jsonl(lines));
  const streaks = detectErrorStreaks(model);
  assert.equal(streaks.length, 1);
  assert.match(streaks[0].title, /4 consecutive/);
});

test('detect() runs the full battery and sorts critical first', () => {
  const lines = [];
  let i = 0;
  for (let rep = 0; rep < 3; rep++) {
    lines.push(assistantLine(i, 'msg_' + i, [
      { type: 'tool_use', id: 'a' + i, name: 'Read', input: { file_path: '/big.js' } },
      { type: 'tool_use', id: 'b' + i, name: 'Edit', input: { file_path: '/big.js' } },
    ]));
    lines.push(toolResultLine(i + 100, 'a' + i, { text: 'x'.repeat(60_000) }));
    lines.push(toolResultLine(i + 101, 'b' + i, { isError: true, text: 'no match' }));
    i++;
  }
  const model = parseSessionText(jsonl(lines));
  const flags = detect(model);
  assert.ok(flags.length >= 2);
  for (let k = 1; k < flags.length; k++) {
    const order = { critical: 0, warning: 1 };
    assert.ok(order[flags[k - 1].severity] <= order[flags[k].severity]);
  }
});

test('blame report renders in Japanese with structured flag params', async () => {
  const { blameReport } = await import('../src/report.js');
  const lines = [];
  let i = 0;
  for (let rep = 0; rep < 6; rep++) {
    lines.push(assistantLine(i, 'msg_' + i, [
      { type: 'tool_use', id: 'e' + i, name: 'Edit', input: { file_path: '/same.js' } },
    ]));
    lines.push(toolResultLine(i + 100, 'e' + i));
    i++;
    lines.push(assistantLine(i, 'msg_' + i, [
      { type: 'tool_use', id: 'b' + i, name: 'Bash', input: { command: 'npm test' } },
    ]));
    lines.push(toolResultLine(i + 100, 'b' + i, { isError: true, text: 'FAIL' }));
    i++;
  }
  const model = parseSessionText(jsonl(lines));
  const flags = detect(model);
  const ja = blameReport(model, flags, 'ja');
  assert.match(ja, /フライトレポート/);
  assert.match(ja, /ツールループ ×6/);
  assert.match(ja, /ターン数/);
  const en = blameReport(model, flags, 'en');
  assert.match(en, /Flight report/);
  assert.match(en, /Tool loop ×6/);
});

test('collects models used, effort changes, and fast-mode turns', () => {
  const esc = String.fromCharCode(27);
  const model = parseSessionText(jsonl([
    assistantLine(0, 'msg_A', [{ type: 'text', text: 'hi' }]),
    // model switch mid-session
    { ...assistantLine(1, 'msg_B', [{ type: 'text', text: 'yo' }]), message: {
      ...assistantLine(1, 'msg_B', []).message,
      model: 'claude-haiku-4-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed: 'fast' },
    } },
    // /effort stdout with ANSI-style markup
    { type: 'user', uuid: 'c1', timestamp: ts(2), sessionId: 'sess-1',
      message: { role: 'user', content: `<command-name>/effort</command-name>` } },
    { type: 'user', uuid: 'c2', timestamp: ts(3), sessionId: 'sess-1',
      message: { role: 'user', content: `<local-command-stdout>Set effort level to xhigh (saved as your default)</local-command-stdout>` } },
    { type: 'user', uuid: 'c3', timestamp: ts(4), sessionId: 'sess-1',
      message: { role: 'user', content: `<local-command-stdout>Set model to ${esc}[1mFable 5${esc}[22m and saved as your default for new sessions</local-command-stdout>` } },
  ]));

  assert.deepEqual(model.session.models, [
    { model: 'claude-test-1', turns: 1 },
    { model: 'claude-haiku-4-5', turns: 1 },
  ]);
  assert.equal(model.session.effort, 'xhigh');
  assert.equal(model.turns[1].speed, 'fast');
  assert.equal(model.turns[0].speed, null);
  const mc = model.metaEvents.find((m) => m.kind === 'model-change');
  assert.equal(mc.info, 'Fable 5');
});

test('messages typed mid-turn (queue-operation) become prompts', () => {
  const model = parseSessionText(jsonl([
    { type: 'user', uuid: 'p1', timestamp: ts(0), sessionId: 'sess-1', message: { role: 'user', content: 'fix the bug' } },
    assistantLine(1, 'msg_A', [{ type: 'text', text: 'working on it' }]),
    { type: 'queue-operation', operation: 'enqueue', content: 'also update the docs', timestamp: ts(2), sessionId: 'sess-1' },
    { type: 'queue-operation', operation: 'remove', content: 'also update the docs', timestamp: ts(3), sessionId: 'sess-1' },
    assistantLine(4, 'msg_B', [{ type: 'text', text: 'done' }]),
  ]));
  assert.equal(model.prompts.length, 2);
  assert.equal(model.prompts[1].text, 'also update the docs');
  assert.equal(model.prompts[1].queued, true);
});

test('queued prompt later delivered as a user line is not duplicated', () => {
  const model = parseSessionText(jsonl([
    { type: 'queue-operation', operation: 'enqueue', content: 'do X', timestamp: ts(0), sessionId: 'sess-1' },
    assistantLine(1, 'msg_A', [{ type: 'text', text: 'hi' }]),
    { type: 'user', uuid: 'p2', timestamp: ts(2), sessionId: 'sess-1', message: { role: 'user', content: 'do X' } },
  ]));
  assert.equal(model.prompts.length, 1);
  assert.equal(model.prompts[0].queued, false);
  assert.equal(model.prompts[0].afterTurn, 0); // jump target updated to delivery point
});

test('one compaction recorded via multiple transcript lines counts once', () => {
  const model = parseSessionText(jsonl([
    assistantLine(0, 'msg_A', [{ type: 'text', text: 'hi' }]),
    // Claude Code writes a system compact_boundary AND a summary line for one compaction
    { type: 'system', subtype: 'compact_boundary', timestamp: ts(1), sessionId: 'sess-1' },
    { type: 'summary', summary: 'compacted context', timestamp: ts(1), sessionId: 'sess-1' },
    assistantLine(2, 'msg_B', [{ type: 'text', text: 'yo' }]),
    // a second, genuinely separate compaction later
    { type: 'system', subtype: 'compact_boundary', timestamp: ts(3), sessionId: 'sess-1' },
  ]));
  assert.equal(model.totals.compactions, 2);
});

test('identical prompt typed hours after a queued one is a new prompt, not a merge', () => {
  const HOURS3 = 3 * 60 * 60;
  const model = parseSessionText(jsonl([
    { type: 'queue-operation', operation: 'enqueue', content: 'do X', timestamp: ts(0), sessionId: 'sess-1' },
    assistantLine(1, 'msg_A', [{ type: 'text', text: 'hi' }]),
    { type: 'user', uuid: 'p2', timestamp: ts(HOURS3), sessionId: 'sess-1', message: { role: 'user', content: 'do X' } },
  ]));
  assert.equal(model.prompts.length, 2); // outside the merge window: two distinct prompts
  assert.equal(model.prompts[0].queued, true);
  assert.equal(model.prompts[1].queued, undefined);
});

test('resolveLang picks ja from env-style values', async () => {
  const { resolveLang } = await import('../src/i18n.js');
  assert.equal(resolveLang('ja'), 'ja');
  assert.equal(resolveLang('ja_JP.UTF-8'), 'ja');
  assert.equal(resolveLang('en_US.UTF-8'), 'en');
});
