import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionText, parseSessionFile } from '../src/parser.js';
import { buildSubagentTree, listSubagentFiles, subagentTotals } from '../src/subagents.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const ts = (i) => new Date(T0 + i * 1000).toISOString();

const assistant = (i, mid, blocks, extra = {}) => JSON.stringify({
  type: 'assistant', uuid: 'u' + i, timestamp: ts(i), sessionId: 's', ...extra,
  message: { id: mid, model: 'claude-opus-5', role: 'assistant', content: blocks,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 10 } },
});
const userLine = (i, text) => JSON.stringify({
  type: 'user', uuid: 'p' + i, timestamp: ts(i), sessionId: 's', message: { role: 'user', content: text },
});

/** A session dir with a main transcript and the agent files described by `agents`. */
function fixture(mainLines, agents) {
  const dir = mkdtempSync(join(tmpdir(), 'agentfdr-subs-'));
  const file = join(dir, 'sess.jsonl');
  writeFileSync(file, mainLines.join('\n'));
  for (const a of agents) {
    const sub = a.workflow ? join(dir, 'sess', 'subagents', 'workflows', a.workflow) : join(dir, 'sess', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `agent-${a.id}.jsonl`), a.lines.join('\n'));
    if (a.meta) writeFileSync(join(sub, `agent-${a.id}.meta.json`), JSON.stringify(a.meta));
  }
  return file;
}

const AGENT_LINES = (label, callId = null) => [
  userLine(0, label),
  assistant(1, 'am1', [{ type: 'tool_use', id: callId ?? 'inner-1', name: 'Read', input: { file_path: '/x.js' } }]),
];

test('subagent transcripts are found, including inside workflow directories', () => {
  const file = fixture([assistant(0, 'm0', [{ type: 'text', text: 'hi' }])], [
    { id: 'aaa', lines: AGENT_LINES('plain agent'), meta: { agentType: 'general-purpose' } },
    { id: 'bbb', workflow: 'wf_1', lines: AGENT_LINES('workflow agent'), meta: { agentType: 'workflow-subagent' } },
  ]);
  const found = listSubagentFiles(file);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.workflow).sort(), [null, 'wf_1']);
});

test('an agent is attached to the exact turn whose tool call spawned it', () => {
  const main = [
    assistant(0, 'm0', [{ type: 'text', text: 'thinking' }]),
    assistant(1, 'm1', [{ type: 'tool_use', id: 'toolu_spawn', name: 'Task', input: { description: 'go look' } }]),
    assistant(2, 'm2', [{ type: 'text', text: 'done' }]),
  ];
  const file = fixture(main, [
    { id: 'aaa', lines: AGENT_LINES('investigate'), meta: { agentType: 'general-purpose', description: 'Investigate', toolUseId: 'toolu_spawn' } },
  ]);
  const [node] = buildSubagentTree(parseSessionFile(file), file);
  assert.equal(node.turn, 1); // the Task turn, not turn 0 or 2
  assert.equal(node.type, 'general-purpose');
  assert.equal(node.description, 'Investigate');
  assert.equal(node.summary.turns, 1);
  assert.equal(node.summary.toolCalls, 1);
});

test('an agent spawned by another agent nests under it and inherits its turn', () => {
  const main = [assistant(1, 'm1', [{ type: 'tool_use', id: 'toolu_spawn', name: 'Task', input: {} }])];
  const file = fixture(main, [
    { id: 'parent', lines: AGENT_LINES('parent agent', 'toolu_nested'), meta: { agentType: 'general-purpose', toolUseId: 'toolu_spawn', agentId: 'parent' } },
    { id: 'child', lines: AGENT_LINES('child agent'), meta: { agentType: 'general-purpose', toolUseId: 'toolu_nested', agentId: 'child', spawnDepth: 2 } },
  ]);
  const nodes = buildSubagentTree(parseSessionFile(file), file);
  const child = nodes.find((n) => n.id === 'child');
  assert.equal(child.parentId, 'parent');
  assert.equal(child.turn, 0); // shown under the branch's origin turn — the Task turn
});

test('an agent with no spawn id is placed by timestamp, not dropped', () => {
  const main = [
    assistant(0, 'm0', [{ type: 'text', text: 'a' }]),
    assistant(10, 'm1', [{ type: 'text', text: 'b' }]),
    assistant(99, 'm2', [{ type: 'text', text: 'c' }]),
  ];
  const file = fixture(main, [
    { id: 'aaa', lines: [userLine(20, 'workflow work'), assistant(21, 'am1', [{ type: 'text', text: 'ok' }])], meta: { agentType: 'workflow-subagent' } },
  ]);
  const [node] = buildSubagentTree(parseSessionFile(file), file);
  assert.equal(node.turn, 1); // last main turn that had started by then
  assert.equal(node.description, 'workflow work'); // falls back to the opening prompt
});

test('a session with no subagent directory yields an empty forest', () => {
  const file = fixture([assistant(0, 'm0', [{ type: 'text', text: 'hi' }])], []);
  assert.deepEqual(buildSubagentTree(parseSessionFile(file), file), []);
});

test('older transcripts with inline sidechain turns still form a tree', () => {
  const model = parseSessionText([
    assistant(0, 'm0', [{ type: 'tool_use', id: 'c0', name: 'Task', input: { description: 'research the API' } }]),
    assistant(1, 'm1', [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/a.js' } }], { isSidechain: true }),
    assistant(2, 'm2', [{ type: 'tool_use', id: 'c2', name: 'Read', input: { file_path: '/b.js' } }], { isSidechain: true }),
    assistant(3, 'm3', [{ type: 'text', text: 'back on the main thread' }]),
  ].join('\n'));
  const [node] = buildSubagentTree(model, '/nowhere/sess.jsonl');
  assert.equal(node.inline, true);
  assert.equal(node.turn, 0);            // the Task turn it descends from
  assert.equal(node.turnStart, 1);
  assert.equal(node.turnEnd, 2);
  assert.equal(node.summary.turns, 2);
  assert.equal(node.summary.toolCalls, 2);
  assert.equal(node.description, 'research the API');
});

test('totals roll up across the forest', () => {
  const main = [assistant(1, 'm1', [{ type: 'tool_use', id: 'toolu_spawn', name: 'Task', input: {} }])];
  const file = fixture(main, [
    { id: 'aaa', lines: AGENT_LINES('one'), meta: { toolUseId: 'toolu_spawn' } },
    { id: 'bbb', workflow: 'wf_1', lines: AGENT_LINES('two'), meta: {} },
  ]);
  const totals = subagentTotals(buildSubagentTree(parseSessionFile(file), file));
  assert.equal(totals.agents, 2);
  assert.equal(totals.turns, 2);
  assert.equal(totals.toolCalls, 2);
  assert.equal(totals.workflows, 1);
  assert.ok(totals.billedTokens > 0);
});
