// Detector configuration — .agentfdr.json (JSON, not YAML, to keep the
// zero-runtime-dependency promise).
//
// {
//   "thresholds": { "loopRepeats": 5, "contextBloatChars": 100000, ... },
//   "disable": ["cache-thrash"],
//   "suppressLoops": ["Bash:npm test", "Edit:*"],
//   "custom": [
//     { "name": "quota-masked", "match": "quota exceeded|rate_limit",
//       "in": "tool-results", "severity": "critical" }
//   ]
// }
//
// Lookup order: --config <path> > ./.agentfdr.json > ~/.agentfdr.json.
// A malformed config is a hard error, never silently ignored — a CI gate
// running with half its rules dropped must not pretend it's configured.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_THRESHOLDS = {
  loopRepeats: 3,        // same n-gram repeated this many times consecutively
  loopMinCalls: 6,       // ...covering at least this many calls
  errorStreak: 3,        // consecutive failing tool calls
  contextBloatChars: 50_000,
  tokenSpikeTokens: 50_000,
  tokenSpikeRatio: 1.6,
  cacheThrashTurns: 2,
  fileChurnEdits: 6,
};

const DETECTOR_TYPES = [
  'loop', 'error-streak', 'context-bloat', 'token-spike',
  'cache-thrash', 'file-churn', 'refusal', 'stalled-call', 'api-error',
];
const CUSTOM_TARGETS = ['tool-results', 'assistant-text', 'both'];

/** Returns { path, thresholds, disable, suppressLoops, custom }. Throws on invalid config. */
export function loadConfig(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : [join(process.cwd(), '.agentfdr.json'), join(homedir(), '.agentfdr.json')];

  for (const p of candidates) {
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch (err) {
      if (!explicitPath && err.code === 'ENOENT') continue;
      throw new Error(`config ${p}: ${err.message}`);
    }
    return { ...validate(p, text), path: p };
  }
  return { path: null, thresholds: {}, disable: [], suppressLoops: [], custom: [] };
}

function validate(path, text) {
  const fail = (msg) => {
    throw new Error(`config ${path}: ${msg}`);
  };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`invalid JSON — ${err.message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('top level must be an object');

  const thresholds = raw.thresholds ?? {};
  for (const [k, v] of Object.entries(thresholds)) {
    if (!(k in DEFAULT_THRESHOLDS)) fail(`unknown threshold "${k}" (known: ${Object.keys(DEFAULT_THRESHOLDS).join(', ')})`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`threshold "${k}" must be a positive number`);
  }

  const disable = raw.disable ?? [];
  if (!Array.isArray(disable)) fail('"disable" must be an array');
  for (const d of disable) {
    if (!DETECTOR_TYPES.includes(d)) fail(`unknown detector in "disable": "${d}" (known: ${DETECTOR_TYPES.join(', ')})`);
  }

  const suppressLoops = raw.suppressLoops ?? [];
  if (!Array.isArray(suppressLoops) || suppressLoops.some((s) => typeof s !== 'string' || !s)) {
    fail('"suppressLoops" must be an array of non-empty strings');
  }

  const custom = raw.custom ?? [];
  if (!Array.isArray(custom)) fail('"custom" must be an array');
  custom.forEach((rule, i) => {
    const at = `custom[${i}]`;
    if (typeof rule !== 'object' || rule === null) fail(`${at} must be an object`);
    if (typeof rule.name !== 'string' || !rule.name) fail(`${at}.name is required`);
    if (typeof rule.match !== 'string' || !rule.match) fail(`${at}.match (a regex) is required`);
    try {
      new RegExp(rule.match, rule.flags ?? 'i');
    } catch (err) {
      fail(`${at}.match is not a valid regex — ${err.message}`);
    }
    if (rule.in != null && !CUSTOM_TARGETS.includes(rule.in)) fail(`${at}.in must be one of: ${CUSTOM_TARGETS.join(', ')}`);
    if (rule.severity != null && !['critical', 'warning'].includes(rule.severity)) {
      fail(`${at}.severity must be "critical" or "warning"`);
    }
  });

  return { thresholds, disable, suppressLoops, custom };
}
