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
  const loops = detectToolLoops(model);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].severity, 'critical');
  assert.match(loops[0].detail, /Edit:\/same\.js → Bash:npm test/);
  assert.equal(loops[0].turnStart, 0);
  assert.equal(loops[0].turnEnd, 7);
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
  const flags = detect(model);
  const ja = blameReport(model, flags, 'ja');
  assert.match(ja, /フライトレポート/);
  assert.match(ja, /ツールループ ×4/);
  assert.match(ja, /ターン数/);
  const en = blameReport(model, flags, 'en');
  assert.match(en, /Flight report/);
  assert.match(en, /Tool loop ×4/);
});

test('resolveLang picks ja from env-style values', async () => {
  const { resolveLang } = await import('../src/i18n.js');
  assert.equal(resolveLang('ja'), 'ja');
  assert.equal(resolveLang('ja_JP.UTF-8'), 'ja');
  assert.equal(resolveLang('en_US.UTF-8'), 'en');
});
