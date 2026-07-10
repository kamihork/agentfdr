// Cross-project usage aggregation — "how much of my plan am I burning?"
//
// Claude subscription plans meter usage over a 5-hour rolling window and a
// weekly window. The exact token budgets are not published and not stored
// locally, but the transcripts contain every turn's usage with timestamps, so
// we can reconstruct consumption in the same shape and let the user calibrate
// budgets against what Claude Code's /usage screen shows.
//
// "billed" here = fresh input + cache write + output — the tokens you pay
// full-ish price for (cache reads are ~10x cheaper and excluded), same metric
// as `agentfdr assert --max-tokens`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listProjects } from './discover.js';
import { parseSessionFile } from './parser.js';
import { priceFor } from './cost.js';

const WINDOW_MS = 5 * 60 * 60 * 1000; // Claude's session window
const DAY_MS = 24 * 60 * 60 * 1000;

/** Plan info recorded by Claude Code locally (best-effort; null when absent). */
export function planInfo(claudeJsonPath = join(homedir(), '.claude.json')) {
  try {
    const d = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
    const oa = d.oauthAccount ?? {};
    return {
      organizationType: oa.organizationType ?? null, // e.g. "claude_max"
      rateLimitTier: oa.userRateLimitTier ?? oa.organizationRateLimitTier ?? null, // e.g. "default_claude_max_5x"
    };
  } catch {
    return { organizationType: null, rateLimitTier: null };
  }
}

const billedOf = (u) => u.input + u.cacheCreation + u.output;

/**
 * Aggregate usage across every recorded session.
 * opts: { days, now, loadModel } — loadModel lets the server reuse its parse cache.
 * Returns { days: [{date, billed, tokens, usd}...oldest first],
 *           today, week, windows: { current, last, count7d }, models, plan }
 */
export function collectUsage({ days = 14, now = Date.now(), loadModel = parseSessionFile, root } = {}) {
  const events = []; // { ts, model, usage }
  for (const p of listProjects(root)) {
    for (const s of p.sessions) {
      let model;
      try {
        model = loadModel(s.file);
      } catch {
        continue;
      }
      for (const t of model.turns) {
        const ts = t.timestamp ? Date.parse(t.timestamp) : NaN;
        if (!Number.isFinite(ts)) continue;
        events.push({ ts, model: t.model ?? model.session.model, usage: t.usage });
      }
    }
  }
  events.sort((a, b) => a.ts - b.ts);

  const emptyBucket = () => ({
    billed: 0,
    usd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  });
  const accumulate = (b, e) => {
    b.billed += billedOf(e.usage);
    b.usd += usdOf(e.model, e.usage);
    for (const k of Object.keys(b.tokens)) b.tokens[k] += e.usage[k];
  };

  // Daily buckets (local time), oldest first.
  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dayBuckets = new Map();
  for (let i = days - 1; i >= 0; i--) dayBuckets.set(dayKey(now - i * DAY_MS), emptyBucket());

  const today = emptyBucket();
  const week = emptyBucket();
  const modelTotals = new Map();
  const todayKey = dayKey(now);

  for (const e of events) {
    const key = dayKey(e.ts);
    if (dayBuckets.has(key)) accumulate(dayBuckets.get(key), e);
    if (key === todayKey) accumulate(today, e);
    if (now - e.ts <= 7 * DAY_MS) accumulate(week, e);
    const mt = modelTotals.get(e.model ?? '?') ?? { ...emptyBucket(), turns: 0 };
    accumulate(mt, e);
    mt.turns++;
    modelTotals.set(e.model ?? '?', mt);
  }

  return {
    days: [...dayBuckets].map(([date, b]) => ({ date, ...b })),
    today,
    week,
    windows: reconstructWindows(events, now, emptyBucket, accumulate),
    models: [...modelTotals]
      .map(([model, b]) => ({ model, ...b }))
      .sort((a, b) => b.billed - a.billed),
    plan: planInfo(),
  };
}

/**
 * Reconstruct Claude's 5-hour session windows: a window opens at the first
 * activity after the previous window expired and lasts exactly 5 hours.
 * This mirrors the plan's metering structure (approximation: the server's
 * clock and edge cases may differ).
 */
function reconstructWindows(events, now, emptyBucket, accumulate) {
  let current = null;
  let last = null;
  let count7d = 0;
  for (const e of events) {
    if (!current || e.ts >= current.endsAt) {
      last = current;
      current = { startedAt: e.ts, endsAt: e.ts + WINDOW_MS, ...emptyBucket() };
      if (now - e.ts <= 7 * DAY_MS) count7d++;
    }
    accumulate(current, e);
  }
  return {
    current: current && now < current.endsAt ? current : null, // null when expired
    last: current && now >= current.endsAt ? current : last,
    count7d,
  };
}

function usdOf(model, usage) {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    (usage.input * p.in + usage.output * p.out +
      usage.cacheRead * p.in * 0.1 + usage.cacheCreation * p.in * 1.25) / 1_000_000
  );
}

/** Percentage against an optional budget; null when no budget configured. */
export function budgetPct(billed, budget) {
  if (!budget || budget <= 0) return null;
  return Math.round((billed / budget) * 100);
}
