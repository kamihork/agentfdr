import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionText } from '../src/parser.js';
import { detect } from '../src/detect.js';
import { diffSessions } from '../src/diff.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const ts = (i) => new Date(T0 + i * 1000).toISOString();

function assistantLine(i, mid, blocks, usage = {}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'u' + i,
    timestamp: ts(i),
    sessionId: 'sess',
    cwd: '/proj',
    message: {
      id: mid, model: 'claude-opus-4-8', role: 'assistant', content: blocks,
      usage: {
        input_tokens: usage.input ?? 100, output_tokens: usage.output ?? 50,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
    },
  });
}
const resultLine = (i, id, isError = false) => JSON.stringify({
  type: 'user', uuid: 'r' + i, timestamp: ts(i), sessionId: 'sess',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'boom' : 'ok', is_error: isError }] },
});

/** A failing session: repeated failing edits to the same file (6× → loop + churn). */
function failedSession() {
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push(assistantLine(i, 'm' + i, [
      { type: 'tool_use', id: 'e' + i, name: 'Edit', input: { file_path: '/proj/src/broken.js' } },
    ]));
    lines.push(resultLine(i + 100, 'e' + i, true));
  }
  return lines.join('\n');
}

/** The successful retry: one edit to a different file, one shared file, no errors. */
function retrySession() {
  return [
    assistantLine(0, 'm0', [
      { type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: '/proj/src/broken.js' } },
      { type: 'tool_use', id: 'b', name: 'Write', input: { file_path: '/proj/src/fixed.js' } },
    ]),
    resultLine(100, 'a'),
    resultLine(101, 'b'),
  ].join('\n');
}

function load(text) {
  const model = parseSessionText(text);
  return { model, flags: detect(model) };
}

test('diffSessions compares stats, flags, tools and files', () => {
  const d = diffSessions(load(failedSession()), load(retrySession()));

  assert.equal(d.a.stats.turns, 6);
  assert.equal(d.b.stats.turns, 1);
  assert.equal(d.a.stats.toolErrors, 6);
  assert.equal(d.b.stats.toolErrors, 0);
  assert.ok(d.a.stats.anomalies > 0); // loop + error streak in A
  assert.equal(d.b.stats.anomalies, 0);

  const loop = d.flags.find((f) => f.type === 'loop');
  assert.ok(loop && loop.a >= 1 && loop.b === 0);

  const edit = d.tools.find((t) => t.name === 'Edit');
  assert.deepEqual({ a: edit.a, b: edit.b }, { a: 6, b: 1 });

  // cwd is stripped from file paths; broken.js edited in both, fixed.js only in B
  assert.deepEqual(d.files.both, ['src/broken.js']);
  assert.deepEqual(d.files.onlyA, []);
  assert.deepEqual(d.files.onlyB, ['src/fixed.js']);
});

test('diffSessions estimates cost per side', () => {
  const d = diffSessions(load(failedSession()), load(retrySession()));
  assert.ok(d.a.stats.estUsd > d.b.stats.estUsd); // 4 turns vs 1 turn on the same model
});
