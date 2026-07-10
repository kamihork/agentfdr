// Estimated API cost for a session, from published per-MTok prices.
//
// This is an ESTIMATE and clearly labeled as such in every surface that shows
// it: prices change, orgs have discounts/credits, and batch/priority tiers
// differ. Unknown models contribute zero and are reported so the UI can say
// "partial". Prices as of 2026-06 (platform.claude.com/docs/en/pricing).

// [pattern, { in: $/MTok input, out: $/MTok output }] — first match wins.
// Cache read ≈ 0.1× input price; cache write (5m TTL) ≈ 1.25× input price.
const PRICE_TABLE = [
  [/fable-5|mythos/, { in: 10, out: 50 }],
  [/opus-4-[5-9]/, { in: 5, out: 25 }],
  [/opus-4-[01]|opus-4-2025|3-opus/, { in: 15, out: 75 }],
  [/sonnet/, { in: 3, out: 15 }],
  [/haiku-4/, { in: 1, out: 5 }],
  [/3-5-haiku/, { in: 0.8, out: 4 }],
  [/haiku/, { in: 0.25, out: 1.25 }],
];

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

export function priceFor(model) {
  if (typeof model !== 'string') return null;
  for (const [re, price] of PRICE_TABLE) {
    if (re.test(model)) return price;
  }
  return null;
}

/** USD for one turn's usage on the given model, or null if the model is unknown. */
export function costForUsage(model, usage) {
  const p = priceFor(model);
  if (!p) return null;
  return (
    (usage.input * p.in +
      usage.output * p.out +
      usage.cacheRead * p.in * CACHE_READ_MULT +
      usage.cacheCreation * p.in * CACHE_WRITE_MULT) /
    1_000_000
  );
}

/**
 * Estimated cost of a whole session. Per-turn models are used when present
 * (sessions can switch models); turns with an unknown model contribute zero
 * and their model name is reported in unknownModels.
 * Returns { usd, byComponent, unknownModels } — usd is null only when NO turn
 * could be priced.
 */
export function estimateSessionCost(model) {
  const by = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const unknown = new Set();
  let priced = false;
  for (const turn of model.turns) {
    const m = turn.model ?? model.session.model;
    const p = priceFor(m);
    if (!p) {
      // Zero-usage pseudo-models (e.g. "<synthetic>") shouldn't mark the
      // estimate as partial — nothing priceable was consumed.
      const u = turn.usage;
      if (m && (u.input + u.output + u.cacheRead + u.cacheCreation) > 0) unknown.add(m);
      continue;
    }
    priced = true;
    by.input += (turn.usage.input * p.in) / 1_000_000;
    by.output += (turn.usage.output * p.out) / 1_000_000;
    by.cacheRead += (turn.usage.cacheRead * p.in * CACHE_READ_MULT) / 1_000_000;
    by.cacheCreation += (turn.usage.cacheCreation * p.in * CACHE_WRITE_MULT) / 1_000_000;
  }
  const usd = priced ? by.input + by.output + by.cacheRead + by.cacheCreation : null;
  return { usd, byComponent: by, unknownModels: [...unknown] };
}

export function fmtUsd(usd) {
  if (usd == null) return '?';
  if (usd >= 100) return '$' + Math.round(usd);
  if (usd >= 1) return '$' + usd.toFixed(2);
  return '$' + usd.toFixed(3);
}
