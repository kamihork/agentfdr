import { listProjects, resolveSession, projectsRoot } from './discover.js';
import { parseSessionFile, probeTitle } from './parser.js';
import { detect } from './detect.js';
import { blameReport, fmtMs } from './report.js';
import { startServer, openInBrowser } from './server.js';
import { resolveLang, t } from './i18n.js';
import { estimateSessionCost, fmtUsd } from './cost.js';
import { runAsserts, parseTokenCount } from './assert.js';
import { collectUsage, budgetPct } from './usage.js';

const HELP = `agentfdr — flight data recorder for local coding agents

Usage:
  agentfdr list                 List recorded sessions (newest first)
  agentfdr open [session]       Open the timeline UI (default: newest session)
  agentfdr watch [session]      Open the timeline UI in live mode (auto-refresh)
  agentfdr blame [session]      Print a markdown autopsy of a session
  agentfdr stats                Token totals + estimated cost across projects
  agentfdr usage                Plan usage: 5h window / daily / weekly burn, all projects
  agentfdr assert [session]     CI gate: exit 1 if the session violates limits

[session] is a session id, an id prefix, or a path to a transcript .jsonl.

Options:
  --port <n>          Port for \`open\`/\`watch\` (default 4477; next free if taken)
  --no-browser        Don't auto-open the browser
  --json              Machine-readable output (list, blame, assert)
  --lang <code>       Output language: en, ja (default: auto from LANG)

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

Data source: ~/.claude/projects (override with AGENTFDR_CLAUDE_DIR)`;

const VALUE_FLAGS = ['--port', '--lang', '--max-errors', '--max-turns', '--max-tokens', '--max-cost', '--days', '--budget-5h', '--budget-week'];

export async function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const values = new Set(VALUE_FLAGS.map((f) => flagValue(args, f)).filter(Boolean));
  const positional = args.filter((a) => !a.startsWith('--') && !values.has(a));
  const cmd = positional[0] ?? 'open';
  const ref = positional[1];
  const lang = resolveLang(flagValue(args, '--lang'));
  const port = Number(flagValue(args, '--port') ?? 4477);
  const browse = !flags.has('--no-browser');

  switch (cmd) {
    case 'list':
      return cmdList(flags.has('--json'), lang);
    case 'open':
      return cmdOpen(ref, port, browse, false);
    case 'watch':
      return cmdOpen(ref, port, browse, true);
    case 'blame':
      return cmdBlame(ref, flags.has('--json'), lang);
    case 'stats':
      return cmdStats();
    case 'usage':
      return cmdUsage(args, flags.has('--json'), lang);
    case 'assert':
      return cmdAssert(ref, args, flags.has('--json'));
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      // Bare session ref: `agentfdr 35cb18` == `agentfdr open 35cb18`
      return cmdOpen(cmd, port, browse, false);
  }
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function cmdList(asJson, lang) {
  const s = t(lang);
  const projects = listProjects();
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
      const title = probeTitle(sess.file) ?? s.untitled;
      const when = new Date(sess.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
      const mb = (sess.size / 1024 / 1024).toFixed(1);
      console.log(`  ${sess.id.slice(0, 8)}  ${when}  ${mb.padStart(5)}MB  ${title}`);
    }
  }
  console.log('\n' + s.openWith);
}

async function cmdOpen(ref, port, browse, live) {
  const { id } = resolveSession(ref);
  const { url, port: boundPort } = await startServer({ port, initialSession: id, live });
  if (boundPort !== port) console.log(`agentfdr: port ${port} in use, using ${boundPort}`);
  console.log(`agentfdr: recording deck at ${url}`);
  console.log(`          session ${id}${live ? '  (live)' : ''}`);
  console.log(`          (ctrl-c to stop)`);
  if (browse) openInBrowser(url);
}

function cmdBlame(ref, asJson, lang) {
  const { file } = resolveSession(ref);
  const model = parseSessionFile(file);
  const flags = detect(model);
  if (asJson) {
    const cost = estimateSessionCost(model);
    console.log(JSON.stringify({ session: model.session, totals: model.totals, cost, flags }, null, 2));
    return;
  }
  console.log(blameReport(model, flags, lang));
}

function cmdAssert(ref, args, asJson) {
  const { file, id } = resolveSession(ref);
  const model = parseSessionFile(file);
  const flags = detect(model);
  const opts = {
    noLoops: args.includes('--no-loops'),
    noCritical: args.includes('--no-critical'),
    maxErrors: numOrNull(flagValue(args, '--max-errors')),
    maxTurns: numOrNull(flagValue(args, '--max-turns')),
    maxTokens: parseTokenCount(flagValue(args, '--max-tokens')),
    maxCost: numOrNull(flagValue(args, '--max-cost')),
  };
  const result = runAsserts(model, flags, opts);

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

function cmdUsage(args, asJson, lang) {
  const s = t(lang);
  const days = numOrNull(flagValue(args, '--days')) ?? 14;
  const b5 = parseTokenCount(flagValue(args, '--budget-5h') ?? process.env.AGENTFDR_BUDGET_5H);
  const bw = parseTokenCount(flagValue(args, '--budget-week') ?? process.env.AGENTFDR_BUDGET_WEEK);
  const u = collectUsage({ days: Math.min(60, Math.max(1, days)) });

  if (asJson) {
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
    console.log(`  ${m.model}  ${s.turnsN(m.turns)}  ${kM(m.billed)} tok  ~${fmtUsd(m.usd)}`);
  }
  console.log(`\n${s.usageNote}`);
}

function cmdStats() {
  const projects = listProjects();
  let grand = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, sessions: 0, wallMs: 0, usd: 0 };
  const k = (n) => `${Math.round(n / 1000)}k`;
  for (const p of projects) {
    let tok = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let wall = 0;
    let usd = 0;
    for (const s of p.sessions) {
      let model;
      try {
        model = parseSessionFile(s.file);
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
