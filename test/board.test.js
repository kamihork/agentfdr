import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRegistry, readTail, summarizeTail, classify, collectBoard, findOverlaps,
  buildSendCommands, sendToSession, resolveRepo, readHistoryIndex,
} from '../src/board.js';
import { isSameOrigin } from '../src/server.js';

const T0 = Date.parse('2026-03-01T12:00:00Z');
const ts = (i) => new Date(T0 + i * 1000).toISOString();

const assistant = (i, mid, blocks, extra = {}) => JSON.stringify({
  type: 'assistant', uuid: 'u' + i, timestamp: ts(i), sessionId: 's', cwd: '/repo/app', gitBranch: 'main', ...extra,
  message: { id: mid, model: 'claude-opus-5', role: 'assistant', content: blocks, stop_reason: extra.stop ?? null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 10 } },
});
const userLine = (i, text) => JSON.stringify({
  type: 'user', uuid: 'p' + i, timestamp: ts(i), sessionId: 's', cwd: '/repo/app', message: { role: 'user', content: text },
});
const result = (i, id, isError = false) => JSON.stringify({
  type: 'user', uuid: 'r' + i, timestamp: ts(i), sessionId: 's',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'boom' : 'ok', is_error: isError }] },
});
const lastPromptLine = (text) => JSON.stringify({ type: 'last-prompt', lastPrompt: text, sessionId: 's' });

// A session: prompt, an Edit that finished, then a Bash call still running.
const LIVE_LINES = [
  userLine(0, 'fix the login bug'),
  assistant(1, 'm1', [{ type: 'tool_use', id: 'c1', name: 'Edit', input: { file_path: '/repo/app/src/login.js' } }], { stop: 'tool_use' }),
  result(2, 'c1'),
  assistant(3, 'm2', [{ type: 'text', text: 'Now running the tests.' }, { type: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'npm test' } }], { stop: 'tool_use' }),
];

