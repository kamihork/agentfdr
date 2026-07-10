import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectUsage, budgetPct, planInfo } from '../src/usage.js';

const H = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-10T12:00:00');

function assistantLine(ts, usage = {}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'u' + ts,
    timestamp: new Date(ts).toISOString(),
    sessionId: 'sess-1',
    message: {
      id: 'msg_' + ts,
      model: usage.model ?? 'claude-opus-4-8',
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: usage.input ?? 1000,
        output_tokens: usage.output ?? 500,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheCreation ?? 0,
      },
    },
  });
}

/** Write a fake projects root with one session containing the given lines. */
function fakeRoot(lines) {
  const root = mkdtempSync(join(tmpdir(), 'agentfdr-usage-'));
  const proj = join(root, '-tmp-proj');
  mkdirSync(proj);
  writeFileSync(join(proj, 'aaaa-bbbb.jsonl'), lines.join('\n'));
  return root;
}

test('reconstructs 5h windows: gap > window opens a new one', () => {
  // Three turns: two inside one window, a third 6h later -> second window.
  const root = fakeRoot([
    assistantLine(NOW - 8 * H),
    assistantLine(NOW - 7 * H),
    assistantLine(NOW - 1 * H),
  ]);
  const u = collectUsage({ now: NOW, root });
  assert.equal(u.windows.count7d, 2);
  // Current window opened 1h ago and is still active.
  assert.ok(u.windows.current);
  assert.equal(u.windows.current.startedAt, NOW - 1 * H);
  assert.equal(u.windows.current.billed, 1500); // 1000 in + 500 out
  // Previous window captured both early turns.
  assert.equal(u.windows.last.billed, 3000);
});

test('no active window when the last one expired', () => {
  const root = fakeRoot([assistantLine(NOW - 6 * H)]);
  const u = collectUsage({ now: NOW, root });
  assert.equal(u.windows.current, null);
  assert.equal(u.windows.last.billed, 1500);
});

test('daily buckets and week totals count billed tokens', () => {
  const root = fakeRoot([
    assistantLine(NOW - 26 * H, { input: 100, output: 0, cacheCreation: 50 }), // yesterday (or day before)
    assistantLine(NOW - 1 * H, { input: 200, output: 100, cacheRead: 999999 }), // today; cacheRead excluded from billed
  ]);
  const u = collectUsage({ now: NOW, days: 3, root });
  assert.equal(u.days.length, 3);
  assert.equal(u.today.billed, 300);
  assert.equal(u.week.billed, 450);
  assert.equal(u.days.at(-1).billed, 300); // newest bucket = today
  // usd priced on opus-4-8; cache read contributes cost but not billed tokens
  assert.ok(u.week.usd > 0);
});

test('per-model totals aggregate across turns', () => {
  const root = fakeRoot([
    assistantLine(NOW - 2 * H, { model: 'claude-opus-4-8' }),
    assistantLine(NOW - 1 * H, { model: 'claude-haiku-4-5' }),
    assistantLine(NOW - 0.5 * H, { model: 'claude-haiku-4-5' }),
  ]);
  const u = collectUsage({ now: NOW, root });
  const haiku = u.models.find((m) => m.model === 'claude-haiku-4-5');
  assert.equal(haiku.turns, 2);
  assert.equal(haiku.billed, 3000);
});

test('budgetPct and planInfo fallbacks', () => {
  assert.equal(budgetPct(500_000, 1_000_000), 50);
  assert.equal(budgetPct(500_000, null), null);
  const p = planInfo('/nonexistent/path.json');
  assert.deepEqual(p, { organizationType: null, rateLimitTier: null });
});
