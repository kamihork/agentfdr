import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCodexText, looksLikeCodex, parseAnySessionText, probeCodexTitle } from '../src/codex.js';
import { listCodexSessions, listAllProjects, resolveSession } from '../src/discover.js';
import { detect } from '../src/detect.js';
import { estimateSessionCost } from '../src/cost.js';

const ts = (i) => new Date(Date.parse('2026-07-17T00:00:00Z') + i * 1000).toISOString();
const L = (i, type, payload) => JSON.stringify({ timestamp: ts(i), type, payload });
const tokenCount = (i, usage) => L(i, 'event_msg', {
  type: 'token_count',
  info: { total_token_usage: usage, last_token_usage: usage, model_context_window: 272000 },
});

function fixture() {
  const lines = [
    L(0, 'session_meta', {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000', timestamp: ts(0),
      cwd: '/Users/x/proj', originator: 'codex_cli_rs', cli_version: '0.31.0',
      git: { branch: 'main', commit_hash: 'abc123' },
    }),
    L(1, 'turn_context', { cwd: '/Users/x/proj', model: 'gpt-5-codex', effort: 'high' }),
    L(2, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/Users/x/proj</cwd>\n</environment_context>' }] }),
    L(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the login bug' }] }),
    L(4, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Looking at the auth flow first.' }] }),
    L(5, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }), call_id: 'c1' }),
    L(8, 'response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'FAIL auth/login.test.ts', metadata: { exit_code: 1, duration_seconds: 2.5 } }) }),
    L(9, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The login test fails; patching.' }] }),
    // input_tokens includes cached tokens (verified against real rollouts)
    tokenCount(10, { input_tokens: 1000, cached_input_tokens: 900, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 }),
  ];
  // six more turns re-running the same command — a tool loop
  for (let n = 0; n < 6; n++) {
    const base = 11 + n * 3;
    lines.push(
      L(base, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }), call_id: 'r' + n }),
      L(base + 1, 'response_item', { type: 'function_call_output', call_id: 'r' + n, output: JSON.stringify({ output: 'FAIL auth/login.test.ts', metadata: { exit_code: 1, duration_seconds: 1 } }) }),
      tokenCount(base + 2, { input_tokens: 1050, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 1070 }),
    );
  }
  lines.push(L(40, 'compacted', { message: 'history compacted' }));
  return lines.join('\n');
}

test('looksLikeCodex distinguishes rollouts from Claude transcripts', () => {
  assert.equal(looksLikeCodex(fixture()), true);
  const claude = JSON.stringify({ type: 'user', uuid: 'x', message: { role: 'user', content: 'hi' } });
  assert.equal(looksLikeCodex(claude), false);
  assert.equal(parseAnySessionText(fixture()).session.agent, 'codex');
});