/** A fake ~/.claude: projects/<slug>/<id>.jsonl, sessions/<pid>.json, history.jsonl. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'agentfdr-board-'));
  mkdirSync(join(home, 'projects'), { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const transcript = (slug, id, lines) => {
    const dir = join(home, 'projects', slug);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.join('\n') + '\n');
    return file;
  };
  const registry = (pid, entry) => writeFileSync(join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, ...entry }));
  const history = (entries) => writeFileSync(join(home, 'history.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { home, transcript, registry, history };
}

// --- registry -----------------------------------------------------------------

test('readRegistry parses entries defensively and probes liveness', () => {
  const { home, registry } = fakeHome();
  registry(100, { sessionId: 'a', cwd: '/x', status: 'busy', tmux: 'sess:@1.%1', entrypoint: 'cli', kind: 'interactive' });
  registry(200, { sessionId: 'b', cwd: '/y', entrypoint: 'claude-desktop' }); // no status, no tmux
  writeFileSync(join(home, 'sessions', '300.json'), '{ not json');
  writeFileSync(join(home, 'sessions', 'notes.json'), JSON.stringify({ pid: 'x' }));
  const reg = readRegistry({ root: join(home, 'sessions'), isAlive: (pid) => pid === 100 });
  assert.equal(reg.length, 2);
  const a = reg.find((e) => e.pid === 100);
  assert.equal(a.alive, true);
  assert.equal(a.status, 'busy');
  assert.equal(a.tmux, 'sess:@1.%1');
  const b = reg.find((e) => e.pid === 200);
  assert.equal(b.alive, false);
  assert.equal(b.status, null);
  assert.equal(b.tmux, null);
  assert.equal(b.entrypoint, 'claude-desktop');
});

// --- tail ---------------------------------------------------------------------

test('readTail drops the partial first line and flags truncation', () => {
  const { transcript } = fakeHome();
  const file = transcript('p', 'id1', LIVE_LINES);
  const whole = readTail(file, 10 * 1024 * 1024);
  assert.equal(whole.truncated, false);
  assert.equal(whole.text.split('\n').filter(Boolean).length, 4);
  const part = readTail(file, 300);
  assert.equal(part.truncated, true);
  // every surviving line is complete JSON
  for (const l of part.text.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(l));
});

test('summarizeTail parses a fragment and recovers the last-prompt record', () => {
  const text = [
    assistant(1, 'm1', [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }], { stop: 'tool_use' }),
    result(2, 'c1'),
    lastPromptLine('the prompt that scrolled away'),
  ].join('\n');
  const s = summarizeTail(text, { truncated: true });
  assert.equal(s.model.turns.length, 1);
  assert.equal(s.model.prompts.length, 0);
  assert.equal(s.lastPromptRecord, 'the prompt that scrolled away');
});

// --- classification -----------------------------------------------------------------

test('classify trusts the registry status when present', () => {
  assert.deepEqual(classify({ status: 'waiting', waitingFor: 'permission prompt' }, null), { state: 'waiting', waitingFor: 'permission prompt', derived: false });
  assert.equal(classify({ status: 'busy' }, null).state, 'busy');
  assert.equal(classify({ status: 'idle' }, null).state, 'idle');
  assert.equal(classify({ status: 'shell' }, null).state, 'idle');
  assert.equal(classify({ status: null }, null).state, 'unknown');
});

test('classify derives state from the transcript tail when the registry is silent', () => {
  const now = T0 + 100_000;
  const pendingTail = { model: summarizeTail(LIVE_LINES.join('\n')).model, mtimeMs: now - 5_000 };
  assert.deepEqual(classify({ status: null }, pendingTail, { now }), { state: 'busy', waitingFor: null, derived: true });
  const quietTail = { ...pendingTail, mtimeMs: now - 5 * 60_000 };
  const q = classify({ status: null }, quietTail, { now });
  assert.equal(q.state, 'waiting');
  assert.equal(q.derived, true);

  const doneLines = [userLine(0, 'hi'), assistant(1, 'm1', [{ type: 'text', text: 'done' }], { stop: 'end_turn' })];
  const doneTail = { model: summarizeTail(doneLines.join('\n')).model, mtimeMs: now - 1000 };
  assert.equal(classify({ status: null }, doneTail, { now }).state, 'idle');
});

// --- the board -----------------------------------------------------------------------

test('collectBoard joins registry, transcript tail, history and overlaps', () => {
  const { home, transcript, registry, history } = fakeHome();
  process.env.AGENTFDR_CLAUDE_DIR = join(home, 'projects');
  const now = T0 + 60_000;

  transcript('-repo-app', 'sid-cli', LIVE_LINES);
  registry(11, { sessionId: 'sid-cli', cwd: '/repo/app', name: 'app-1', status: 'busy', statusUpdatedAt: now - 30_000, tmux: 'claude-app:@1.%1', entrypoint: 'cli', kind: 'interactive' });

  // Same repo, different session, edits the same file -> overlap. Its window
  // holds no typed prompt (only a slash command) so the task falls back to history.
  transcript('-repo-app', 'sid-two', [
    userLine(0, '/compact'),
    assistant(1, 'm9', [{ type: 'tool_use', id: 'z1', name: 'Write', input: { file_path: '/repo/app/src/login.js' } }], { stop: 'tool_use' }),
    result(2, 'z1'),
    assistant(3, 'm10', [{ type: 'text', text: 'Rewrote login.js.' }], { stop: 'end_turn' }),
  ]);
  registry(12, { sessionId: 'sid-two', cwd: '/repo/app', name: 'app-2', status: 'idle', statusUpdatedAt: now - 10_000, tmux: 'claude-app2:@2.%2', entrypoint: 'cli', kind: 'interactive' });
  history([
    { display: 'refactor the login flow', timestamp: now - 50_000, project: '/repo/app', sessionId: 'sid-two' },
    { display: '/compact', timestamp: now - 20_000, project: '/repo/app', sessionId: 'sid-two' },
  ]);

  // Desktop app: no status, no tmux -> derived state, read-only.
  transcript('-repo-web', 'sid-desk', [userLine(0, 'ship it'), assistant(1, 'm5', [{ type: 'text', text: 'shipped' }], { stop: 'end_turn' })]);
  registry(13, { sessionId: 'sid-desk', cwd: '/repo/web', name: 'web-1', entrypoint: 'claude-desktop', kind: 'interactive' });

  // Dead process: must not appear.
  transcript('-repo-old', 'sid-dead', LIVE_LINES);
  registry(14, { sessionId: 'sid-dead', cwd: '/repo/old', status: 'busy', tmux: 'x:@1.%1' });

  // Ended session (no registry at all) with a fresh transcript -> "recent".
  transcript('-repo-done', 'sid-ended', [userLine(0, 'write docs'), assistant(1, 'm7', [{ type: 'text', text: 'Docs written.' }], { stop: 'end_turn' })]);

  const reg = readRegistry({ root: join(home, 'sessions'), isAlive: (pid) => pid !== 14 });
  const board = collectBoard({ registry: reg, history: readHistoryIndex(join(home, 'history.jsonl')), now, tmuxAvailable: true });

  assert.deepEqual(board.sessions.map((s) => s.pid).sort(), [11, 12, 13]);

  const a = board.sessions.find((s) => s.pid === 11);
  assert.equal(a.state, 'busy');
  assert.equal(a.account, 'cli');
  assert.equal(a.controllable, true);
  assert.equal(a.project, 'app');
  assert.equal(a.gitBranch, 'main');
  assert.equal(a.prompt.text, 'fix the login bug');
  assert.equal(a.prompt.inWindow, true);
  assert.equal(a.currentTool.name, 'Bash');
  assert.equal(a.lastText, 'Now running the tests.');
  assert.deepEqual(a.window.files, ['/repo/app/src/login.js']);
  assert.equal(a.window.turns, 2);
  assert.equal(a.window.toolCalls, 2);
  assert.equal(a.stateSince, now - 30_000);
  assert.equal(a.recentTurns.length, 2);
  assert.equal(a.recentTurns[1].tools[0].pending, true);

  const b = board.sessions.find((s) => s.pid === 12);
  assert.equal(b.state, 'idle');
  assert.equal(b.prompt.text, 'refactor the login flow', 'slash commands are skipped; history supplies the task');
  assert.equal(b.prompt.inWindow, false);
  assert.equal(b.window.truncated, false, 'the window was complete, just prompt-less');

  const d = board.sessions.find((s) => s.pid === 13);
  assert.equal(d.account, 'desktop');
  assert.equal(d.controllable, false);
  assert.equal(d.state, 'idle');
  assert.equal(d.stateDerived, true);

  assert.equal(board.overlaps.length, 1);
  assert.deepEqual(board.overlaps[0].pids.sort(), [11, 12]);
  assert.deepEqual(board.overlaps[0].files, [{ file: '/repo/app/src/login.js', pids: [11, 12] }]);

  // The ended session AND the transcript whose process died both count as recent.
  assert.deepEqual(board.recent.map((r) => r.id).sort(), ['sid-dead', 'sid-ended']);
  const ended = board.recent.find((r) => r.id === 'sid-ended');
  assert.equal(ended.project, 'app');
  assert.equal(ended.lastText, 'Docs written.');
  delete process.env.AGENTFDR_CLAUDE_DIR;
});

test('findOverlaps ignores repos with a single session', () => {
  const mk = (pid, repoRoot, files) => ({ pid, repoRoot, window: { files } });
  const ov = findOverlaps([mk(1, '/a', ['/a/x']), mk(2, '/b', ['/b/y']), mk(3, '/b', ['/b/y', '/b/z'])]);
  assert.equal(ov.length, 1);
  assert.equal(ov[0].repo, '/b');
  assert.deepEqual(ov[0].files, [{ file: '/b/y', pids: [2, 3] }]);
});

test('resolveRepo maps a worktree back to its parent repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentfdr-repo-'));
  mkdirSync(join(root, 'main', '.git'), { recursive: true });
  mkdirSync(join(root, 'wt', 'src'), { recursive: true });
  writeFileSync(join(root, 'wt', '.git'), `gitdir: ${join(root, 'main', '.git', 'worktrees', 'wt')}\n`);
  assert.deepEqual(resolveRepo(join(root, 'main', 'src')), { repoRoot: join(root, 'main'), worktreeOf: null });
  assert.deepEqual(resolveRepo(join(root, 'wt', 'src')), { repoRoot: join(root, 'wt'), worktreeOf: join(root, 'main') });
});

// --- steering ------------------------------------------------------------------------

test('buildSendCommands types single-line text literally and submits it', () => {
  const cmds = buildSendCommands('claude-app:@1.%1', { text: 'run the tests -- now' });
  assert.deepEqual(cmds, [
    ['send-keys', '-t', 'claude-app:@1.%1', '-l', '--', 'run the tests -- now'],
    ['send-keys', '-t', 'claude-app:@1.%1', 'Enter'],
  ]);
});

test('buildSendCommands pastes multi-line text as one buffer', () => {
  const cmds = buildSendCommands('s:@1.%1', { text: 'a\r\nb\nc' });
  assert.equal(cmds[0][0], 'set-buffer');
  assert.equal(cmds[0].at(-1), 'a\nb\nc');
  assert.equal(cmds[1][0], 'paste-buffer');
  assert.ok(cmds[1].includes('-p'), 'bracketed paste so newlines do not submit');
  assert.deepEqual(cmds[2], ['send-keys', '-t', 's:@1.%1', 'Enter']);
});

test('buildSendCommands maps actions to keys and refuses everything else', () => {
  assert.deepEqual(buildSendCommands('s:@1.%1', { action: 'approve' }), [['send-keys', '-t', 's:@1.%1', 'Enter']]);
  assert.deepEqual(buildSendCommands('s:@1.%1', { action: 'deny' }), [['send-keys', '-t', 's:@1.%1', 'Escape']]);
  assert.deepEqual(buildSendCommands('s:@1.%1', { action: 'interrupt' }), [['send-keys', '-t', 's:@1.%1', 'Escape']]);
  assert.throws(() => buildSendCommands('s:@1.%1', { action: 'kill' }), /unknown action/);
  assert.throws(() => buildSendCommands('s:@1.%1', { text: '   ' }), /nothing to send/);
  assert.throws(() => buildSendCommands('s:@1.%1', { text: 'x'.repeat(20_001) }), /too long/);
  assert.throws(() => buildSendCommands(null, { text: 'hi' }), /no controllable tmux pane/);
  assert.throws(() => buildSendCommands('s:@1.%1; rm -rf /', { text: 'hi' }), /no controllable tmux pane/);
});

test('sendToSession runs the tmux sequence for a live tmux session only', async () => {
  const registry = [
    { pid: 1, alive: true, tmux: 'claude-a:@1.%1' },
    { pid: 2, alive: true, tmux: null },
    { pid: 3, alive: false, tmux: 'claude-c:@3.%3' },
  ];
  const ran = [];
  const run = async (args) => { ran.push(args); };
  const r = await sendToSession(1, { text: 'hello' }, { registry, run, delayMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.target, 'claude-a:@1.%1');
  assert.equal(ran.length, 2);
  assert.equal(ran[1].at(-1), 'Enter');
  await assert.rejects(() => sendToSession(2, { text: 'hello' }, { registry, run }), /read-only/);
  await assert.rejects(() => sendToSession(3, { text: 'hello' }, { registry, run }), /no live session/);
  await assert.rejects(() => sendToSession(99, { text: 'hello' }, { registry, run }), /no live session/);
});

test('isSameOrigin: only the board page itself may drive sessions', () => {
  const req = (headers) => ({ headers });
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'same-origin', host: '127.0.0.1:4477' })), true);
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'same-origin', host: 'localhost:4477' })), true);
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'same-origin', host: 'evil.example:4477' })), false, 'DNS rebinding: browser says same-origin, Host says otherwise');
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'same-origin' })), false, 'no Host at all');
  assert.equal(isSameOrigin(req({ 'sec-fetch-site': 'cross-site', origin: 'http://127.0.0.1:4477', host: '127.0.0.1:4477' })), false);
  assert.equal(isSameOrigin(req({ origin: 'http://127.0.0.1:4477', host: '127.0.0.1:4477' })), true);
  assert.equal(isSameOrigin(req({ origin: 'http://localhost:4477', host: 'localhost:4477' })), true);
  assert.equal(isSameOrigin(req({ origin: 'http://evil.example', host: '127.0.0.1:4477' })), false);
  assert.equal(isSameOrigin(req({ host: '127.0.0.1:4477' })), false, 'no origin, no sec-fetch-site: not a browser page');
});
