import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSessionText } from '../src/parser.js';
import { buildDocs, searchDocs, searchSessions } from '../src/search.js';

const ts = (i) => new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString();
const lines = [
  JSON.stringify({ type: 'user', uuid: 'p1', timestamp: ts(0), sessionId: 's',
    message: { role: 'user', content: 'please fix the LOGIN bug' } }),
  JSON.stringify({ type: 'assistant', uuid: 'a1', timestamp: ts(1), sessionId: 's',
    message: { id: 'm1', model: 'claude-opus-4-8', role: 'assistant',
      content: [
        { type: 'text', text: 'Looking into the login flow now.' },
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'login' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  JSON.stringify({ type: 'user', uuid: 'r1', timestamp: ts(2), sessionId: 's',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'auth/login.ts: handleLogin()' }] } }),
].join('\n');

test('buildDocs flattens prompts, assistant text, tool calls and results', () => {
  const docs = buildDocs(parseSessionText(lines));
  const kinds = docs.map((d) => d.w).sort();
  assert.deepEqual(kinds, ['assistant', 'prompt', 'result', 'tool']);
});

test('searchDocs is case-insensitive and returns highlightable excerpts', () => {
  const docs = buildDocs(parseSessionText(lines));
  const hits = searchDocs(docs, 'login');
  assert.equal(hits.length, 4); // appears in all four kinds
  assert.ok(hits.every((h) => h.excerpt.toLowerCase().includes('login')));
  assert.equal(searchDocs(docs, 'nonexistent-zzz').length, 0);
});

test('searchSessions scans a projects root and reports session metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentfdr-search-'));
  mkdirSync(join(root, '-proj'));
  writeFileSync(join(root, '-proj', 'abc-123.jsonl'), lines);
  const results = searchSessions('handleLogin', { root });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'abc-123');
  assert.equal(results[0].slug, '-proj');
  assert.equal(results[0].matches[0].w, 'result');
});
