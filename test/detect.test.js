import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionText } from '../src/parser.js';
import { detect, detectToolLoops, detectIntentDrift } from '../src/detect.js';

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

/** `n` repeats of one identical Bash call, with per-repeat [text, isError] results. */
function spinSession(n, resultFor) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(aLine(i, 'm' + i, [{ type: 'tool_use', id: 't' + i, name: 'Bash', input: { command: 'curl http://localhost:3000' } }]));
    const r = resultFor(i);
    if (r) lines.push(rLine(i + 100, 't' + i, r[0], r[1]));
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

test('convergence hint: the same outcome every pass reads as spinning', () => {
  const [loop] = detectToolLoops(spinSession(6, () => ['connection refused', true]));
  assert.equal(loop.params.converging, 'spinning');
  assert.match(loop.detail, /looks stuck/);
});

test('convergence hint: results that keep moving read as converging', () => {
  const [loop] = detectToolLoops(spinSession(6, (i) =>
    i < 3 ? [`connection refused (attempt ${i})`, true] : [`HTTP 200 — body ${i}`, false]));
  assert.equal(loop.params.converging, 'converging');
  assert.match(loop.detail, /may be converging/);
});

test('convergence hint: errors thinning out reads as converging even if the shape repeats', () => {
  // Identical text once it succeeds, so only the error count carries the signal.
  const [loop] = detectToolLoops(spinSession(6, (i) => (i < 2 ? ['boom', true] : ['ok', false])));
  assert.equal(loop.params.converging, 'converging');
});

test('convergence hint: absent — never guessed — when no results were recorded', () => {
  const [loop] = detectToolLoops(spinSession(6, () => null));
  assert.equal(loop.params.converging, undefined);
  assert.doesNotMatch(loop.detail, /hint:/);
});

test('the convergence hint never suppresses the loop flag itself', () => {
  const converging = spinSession(6, (i) => [`different every time ${i}`, false]);
  assert.equal(detectToolLoops(converging).length, 1);
});

test('detectToolLoops: retry-shaped grams need loopRetryRepeats, not loopRepeats', () => {
  const model = editTestSession(4); // 4 cycles: >= loopRepeats(3) but < loopRetryRepeats(6)
  assert.equal(detectToolLoops(model).length, 0);
  assert.ok(detectToolLoops(model, { loopRepeats: 3, loopMinCalls: 6, loopRetryRepeats: 4 }).length > 0);
});

// --- intent drift ----------------------------------------------------------

const pLine = (i, text) => JSON.stringify({
  type: 'user', uuid: 'p' + i, timestamp: ts(i), sessionId: 's',
  message: { role: 'user', content: text },
});

/** One prompt, then a turn per [tool, path] pair (a null path = a pathless Bash). */
function promptSession(prompt, steps) {
  const lines = [pLine(0, prompt)];
  steps.forEach(([tool, path], k) => {
    const input = path ? { file_path: path } : { command: 'npm test' };
    lines.push(aLine(k + 1, 'm' + k, [{ type: 'tool_use', id: 'c' + k, name: tool, input }]));
    lines.push(rLine(k + 200, 'c' + k, 'ok'));
  });
  return parseSessionText(lines.join('\n'));
}

const LOGIN_PROMPT = 'Fix the login redirect in src/auth/login.js';
const onTask = [['Read', '/proj/src/auth/login.js'], ['Edit', '/proj/src/auth/login.js'], ['Bash', null]];

test('edits that walk away from the prompt and stay away are flagged at the turn they left', () => {
  const model = promptSession(LOGIN_PROMPT, [
    ...onTask,
    ['Edit', '/proj/web/router/routes.js'],
    ['Edit', '/proj/web/router/table.js'],
    ['Edit', '/proj/web/router/mount.js'],
  ]);
  const [drift, ...rest] = detectIntentDrift(model);
  assert.equal(rest.length, 0); // one report per prompt, not one per drifted turn
  assert.equal(drift.turnStart, 3);
  assert.equal(drift.turnEnd, 5);
  assert.equal(drift.severity, 'warning');
  assert.match(drift.params.files, /routes\.js/);
  assert.match(drift.params.anchors, /login\.js/);
  assert.ok(detect(model).some((f) => f.type === 'intent-drift'));
});

