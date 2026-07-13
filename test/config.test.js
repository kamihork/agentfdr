import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { parseSessionText } from '../src/parser.js';
import { detect, detectStalledCalls, detectApiErrors, detectCustom } from '../src/detect.js';

const dir = mkdtempSync(join(tmpdir(), 'agentfdr-config-'));
const write = (name, obj) => {
  const p = join(dir, name);
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
};

// --- config loading ---------------------------------------------------------

test('explicit config path loads and validates', () => {
  const p = write('ok.json', {
    thresholds: { loopRepeats: 5 },
    disable: ['cache-thrash'],
    suppressLoops: ['Bash:npm test', 'Edit:*'],
    custom: [{ name: 'quota', match: 'quota exceeded' }],
  });
  const c = loadConfig(p);
  assert.equal(c.path, p);
  assert.equal(c.thresholds.loopRepeats, 5);
  assert.deepEqual(c.disable, ['cache-thrash']);
});

test('missing explicit config is a hard error', () => {
  assert.throws(() => loadConfig(join(dir, 'nope.json')), /config .*nope/);
});

test('malformed JSON is a hard error, never silently ignored', () => {
  const p = write('bad.json', '{ oops');
  assert.throws(() => loadConfig(p), /invalid JSON/);
});

test('unknown threshold and bad regex are rejected with clear messages', () => {
  assert.throws(() => loadConfig(write('t.json', { thresholds: { loopz: 3 } })), /unknown threshold "loopz"/);
  assert.throws(() => loadConfig(write('r.json', { custom: [{ name: 'x', match: '(' }] })), /not a valid regex/);
  assert.throws(() => loadConfig(write('d.json', { disable: ['nope'] })), /unknown detector/);
});

// --- fixtures ----------------------------------------------------------------

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

/** 6 repeated failing test runs — a loop by default thresholds. */
function loopSession() {
  const lines = [];
  for (let i = 0; i < 6; i++) {
    lines.push(aLine(i, 'm' + i, [{ type: 'tool_use', id: 't' + i, name: 'Bash', input: { command: 'npm test' } }]));
    lines.push(rLine(i + 100, 't' + i, 'FAIL', false));
  }
  return parseSessionText(lines.join('\n'));
}

// --- config-driven detection -------------------------------------------------

test('suppressLoops silences legitimate retry loops (exact and wildcard)', () => {
  const model = loopSession();
  assert.ok(detect(model).some((f) => f.type === 'loop')); // baseline: flagged
  const exact = detect(model, { suppressLoops: ['Bash:npm test'] });
  assert.ok(!exact.some((f) => f.type === 'loop'));
  const wild = detect(model, { suppressLoops: ['Bash:*'] });
  assert.ok(!wild.some((f) => f.type === 'loop'));
});

test('threshold overrides change detection', () => {
  const model = loopSession(); // 6 repeats
  const strict = detect(model, { thresholds: { loopRepeats: 7, loopMinCalls: 7 } });
  assert.ok(!strict.some((f) => f.type === 'loop'));
});

test('disable turns a detector off entirely', () => {
  const model = loopSession();
  const flags = detect(model, { disable: ['loop'] });
  assert.ok(!flags.some((f) => f.type === 'loop'));
});

// --- new detectors -----------------------------------------------------------

test('stalled call: no result + session moved on → flagged; final turn exempt', () => {
  const model = parseSessionText([
    aLine(0, 'm0', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'sleep 999' } }]),
    // no result for 'a', but the session continues
    aLine(1, 'm1', [{ type: 'text', text: 'moving on' }]),
    // final turn with a pending call — a live session, not stalled
    aLine(2, 'm2', [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/x' } }]),
  ].join('\n'));
  const flags = detectStalledCalls(model);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].turnStart, 0);
});

test('api-error: only error results with strong API shapes', () => {
  const model = parseSessionText([
    aLine(0, 'm0', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'curl api' } }]),
    rLine(100, 'a', 'HTTP 429 rate_limit_error: too many requests', true),
    aLine(1, 'm1', [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/docs' } }]),
    // mentions rate limits but is NOT an error result — must not flag
    rLine(101, 'b', 'The docs explain rate_limit_error handling...', false),
    aLine(2, 'm2', [{ type: 'text', text: 'done' }]),
  ].join('\n'));
  const flags = detectApiErrors(model);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].params.name, 'Bash');
});

test('custom rules match tool results and carry the rule name', () => {
  const model = parseSessionText([
    aLine(0, 'm0', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'x' } }]),
    rLine(100, 'a', 'You have reached your monthly limit', false),
    aLine(1, 'm1', [{ type: 'text', text: 'hmm' }]),
  ].join('\n'));
  const flags = detectCustom(model, [
    { name: 'quota-masked', match: 'monthly limit', severity: 'critical' },
  ]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].type, 'custom');
  assert.equal(flags[0].title, 'quota-masked');
  assert.equal(flags[0].severity, 'critical');
});