test('parseCodexText builds the normalized model', () => {
  const m = parseCodexText(fixture(), '/tmp/rollout-x.jsonl');
  assert.equal(m.session.id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000');
  assert.equal(m.session.cwd, '/Users/x/proj');
  assert.equal(m.session.gitBranch, 'main');
  assert.equal(m.session.version, '0.31.0');
  assert.equal(m.session.model, 'gpt-5-codex');
  assert.equal(m.session.effort, 'high');
  assert.equal(m.session.title, 'fix the login bug');

  // harness tags are not prompts
  assert.equal(m.prompts.length, 1);
  assert.equal(m.prompts[0].text, 'fix the login bug');

  assert.equal(m.turns.length, 7);
  const t0 = m.turns[0];
  assert.deepEqual(t0.usage, { input: 100, output: 50, cacheRead: 900, cacheCreation: 0 });
  assert.equal(t0.contextTokens, 1000);
  assert.equal(t0.model, 'gpt-5-codex');
  assert.equal(t0.text, 'The login test fails; patching.');
  assert.ok(t0.thinkingChars > 0);

  const call = t0.toolCalls[0];
  assert.equal(call.name, 'shell');
  assert.equal(call.summary, 'npm test'); // bash -lc wrapper stripped
  assert.equal(call.result.isError, true);
  assert.equal(call.result.durationMs, 2500);
  assert.ok(call.result.snippet.includes('FAIL'));

  assert.equal(m.totals.toolErrors, 7);
  assert.equal(m.totals.compactions, 1);
  assert.ok(estimateSessionCost(m).usd > 0); // gpt-5 family is priced
});

test('detectors run unchanged on Codex sessions', () => {
  const m = parseCodexText(fixture());
  const flags = detect(m);
  assert.ok(flags.some((f) => f.type === 'loop'), 'expected a tool-loop flag');
  assert.ok(flags.some((f) => f.type === 'error-streak'));
});

test('real-world exec custom tool calls: JS-snippet input, block-array output', () => {
  // Shapes observed in actual codex-cli 0.14x rollouts.
  const lines = [
    L(0, 'session_meta', { id: 'bbbbbbbb-cccc-4ddd-8eee-ffff00001111', timestamp: ts(0), cwd: '/x' }),
    L(1, 'turn_context', { model: 'gpt-5.6-terra' }),
    L(2, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions> ...' }] }),
    L(3, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'explain this project' }] }),
    L(4, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'e1', status: 'completed',
      input: 'const r = await tools.exec_command({"cmd":"rg --files | head","timeout":120}); return r;' }),
    L(5, 'response_item', { type: 'custom_tool_call_output', call_id: 'e1',
      output: [{ type: 'input_text', text: 'Script completed\nWall time 1.7 seconds\nOutput:\n' }, { type: 'input_text', text: 'README.md\nsrc/cli.js' }] }),
    L(6, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'e2', status: 'completed',
      input: 'const r = await tools.exec_command({"cmd":"npm test"}); return r;' }),
    L(7, 'response_item', { type: 'custom_tool_call_output', call_id: 'e2',
      output: [{ type: 'input_text', text: 'Script failed\nWall time 3.2 seconds\nOutput:\nError: 1 test failing' }] }),
    tokenCount(8, { input_tokens: 13176, cached_input_tokens: 10496, output_tokens: 138, reasoning_output_tokens: 13, total_tokens: 13314 }),
  ].join('\n');
  const m = parseCodexText(lines);

  // developer-role messages are harness setup, not prompts
  assert.equal(m.prompts.length, 1);
  assert.equal(m.prompts[0].text, 'explain this project');

  const t = m.turns[0];
  // input_tokens includes cached: fresh = 13176 - 10496
  assert.deepEqual(t.usage, { input: 2680, output: 138, cacheRead: 10496, cacheCreation: 0 });
  assert.equal(t.contextTokens, 13176);

  const [ok, fail] = t.toolCalls;
  assert.equal(ok.summary, 'rg --files | head'); // cmd extracted from the JS snippet
  assert.equal(ok.input.command, 'rg --files | head'); // loop signatures see the command
  assert.equal(ok.result.isError, false);
  assert.equal(ok.result.durationMs, 1700); // "Wall time 1.7 seconds"
  assert.ok(ok.result.snippet.includes('README.md'));
  assert.equal(fail.result.isError, true); // "Script failed"
  assert.equal(fail.result.durationMs, 3200);
});

test('discovery finds rollouts and resolves by id prefix', () => {
  const codexDir = mkdtempSync(join(tmpdir(), 'agentfdr-codex-'));
  const claudeDir = mkdtempSync(join(tmpdir(), 'agentfdr-claude-'));
  const day = join(codexDir, '2026', '07', '17');
  mkdirSync(day, { recursive: true });
  const file = join(day, 'rollout-2026-07-17T00-00-00-aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000.jsonl');
  writeFileSync(file, fixture());

  const group = listCodexSessions(codexDir);
  assert.equal(group.slug, 'codex');
  assert.equal(group.sessions.length, 1);
  assert.equal(group.sessions[0].id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000');

  const all = listAllProjects({ claudeRoot: claudeDir, codexDir });
  assert.equal(all.length, 1);
  assert.equal(all[0].agent, 'codex');

  process.env.AGENTFDR_CODEX_DIR = codexDir;
  try {
    const { file: resolved, id } = resolveSession('aaaaaaaa', claudeDir);
    assert.equal(resolved, file);
    assert.equal(id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000');
  } finally {
    delete process.env.AGENTFDR_CODEX_DIR;
  }

  assert.equal(probeCodexTitle(file), 'fix the login bug');
});
