import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionText } from '../src/parser.js';
import { detect, detectToolLoops } from '../src/detect.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const ts = (i) => new Date(T0 + i * 1000).toISOString();
const aLine = (i, mid, blocks) => JSON.stringify({
  type: 'assistant', uuid: 'u' + i, timestamp: ts(i), sessionId: 's',
  message: { id: mid, model: 'claude-opus-4-8', role: 'assistant', content: blocks,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
});
const rLine = (i, id, text = 'ok', isError = false) => JSON.stringify({
  type: 'user', uuid: 'r' + i, timestamp: ts(i), sessionId: 's',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] },
});

/** `cycles` repetitions of Edit(file) -> Bash(npm test), each a distinct call id. */
function editTestSession(cycles) {
  const lines = [];
  let i = 0;
  for (let c = 0; c < cycles; c++) {
    const eid = 'e' + c, tid = 't' + c;
    lines.push(aLine(i, 'm' + i, [{ type: 'tool_use', id: eid, name: 'Edit', input: { file_path: '/proj/src/app.js' } }]));
    lines.push(rLine(i + 100, eid));
    i++;
    lines.push(aLine(i, 'm' + i, [{ type: 'tool_use', id: tid, name: 'Bash', input: { command: 'npm test' } }]));
    lines.push(rLine(i + 100, tid, c < cycles - 1 ? 'FAIL' : 'PASS'));
    i++;
  }
  return parseSessionText(lines.join('\n'));
}

/** `cycles` repetitions of Bash(npm test) -> Bash(npm run build). */
function testBuildSession(cycles) {
  const lines = [];
  let i = 0;
  for (let c = 0; c < cycles; c++) {
    const tid = 't' + c, bid = 'b' + c;
    lines.push(aLine(i, 'm' + i, [{ type: 'tool_use', id: tid, name: 'Bash', input: { command: 'npm test' } }]));
    lines.push(rLine(i + 100, tid, 'FAIL'));
    i++;
    lines.push(aLine(i, 'm' + i, [{ type: 'tool_use', id: bid, name: 'Bash', input: { command: 'npm run build' } }]));
    lines.push(rLine(i + 100, bid, 'ok'));
    i++;
  }
  return parseSessionText(lines.join('\n'));
}

/** `n` repeats of the identical single Bash call — no interleaving. */
function pureSpinSession(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(aLine(i, 'm' + i, [{ type: 'tool_use', id: 't' + i, name: 'Bash', input: { command: 'curl http://localhost:3000' } }]));
    lines.push(rLine(i + 100, 't' + i, 'connection refused', true));
  }
  return parseSessionText(lines.join('\n'));
}

test('a short edit<->test cycle is ordinary iteration, not flagged', () => {
  const model = editTestSession(3); // 3 cycles = 6 calls, well past the old threshold
  assert.ok(!detect(model).some((f) => f.type === 'loop'));
});

test('an edit<->test cycle that keeps going past the retry allowance still flags', () => {
  const model = editTestSession(8); // 8 cycles = 16 calls
  const flags = detect(model);
  assert.ok(flags.some((f) => f.type === 'loop'));
});

test('alternating test<->build idioms get the same benefit of the doubt', () => {
  const short = testBuildSession(3);
  assert.ok(!detect(short).some((f) => f.type === 'loop'));
  const long = testBuildSession(8);
  assert.ok(detect(long).some((f) => f.type === 'loop'));
});

test('a pure single-action spin is unaffected — still flags at the base threshold', () => {
  const model = pureSpinSession(6);
  assert.ok(detect(model).some((f) => f.type === 'loop'));
});

test('loopRetryRepeats is configurable independently of loopRepeats', () => {
  const model = editTestSession(4); // flagged by default (< 6 needed) -> not flagged
  assert.ok(!detect(model).some((f) => f.type === 'loop'));
  const lenient = detect(model, { thresholds: { loopRetryRepeats: 4 } });
  assert.ok(lenient.some((f) => f.type === 'loop'));
});

test('detectToolLoops: retry-shaped grams need loopRetryRepeats, not loopRepeats', () => {
  const model = editTestSession(4); // 4 cycles: >= loopRepeats(3) but < loopRetryRepeats(6)
  assert.equal(detectToolLoops(model).length, 0);
  assert.ok(detectToolLoops(model, { loopRepeats: 3, loopMinCalls: 6, loopRetryRepeats: 4 }).length > 0);
});
