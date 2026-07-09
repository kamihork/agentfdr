import { listProjects, resolveSession, projectsRoot } from './discover.js';
import { parseSessionFile, probeTitle } from './parser.js';
import { detect } from './detect.js';
import { blameReport, fmtMs } from './report.js';
import { startServer, openInBrowser } from './server.js';

const HELP = `agentfdr — flight data recorder for local coding agents

Usage:
  agentfdr list                 List recorded sessions (newest first)
  agentfdr open [session]       Open the timeline UI (default: newest session)
  agentfdr blame [session]      Print a markdown autopsy of a session
  agentfdr stats                Token totals across all projects

[session] is a session id, an id prefix, or a path to a transcript .jsonl.

Options:
  --port <n>      Port for \`open\` (default 4477)
  --no-browser    Don't auto-open the browser
  --json          Machine-readable output (list, blame)

Data source: ~/.claude/projects (override with AGENTFDR_CLAUDE_DIR)`;

export async function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--') && a !== portValue(args));
  const cmd = positional[0] ?? 'open';
  const ref = positional[1];

  switch (cmd) {
    case 'list':
      return cmdList(flags.has('--json'));
    case 'open':
      return cmdOpen(ref, Number(portValue(args) ?? 4477), !flags.has('--no-browser'));
    case 'blame':
      return cmdBlame(ref, flags.has('--json'));
    case 'stats':
      return cmdStats();
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      // Bare session ref: `agentfdr 35cb18` == `agentfdr open 35cb18`
      return cmdOpen(cmd, Number(portValue(args) ?? 4477), !flags.has('--no-browser'));
  }
}

function portValue(args) {
  const i = args.indexOf('--port');
  return i !== -1 ? args[i + 1] : undefined;
}

function cmdList(asJson) {
  const projects = listProjects();
  if (asJson) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }
  if (!projects.length) {
    console.log(`No sessions found under ${projectsRoot()}`);
    return;
  }
  for (const p of projects) {
    console.log(`\n${p.slug}`);
    for (const s of p.sessions.slice(0, 10)) {
      const title = probeTitle(s.file) ?? '(untitled)';
      const when = new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
      const mb = (s.size / 1024 / 1024).toFixed(1);
      console.log(`  ${s.id.slice(0, 8)}  ${when}  ${mb.padStart(5)}MB  ${title}`);
    }
  }
  console.log('\nOpen one with: agentfdr open <id-prefix>');
}

async function cmdOpen(ref, port, browse) {
  const { file, id } = resolveSession(ref);
  const { url } = await startServer({ port, initialSession: id });
  console.log(`agentfdr: recording deck at ${url}`);
  console.log(`          session ${id}`);
  console.log(`          (ctrl-c to stop)`);
  if (browse) openInBrowser(url);
}

function cmdBlame(ref, asJson) {
  const { file } = resolveSession(ref);
  const model = parseSessionFile(file);
  const flags = detect(model);
  if (asJson) {
    console.log(JSON.stringify({ session: model.session, totals: model.totals, flags }, null, 2));
    return;
  }
  console.log(blameReport(model, flags));
}

function cmdStats() {
  const projects = listProjects();
  let grand = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, sessions: 0, wallMs: 0 };
  const k = (n) => `${Math.round(n / 1000)}k`;
  for (const p of projects) {
    let tok = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let wall = 0;
    for (const s of p.sessions) {
      let model;
      try {
        model = parseSessionFile(s.file);
      } catch {
        continue;
      }
      for (const key of Object.keys(tok)) tok[key] += model.totals.tokens[key];
      wall += model.totals.wallMs ?? 0;
      grand.sessions++;
    }
    for (const key of ['input', 'output', 'cacheRead', 'cacheCreation']) grand[key] += tok[key];
    grand.wallMs += wall;
    console.log(
      `${p.slug}\n  sessions ${p.sessions.length}  wall ${fmtMs(wall)}  ` +
        `in ${k(tok.input)}  out ${k(tok.output)}  cache-read ${k(tok.cacheRead)}  cache-write ${k(tok.cacheCreation)}`
    );
  }
  console.log(
    `\nTOTAL  sessions ${grand.sessions}  wall ${fmtMs(grand.wallMs)}  ` +
      `in ${k(grand.input)}  out ${k(grand.output)}  cache-read ${k(grand.cacheRead)}  cache-write ${k(grand.cacheCreation)}`
  );
}