test('drift: neighbouring files in the same work area are not drift', () => {
  const model = promptSession(LOGIN_PROMPT, [
    ...onTask,
    ['Edit', '/proj/src/auth/session.js'],
    ['Edit', '/proj/src/auth/helpers/cookie.js'], // a subdirectory of the work area
    ['Edit', '/proj/src/auth/token.js'],
  ]);
  assert.deepEqual(detectIntentDrift(model), []);
});

test('drift: files the prompt itself named are never drift, wherever they live', () => {
  const model = promptSession('Bump the version and update docs/changelog.md and docs/release-notes.md', [
    ['Read', '/proj/tools/bump.js'], ['Edit', '/proj/tools/bump.js'], ['Bash', null],
    ['Edit', '/proj/docs/changelog.md'],
    ['Edit', '/proj/docs/release-notes.md'],
    ['Edit', '/proj/docs/changelog.md'],
  ]);
  assert.deepEqual(detectIntentDrift(model), []);
});

test('drift: reading around is not drifting — only edits count', () => {
  const model = promptSession(LOGIN_PROMPT, [
    ...onTask,
    ['Read', '/other/pkg/x.js'], ['Read', '/other/pkg/y.js'], ['Read', '/other/pkg/z.js'],
    ['Edit', '/proj/src/auth/login.js'],
  ]);
  assert.deepEqual(detectIntentDrift(model), []);
});

test('drift: coming back to the work area resets the count', () => {
  const model = promptSession(LOGIN_PROMPT, [
    ...onTask,
    ['Edit', '/far/one.js'],
    ['Edit', '/proj/src/auth/login.js'], // back on task
    ['Edit', '/far/two.js'],
    ['Edit', '/far/three.js'],
  ]);
  assert.deepEqual(detectIntentDrift(model), []);
});

test('drift: an excursion the agent returns from is not reported', () => {
  const model = promptSession(LOGIN_PROMPT, [
    ...onTask,
    ['Edit', '/proj/web/router/routes.js'],
    ['Edit', '/proj/web/router/table.js'],
    ['Edit', '/proj/web/router/mount.js'], // 3 drifted turns...
    ['Edit', '/proj/src/auth/login.js'],   // ...but it came back
  ]);
  assert.deepEqual(detectIntentDrift(model), []);
});

test('drift: a file and its test are one piece of work, not a departure', () => {
  const model = promptSession('Tighten the loop detector', [
    ['Read', '/proj/src/detect.js'], ['Edit', '/proj/src/detect.js'], ['Bash', null],
    ['Edit', '/proj/test/detect.test.js'],
    ['Edit', '/proj/test/detect.test.js'],
    ['Edit', '/proj/test/detect.test.js'],
  ]);
  assert.deepEqual(detectIntentDrift(model), []);
});

test('drift: a session with no prompt has nothing to drift from', () => {
  assert.deepEqual(detectIntentDrift(pureSpinSession(6)), []);
});

test('drift: driftEditTurns is configurable', () => {
  const model = promptSession(LOGIN_PROMPT, [
    ...onTask,
    ['Edit', '/proj/web/router/routes.js'],
    ['Edit', '/proj/web/router/table.js'],
    ['Bash', null],
  ]);
  assert.deepEqual(detectIntentDrift(model), []); // 2 drifted turns < driftEditTurns(3)
  const strict = detect(model, { thresholds: { driftEditTurns: 2 } });
  assert.ok(strict.some((f) => f.type === 'intent-drift'));
});

test('drift: the detector can be disabled like any other', () => {
  const model = promptSession(LOGIN_PROMPT, [
    ...onTask,
    ['Edit', '/proj/web/router/routes.js'],
    ['Edit', '/proj/web/router/table.js'],
    ['Edit', '/proj/web/router/mount.js'],
  ]);
  assert.ok(!detect(model, { disable: ['intent-drift'] }).some((f) => f.type === 'intent-drift'));
});
