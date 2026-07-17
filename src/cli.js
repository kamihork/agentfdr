import { listAllProjects, resolveSession, projectsRoot } from './discover.js';
import { probeTitle } from './parser.js';
import { parseAnySessionFile, probeCodexTitle } from './codex.js';
import { detect } from './detect.js';
import { blameReport, fmtMs } from './report.js';
import { startServer, openInBrowser } from './server.js';
import { resolveLang, t } from './i18n.js';
import { estimateSessionCost, fmtUsd } from './cost.js';
import { runAsserts, parseTokenCount } from './assert.js';
import { collectUsage, budgetPct } from './usage.js';
import { diffSessions } from './diff.js';
import { loadConfig } from './config.js';
import { searchSessions } from './search.js';

const HELP = `agentfdr — flight data recorder for local coding agents

Usage:
  agentfdr list                 List recorded sessions (newest first)
  agentfdr open [session]       Open the timeline UI (default: newest session)
  agentfdr watch [session]      Open the timeline UI in live mode (auto-refresh)
  agentfdr blame [session]      Print a markdown autopsy of a session
  agentfdr diff <a> <b>         Compare two sessions (failed attempt vs retry)
  agentfdr search <query>       Full-text search across all sessions
  agentfdr stats                Token totals + estimated cost across projects
  agentfdr usage                Plan usage: 5h window / daily / weekly burn, all projects
  agentfdr assert [session]     CI gate: exit 1 if the session violates limits

[session] is a session id, an id prefix, or a path to a transcript .jsonl.

Options:
  --port <n>          Port for \`open\`/\`watch\` (default 4477; next free if taken)
  --no-browser        Don't auto-open the browser
  --json              Machine-readable output (list, blame, assert)
  --lang <code>       Output language: en, ja (default: auto from LANG)
  --config <path>     Detector config (default: ./.agentfdr.json, then ~/.agentfdr.json)
                      Thresholds, disabled detectors, loop suppressions, custom regex rules

Assert options (any combination; unset checks are skipped):
  --no-loops          Fail if a tool loop was detected
  --no-critical       Fail on any critical anomaly (loops, error streaks)
  --max-errors <n>    Fail if tool errors exceed n
  --max-turns <n>     Fail if turns exceed n
  --max-tokens <n>    Fail if fresh input + cache write + output tokens exceed n
                      (accepts suffixes: 500k, 2M)
  --max-cost <usd>    Fail if the estimated cost exceeds this (USD)

Usage options:
  --days <n>          Days of daily history to show (default 14)
  --budget-5h <n>     Token budget per 5h window, e.g. 3M (or AGENTFDR_BUDGET_5H)
  --budget-week <n>   Token budget per rolling week (or AGENTFDR_BUDGET_WEEK)
                      Exact plan limits are not published: calibrate these
                      against Claude Code's /usage screen.

Data sources: ~/.claude/projects (AGENTFDR_CLAUDE_DIR) and, when present,
              ~/.codex/sessions (AGENTFDR_CODEX_DIR)`;

const VALUE_FLAGS = ['--port', '--lang', '--max-errors', '--max-turns', '--max-tokens', '--max-cost', '--days', '--budget-5h', '--budget-week', '--config'];
const BOOL_FLAGS = ['--no-browser', '--json', '--no-loops', '--no-critical', '--help'];

/**
 * Sequential arg walk: a value flag consumes the NEXT token (or its `=` part),
 * so positionals can never be mistaken for flag values (`assert 50 --max-turns 50`
 * keeps the session ref "50"). Unknown flags and missing values are errors —
 * a mistyped flag must never silently disable a CI gate.
 */
export function parseArgs(args) {
  const flags = new Map(); // name -> string value, or true for booleans
  const positional = [];
  const errors = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (VALUE_FLAGS.includes(name)) {
      let v = eq !== -1 ? a.slice(eq + 1) : undefined;
      if (v === undefined && i + 1 < args.length && !args[i + 1].startsWith('--')) v = args[++i];
      if (v === undefined || v === '') errors.push(`${name} requires a value`);
      else flags.set(name, v);
    } else if (BOOL_FLAGS.includes(name)) {
      if (eq !== -1) errors.push(`${name} does not take a value`);
      else flags.set(name, true);
    } else {
      errors.push(`unknown option ${name}`);
    }
  }
  return { flags, positional, errors };
}

