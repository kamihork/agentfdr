import test from 'node:test';
import assert from 'node:assert/strict';
import { runAsserts, parseTokenCount } from '../src/assert.js';

const model = (over = {}) => ({
  session: { model: 'claude-opus-4-8' },
  turns: [],
  totals: {
    turns: 40,
    toolCalls: 100,
    toolErrors: 5,
    tokens: { input: 100_000, output: 50_000, cacheRead: 2_000_000, cacheCreation: 300_000 },
    ...over,
  },
});

test('parseTokenCount handles k/M suffixes', () => {
  assert.equal(parseTokenCount('2M'), 2_000_000);
  assert.equal(parseTokenCount('500k'), 500_000);
  assert.equal(parseTokenCount('1.5m'), 1_500_000);
  assert.equal(parseTokenCount('1234'), 1234);
  assert.equal(parseTokenCount('abc'), null);
  assert.equal(parseTokenCount(undefined), null);
});

test('no checks -> ok with empty list', () => {
  const r = runAsserts(model(), [], {});
  assert.equal(r.ok, true);
  assert.equal(r.checks.length, 0);
});

test('no-loops fails when a loop flag exists', () => {
  const flags = [{ type: 'loop', severity: 'critical' }];
  const r = runAsserts(model(), flags, { noLoops: true });
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].name, 'no-loops');
});

test('max-tokens counts fresh input + cache write + output', () => {
  // 100k + 300k + 50k = 450k billed-ish tokens; cacheRead excluded
  const pass = runAsserts(model(), [], { maxTokens: 500_000 });
  assert.equal(pass.ok, true);
  const fail = runAsserts(model(), [], { maxTokens: 400_000 });
  assert.equal(fail.ok, false);
});

test('max-errors and max-turns compare against totals', () => {
  const r = runAsserts(model(), [], { maxErrors: 4, maxTurns: 100 });
  assert.equal(r.ok, false);
  const byName = Object.fromEntries(r.checks.map((c) => [c.name, c.ok]));
  assert.equal(byName['max-errors'], false);
  assert.equal(byName['max-turns'], true);
});

test('max-cost fails when the model cannot be priced', () => {
  const m = model();
  m.turns = [{ model: 'unknown-model', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }];
  m.session.model = null;
  const r = runAsserts(m, [], { maxCost: 100 });
  assert.equal(r.ok, false);
});
