import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costForUsage, estimateSessionCost, fmtUsd } from '../src/cost.js';

test('priceFor matches model families', () => {
  assert.deepEqual(priceFor('claude-fable-5'), { in: 10, out: 50 });
  assert.deepEqual(priceFor('claude-opus-4-8'), { in: 5, out: 25 });
  assert.deepEqual(priceFor('claude-opus-4-5-20251101'), { in: 5, out: 25 });
  assert.deepEqual(priceFor('claude-opus-4-1-20250805'), { in: 15, out: 75 });
  assert.deepEqual(priceFor('claude-sonnet-4-6'), { in: 3, out: 15 });
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), { in: 1, out: 5 });
  assert.deepEqual(priceFor('gpt-5-codex'), { in: 1.25, out: 10 }); // Codex CLI models
  assert.deepEqual(priceFor('gpt-4o'), { in: 2.5, out: 10 });
  assert.equal(priceFor('some-local-model'), null);
  assert.equal(priceFor(null), null);
});

test('costForUsage applies cache multipliers', () => {
  // 1M of each bucket on opus-4-8 ($5 in / $25 out):
  // in 5 + out 25 + cacheRead 0.5 + cacheWrite 6.25 = 36.75
  const usd = costForUsage('claude-opus-4-8', {
    input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000,
  });
  assert.ok(Math.abs(usd - 36.75) < 1e-9);
});

test('estimateSessionCost prices per-turn models and reports unknowns', () => {
  const turn = (model, usage) => ({ model, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, ...usage } });
  const model = {
    session: { model: 'claude-opus-4-8' },
    turns: [
      turn('claude-opus-4-8', { output: 1_000_000 }),   // $25
      turn('claude-haiku-4-5', { output: 1_000_000 }),  // $5
      turn('weird-model-x', { output: 1_000_000 }),     // unknown, skipped
      turn(null, { input: 1_000_000 }),                  // falls back to session model: $5
    ],
  };
  const { usd, unknownModels } = estimateSessionCost(model);
  assert.ok(Math.abs(usd - 35) < 1e-9);
  assert.deepEqual(unknownModels, ['weird-model-x']);
});

test('estimateSessionCost is null when nothing can be priced', () => {
  const model = { session: { model: null }, turns: [{ model: 'x', usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } }] };
  assert.equal(estimateSessionCost(model).usd, null);
});

test('fmtUsd picks sensible precision', () => {
  assert.equal(fmtUsd(123.4), '$123');
  assert.equal(fmtUsd(12.345), '$12.35');
  assert.equal(fmtUsd(0.1234), '$0.123');
  assert.equal(fmtUsd(null), '?');
});