export async function main(argv) {
  const { flags, positional, errors } = parseArgs(argv.slice(2));
  if (errors.length) return usageError(errors);
  if (flags.has('--help')) {
    console.log(HELP);
    return;
  }
  const cmd = positional[0] ?? 'open';
  const ref = positional[1];
  const lang = resolveLang(flags.get('--lang'));

  const portRaw = flags.get('--port');
  const port = portRaw == null ? 4477 : Number(portRaw);
  if (portRaw != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return usageError([`--port must be a port number (1-65535), got "${portRaw}"`]);
  }
  const browse = !flags.has('--no-browser');

  let config;
  try {
    config = loadConfig(flags.get('--config'));
  } catch (err) {
    return usageError([err.message]);
  }

  switch (cmd) {
    case 'list':
      return cmdList(flags.has('--json'), lang);
    case 'open':
      return cmdOpen(ref, port, browse, false, config);
    case 'watch':
      return cmdOpen(ref, port, browse, true, config);
    case 'blame':
      return cmdBlame(ref, flags.has('--json'), lang, config);
    case 'diff':
      return cmdDiff(ref, positional[2], flags.has('--json'), lang, config);
    case 'search':
      return cmdSearch(positional.slice(1).join(' '), flags.has('--json'));
    case 'stats':
      return cmdStats();
    case 'usage':
      return cmdUsage(flags, lang);
    case 'assert':
      return cmdAssert(ref, flags, config);
    case 'help':
    case '-h':
      console.log(HELP);
      return;
    default:
      // Bare session ref: `agentfdr 35cb18` == `agentfdr open 35cb18`
      return cmdOpen(cmd, port, browse, false, config);
  }
}

/** Invalid invocation: report every problem and exit 2 (distinct from a failed gate's 1). */
function usageError(errors) {
  for (const e of errors) console.error(`agentfdr: ${e}`);
  console.error('run `agentfdr help` for usage');
  process.exitCode = 2;
}

function cmdList(asJson, lang) {
  const s = t(lang);
  const projects = listAllProjects();
  if (asJson) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  if (!projects.length) {
    console.log(s.noSessions(projectsRoot()));
    return;
  }
  for (const p of projects) {
    console.log(`\n${p.slug}`);
    for (const sess of p.sessions.slice(0, 10)) {
      const title = (p.agent === 'codex' ? probeCodexTitle(sess.file) : probeTitle(sess.file)) ?? s.untitled;
      const when = new Date(sess.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
      const mb = (sess.size / 1024 / 1024).toFixed(1);
      console.log(`  ${sess.id.slice(0, 8)}  ${when}  ${mb.padStart(5)}MB  ${title}`);
    }
  }
  console.log('\n' + s.openWith);
}

async function cmdOpen(ref, port, browse, live, config) {
  const { id } = resolveSession(ref);
  const { url, port: boundPort } = await startServer({ port, initialSession: id, live, config });
  if (boundPort !== port) console.log(`agentfdr: port ${port} in use, using ${boundPort}`);
  console.log(`agentfdr: recording deck at ${url}`);
  console.log(`          session ${id}${live ? '  (live)' : ''}`);
  console.log(`          (ctrl-c to stop)`);
  if (browse) openInBrowser(url);
}

function cmdBlame(ref, asJson, lang, config) {
  const { file } = resolveSession(ref);
  const model = parseAnySessionFile(file);
  const flags = detect(model, config);
  if (asJson) {
    const cost = estimateSessionCost(model);
    console.log(JSON.stringify({ session: model.session, totals: model.totals, cost, flags }, null, 2));
    return;
  }
  console.log(blameReport(model, flags, lang));
}

function cmdSearch(query, asJson) {
  if (!query || query.trim().length < 2) {
    return usageError(['search needs a query of at least 2 characters: agentfdr search <query>']);
  }
  const results = searchSessions(query.trim());
  if (asJson) {
    console.log(JSON.stringify({ query: query.trim(), results }, null, 2));
    return;
  }
  if (!results.length) {
    console.log('no matches');
    return;
  }
  for (const r of results) {
    const when = new Date(r.mtimeMs).toISOString().slice(0, 10);
    console.log(`\n${r.id.slice(0, 8)}  ${when}  ${r.title ?? '(untitled)'}  [${r.slug}]`);
    for (const m of r.matches) {
      console.log(`  t${String(m.t).padStart(3)}  ${m.w.padEnd(9)}  ${m.excerpt}`);
    }
  }
  console.log(`\nopen one with: agentfdr open <id-prefix>`);
}

function cmdDiff(refA, refB, asJson, lang, config) {
  const s = t(lang);
  if (!refA || !refB) return usageError(['diff needs two session refs: agentfdr diff <a> <b>']);
  const load = (ref) => {
    const { file } = resolveSession(ref);
    const model = parseAnySessionFile(file);
    return { model, flags: detect(model, config) };
  };
  const d = diffSessions(load(refA), load(refB));

  if (asJson) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  const kTok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n ?? 0));
  const label = (x, ref) => `${(x.id ?? ref).slice(0, 8)}${x.title ? `  ${x.title.slice(0, 40)}` : ''}`;
  console.log(`A: ${label(d.a, refA)}`);
  console.log(`B: ${label(d.b, refB)}`);
  console.log('');

  const rows = [
    [s.turns, d.a.stats.turns, d.b.stats.turns],
    [s.promptsLabel, d.a.stats.prompts, d.b.stats.prompts],
    [s.toolCalls, d.a.stats.toolCalls, d.b.stats.toolCalls],
    [s.errors, d.a.stats.toolErrors, d.b.stats.toolErrors],
    [s.wallTime, fmtMs(d.a.stats.wallMs), fmtMs(d.b.stats.wallMs)],
    [s.outputTokens, kTok(d.a.stats.outputTokens), kTok(d.b.stats.outputTokens)],
    [s.billedTokens, kTok(d.a.stats.billedTokens), kTok(d.b.stats.billedTokens)],
    [s.contextPeak, kTok(d.a.stats.contextPeak), kTok(d.b.stats.contextPeak)],
    [s.estCost, `~${fmtUsd(d.a.stats.estUsd)}`, `~${fmtUsd(d.b.stats.estUsd)}`],
    [s.anomalies, `${d.a.stats.anomalies} (${d.a.stats.critical} ${s.criticalShort})`, `${d.b.stats.anomalies} (${d.b.stats.critical} ${s.criticalShort})`],
  ];
  const w0 = Math.max(...rows.map((r) => String(r[0]).length));
  const w1 = Math.max(...rows.map((r) => String(r[1]).length), 1);
  for (const [k, a, b] of rows) {
    console.log(`  ${String(k).padEnd(w0)}  ${String(a).padStart(w1)}  →  ${b}`);
  }

  if (d.flags.length) {
    console.log(`\n${s.anomalies}:`);
    for (const f of d.flags) console.log(`  ${f.type.padEnd(14)}  ${String(f.a).padStart(3)}  →  ${f.b}`);
  }

  console.log(`\n${s.toolsLabel}:`);
  for (const tl of d.tools) console.log(`  ${tl.name.padEnd(14)}  ${String(tl.a).padStart(3)}  →  ${tl.b}`);

  const fileList = (arr, extra) => arr.map((f) => `    ${f}`).join('\n') + (extra ? `\n    … +${extra}` : '');
  if (d.files.both.length) console.log(`\n${s.filesBoth}:\n${fileList(d.files.both, d.files.truncated.both)}`);
  if (d.files.onlyA.length) console.log(`\n${s.filesOnly('A')}:\n${fileList(d.files.onlyA, d.files.truncated.onlyA)}`);
  if (d.files.onlyB.length) console.log(`\n${s.filesOnly('B')}:\n${fileList(d.files.onlyB, d.files.truncated.onlyB)}`);
}

