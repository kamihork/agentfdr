// `agentfdr assert` — CI gate over a session. Each option becomes a check;
// the command exits non-zero if any check fails. Kept CLI-independent so it
// can be unit-tested.

import { estimateSessionCost } from './cost.js';

/** "2M" -> 2_000_000, "500k" -> 500_000, "1234" -> 1234. Null when absent/invalid. */
export function parseTokenCount(s) {
  if (s == null) return null;
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(String(s).trim());
  if (!m) return null;
  const mult = m[2] === '' ? 1 : /k/i.test(m[2]) ? 1_000 : 1_000_000;
  return Math.round(Number(m[1]) * mult);
}

/**
 * opts: { noLoops, noCritical, maxErrors, maxTurns, maxTokens, maxCost }
 * maxTokens counts what you pay full-ish price for: fresh input + cache write
 * + output (cache reads are ~10× cheaper and excluded).
 * Returns { ok, checks: [{ name, limit, actual, ok }] }.
 */
export function runAsserts(model, flags, opts) {
  const checks = [];
  const t = model.totals;
  const billedTokens = t.tokens.input + t.tokens.cacheCreation + t.tokens.output;

  if (opts.noLoops) {
    const n = flags.filter((f) => f.type === 'loop').length;
    checks.push({ name: 'no-loops', limit: 0, actual: n, ok: n === 0 });
  }
  if (opts.noCritical) {
    const n = flags.filter((f) => f.severity === 'critical').length;
    checks.push({ name: 'no-critical', limit: 0, actual: n, ok: n === 0 });
  }
  if (opts.maxErrors != null) {
    checks.push({ name: 'max-errors', limit: opts.maxErrors, actual: t.toolErrors, ok: t.toolErrors <= opts.maxErrors });
  }
  if (opts.maxTurns != null) {
    checks.push({ name: 'max-turns', limit: opts.maxTurns, actual: t.turns, ok: t.turns <= opts.maxTurns });
  }
  if (opts.maxTokens != null) {
    checks.push({ name: 'max-tokens', limit: opts.maxTokens, actual: billedTokens, ok: billedTokens <= opts.maxTokens });
  }
  if (opts.maxCost != null) {
    const { usd } = estimateSessionCost(model);
    // Unknown pricing fails the check rather than silently passing: a CI gate
    // that can't measure must not pretend it did.
    const actual = usd == null ? Infinity : usd;
    checks.push({ name: 'max-cost-usd', limit: opts.maxCost, actual: usd, ok: actual <= opts.maxCost });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