function cmdAssert(ref, flags, config) {
  // A limit that was given but doesn't parse must be a hard error, never a
  // silently-skipped check — a CI gate that can't read its limit must not pass.
  const errors = [];
  const strict = (name, parse) => {
    const raw = flags.get(name);
    if (raw == null) return null;
    const v = parse(raw);
    if (v == null) errors.push(`${name}: cannot parse "${raw}"`);
    return v;
  };
  const opts = {
    noLoops: flags.has('--no-loops'),
    noCritical: flags.has('--no-critical'),
    maxErrors: strict('--max-errors', numOrNull),
    maxTurns: strict('--max-turns', numOrNull),
    maxTokens: strict('--max-tokens', parseTokenCount),
    maxCost: strict('--max-cost', numOrNull),
  };
  if (errors.length) return usageError(errors);

  const { file, id } = resolveSession(ref);
  const model = parseAnySessionFile(file);
  const detected = detect(model, config);
  const result = runAsserts(model, detected, opts);
  const asJson = flags.has('--json');

  if (asJson) {
    console.log(JSON.stringify({ session: id, ok: result.ok, checks: result.checks }, null, 2));
  } else if (!result.checks.length) {
    console.log('agentfdr assert: no checks given — see `agentfdr help`');
  } else {
    for (const c of result.checks) {
      const mark = c.ok ? 'PASS' : 'FAIL';
      console.log(`${mark}  ${c.name}  actual ${c.actual ?? '?'}  limit ${c.limit}`);
    }
    if (!result.ok) {
      const failed = result.checks.filter((c) => !c.ok);
      console.log(`\nagentfdr assert: ${failed.length} check(s) failed for session ${id.slice(0, 8)}`);
      console.log(`inspect with: agentfdr blame ${id.slice(0, 8)}`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cmdUsage(flags, lang) {
  const s = t(lang);
  const errors = [];
  const strict = (name, parse, fallback) => {
    const raw = flags.get(name) ?? fallback;
    if (raw == null) return null;
    const v = parse(raw);
    if (v == null) errors.push(`${name}: cannot parse "${raw}"`);
    return v;
  };
  const days = strict('--days', numOrNull) ?? 14;
  const b5 = strict('--budget-5h', parseTokenCount, process.env.AGENTFDR_BUDGET_5H);
  const bw = strict('--budget-week', parseTokenCount, process.env.AGENTFDR_BUDGET_WEEK);
  if (errors.length) return usageError(errors);
  const u = collectUsage({ days: Math.min(371, Math.max(1, days)) });

  if (flags.has('--json')) {
    console.log(JSON.stringify({ ...u, budgets: { fiveHour: b5, week: bw } }, null, 2));
    return;
  }

  const kM = (n) =>
    n >= 1_000_000 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
  const pctStr = (billed, budget) => {
    const p = budgetPct(billed, budget);
    return p == null ? '' : `  [${p}% / ${kM(budget)}]`;
  };
  const hm = (ts) => new Date(ts).toTimeString().slice(0, 5);

  if (u.plan.organizationType || u.plan.rateLimitTier) {
    console.log(`${s.plan}: ${[u.plan.organizationType, u.plan.rateLimitTier].filter(Boolean).join(' · ')}`);
  }
  const w = u.windows.current;
  if (w) {
    console.log(`${s.window5h} (${hm(w.startedAt)}–${hm(w.endsAt)}): ${kM(w.billed)} tok  ~${fmtUsd(w.usd)}${pctStr(w.billed, b5)}`);
  } else {
    console.log(`${s.window5h}: ${s.noActiveWindow}`);
  }
  console.log(`${s.today}: ${kM(u.today.billed)} tok  ~${fmtUsd(u.today.usd)}`);
  console.log(`${s.week7d}: ${kM(u.week.billed)} tok  ~${fmtUsd(u.week.usd)}${pctStr(u.week.billed, bw)}  (${s.windowsUsed(u.windows.count7d)})`);

  console.log(`\n${s.perDay}`);
  const maxBilled = Math.max(1, ...u.days.map((d) => d.billed));
  for (const d of u.days) {
    const bar = '▇'.repeat(Math.round((d.billed / maxBilled) * 24)) || '·';
    console.log(`  ${d.date}  ${bar.padEnd(25)} ${kM(d.billed).padStart(7)}  ~${fmtUsd(d.usd)}`);
  }

  console.log(`\n${s.perModel}`);
  for (const m of u.models) {
    console.log(`  ${m.model}  ${s.turnsN(m.turns)}  ${kM(m.billed)} tok  ${m.unpriced ? '~$?' : '~' + fmtUsd(m.usd)}`);
  }
  if (u.unknownModels.length) console.log(`\n${s.unknownModels(u.unknownModels.join(', '))}`);
  console.log(`\n${s.usageNote}`);
}

function cmdStats() {
  const projects = listAllProjects();
  let grand = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, sessions: 0, wallMs: 0, usd: 0 };
  const k = (n) => `${Math.round(n / 1000)}k`;
  for (const p of projects) {
    let tok = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let wall = 0;
    let usd = 0;
    for (const s of p.sessions) {
      let model;
      try {
        model = parseAnySessionFile(s.file);
      } catch {
        continue;
      }
      for (const key of Object.keys(tok)) tok[key] += model.totals.tokens[key];
      wall += model.totals.wallMs ?? 0;
      usd += estimateSessionCost(model).usd ?? 0;
      grand.sessions++;
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheCreation']) grand[key] += tok[key];
    grand.wallMs += wall;
    grand.usd += usd;
    console.log(
      `${p.slug}\n  sessions ${p.sessions.length}  wall ${fmtMs(wall)}  ~${fmtUsd(usd)}  ` +
        `in ${k(tok.input)}  out ${k(tok.output)}  cache-read ${k(tok.cacheRead)}  cache-write ${k(tok.cacheCreation)}`
    );
  }
  console.log(
    `\nTOTAL  sessions ${grand.sessions}  wall ${fmtMs(grand.wallMs)}  ~${fmtUsd(grand.usd)}  ` +
      `in ${k(grand.input)}  out ${k(grand.output)}  cache-read ${k(grand.cacheRead)}  cache-write ${k(grand.cacheCreation)}`
  );
  console.log('(cost is an estimate from list prices; cache read ≈0.1×, cache write ≈1.25× input price)');
}
