// Synthetic ~/.claude for board screenshots: no real prompts, no real paths.
// Usage: node scripts/demo-board-fixture.mjs <outdir> <pid1> ... <pid6>   (six LIVE pids, e.g. of `sleep 1200`)
//        AGENTFDR_CLAUDE_DIR=<outdir>/projects agentfdr board --port 4511
//        then capture http://127.0.0.1:4511/board?theme=dark&uilang=en at 1512x900.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, ...pids] = process.argv.slice(2);
const P = pids.map(Number);
mkdirSync(join(out, 'projects'), { recursive: true });
mkdirSync(join(out, 'sessions'), { recursive: true });

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
let seq = 0;
const asst = (msAgo, mid, blocks, stop, model = 'claude-fable-5', ctx = 120_000) => JSON.stringify({
  type: 'assistant', uuid: 'u' + (seq++), timestamp: iso(msAgo), sessionId: mid + '-s',
  message: { id: mid, model, role: 'assistant', content: blocks, stop_reason: stop,
    usage: { input_tokens: 2000, output_tokens: 900, cache_read_input_tokens: ctx, cache_creation_input_tokens: 5000 } },
});
const user = (msAgo, text, cwd, branch) => JSON.stringify({ type: 'user', uuid: 'p' + (seq++), timestamp: iso(msAgo), cwd, gitBranch: branch, message: { role: 'user', content: text } });
const res = (msAgo, id, isError = false) => JSON.stringify({ type: 'user', uuid: 'r' + (seq++), timestamp: iso(msAgo), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'Error: 3 tests failed' : 'ok', is_error: isError }] } });
const title = (t) => JSON.stringify({ type: 'ai-title', aiTitle: t });

const write = (slug, id, lines) => {
  mkdirSync(join(out, 'projects', slug), { recursive: true });
  writeFileSync(join(out, 'projects', slug, id + '.jsonl'), lines.join('\n') + '\n');
};
const reg = (pid, e) => writeFileSync(join(out, 'sessions', pid + '.json'), JSON.stringify({ pid, version: '2.1.233', kind: 'interactive', entrypoint: 'cli', ...e }));

const H = '/Users/dev/code';
const m = 60_000;

// 1. waiting: permission prompt for a Bash migration in "checkout" (CLI)
write('-Users-dev-code-checkout', 'aaaa1111', [
  title('Add coupon codes to checkout'),
  user(9 * m, 'Add support for coupon codes to the checkout flow. Migration + API + one test.', `${H}/checkout`, 'feat/coupons'),
  asst(8 * m, 'a1', [{ type: 'tool_use', id: 'a1c', name: 'Read', input: { file_path: `${H}/checkout/src/cart.ts` } }], 'tool_use'),
  res(8 * m - 2000, 'a1c'),
  asst(7 * m, 'a2', [{ type: 'tool_use', id: 'a2c', name: 'Edit', input: { file_path: `${H}/checkout/src/cart.ts` } }], 'tool_use'),
  res(7 * m - 3000, 'a2c'),
  asst(6 * m, 'a3', [{ type: 'tool_use', id: 'a3c', name: 'Write', input: { file_path: `${H}/checkout/migrations/0042_coupons.sql` } }], 'tool_use'),
  res(6 * m - 1000, 'a3c'),
  asst(40_000, 'a4', [{ type: 'text', text: 'Schema and cart logic are in. Applying the migration to the dev database next.' }, { type: 'tool_use', id: 'a4c', name: 'Bash', input: { command: 'npm run db:migrate' } }], 'tool_use'),
]);
reg(P[0], { sessionId: 'aaaa1111', cwd: `${H}/checkout`, name: 'checkout-3f', status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: now - 38_000, tmux: 'claude-checkout-2201:@3.%3', startedAt: now - 30 * m });

// 2. busy: running tests in "checkout" too (Desktop) -> repo overlap, same file
write('-Users-dev-code-checkout', 'bbbb2222', [
  title('Fix flaky cart total test'),
  user(22 * m, 'The cart total test is flaky on CI — find out why and fix it properly.', `${H}/checkout`, 'main'),
  asst(20 * m, 'b1', [{ type: 'tool_use', id: 'b1c', name: 'Bash', input: { command: 'npm test -- cart' } }], 'tool_use', 'claude-opus-5', 88_000),
  res(19 * m, 'b1c', true),
  asst(18 * m, 'b2', [{ type: 'tool_use', id: 'b2c', name: 'Edit', input: { file_path: `${H}/checkout/src/cart.ts` } }], 'tool_use', 'claude-opus-5', 91_000),
  res(18 * m - 4000, 'b2c'),
  asst(17 * m, 'b3', [{ type: 'tool_use', id: 'b3c', name: 'Bash', input: { command: 'npm test -- cart' } }], 'tool_use', 'claude-opus-5', 95_000),
  res(16 * m, 'b3c', true),
  asst(15 * m, 'b4', [{ type: 'tool_use', id: 'b4c', name: 'Edit', input: { file_path: `${H}/checkout/src/cart.ts` } }], 'tool_use', 'claude-opus-5', 99_000),
  res(15 * m - 4000, 'b4c'),
  asst(20_000, 'b5', [{ type: 'text', text: 'Rounding happened before the discount was applied; moved it after. Re-running the suite.' }, { type: 'tool_use', id: 'b5c', name: 'Bash', input: { command: 'npm test -- cart' } }], 'tool_use', 'claude-opus-5', 104_000),
]);
reg(P[1], { sessionId: 'bbbb2222', cwd: `${H}/checkout`, name: 'checkout-a9', entrypoint: 'claude-desktop', startedAt: now - 40 * m });

// 3. busy: docs site (CLI, worktree)
write('-Users-dev-code-docs-site', 'cccc3333', [
  title('Rewrite the getting-started guide'),
  user(12 * m, 'Rewrite docs/getting-started.md for the new CLI flags and add a troubleshooting section.', `${H}/docs-site`, 'docs/getting-started'),
  asst(11 * m, 'c1', [{ type: 'tool_use', id: 'c1c', name: 'Read', input: { file_path: `${H}/docs-site/docs/getting-started.md` } }], 'tool_use', 'claude-fable-5', 60_000),
  res(11 * m - 1000, 'c1c'),
  asst(9 * m, 'c2', [{ type: 'tool_use', id: 'c2c', name: 'Write', input: { file_path: `${H}/docs-site/docs/getting-started.md` } }], 'tool_use', 'claude-fable-5', 70_000),
  res(9 * m - 1000, 'c2c'),
  asst(8_000, 'c3', [{ type: 'text', text: 'Guide rewritten; now drafting the troubleshooting section.' }, { type: 'tool_use', id: 'c3c', name: 'Edit', input: { file_path: `${H}/docs-site/docs/troubleshooting.md` } }], 'tool_use', 'claude-fable-5', 74_000),
]);
reg(P[2], { sessionId: 'cccc3333', cwd: `${H}/docs-site`, name: 'docs-site-71', status: 'busy', statusUpdatedAt: now - 11 * m, tmux: 'claude-docs-site-9981:@5.%5', startedAt: now - 15 * m });

// 4. idle: mobile app (Desktop), finished
write('-Users-dev-code-mobile', 'dddd4444', [
  title('Push notification opt-in screen'),
  user(50 * m, 'Build the notification opt-in screen from the Figma frame and wire it to the settings store.', `${H}/mobile`, 'feat/notif-optin'),
  asst(48 * m, 'd1', [{ type: 'tool_use', id: 'd1c', name: 'Write', input: { file_path: `${H}/mobile/src/screens/NotifOptIn.tsx` } }], 'tool_use', 'claude-sonnet-5', 40_000),
  res(48 * m - 1000, 'd1c'),
  asst(46 * m, 'd2', [{ type: 'tool_use', id: 'd2c', name: 'Edit', input: { file_path: `${H}/mobile/src/store/settings.ts` } }], 'tool_use', 'claude-sonnet-5', 44_000),
  res(46 * m - 1000, 'd2c'),
  asst(44 * m, 'd3', [{ type: 'text', text: 'Done. The screen is in src/screens/NotifOptIn.tsx, wired to settings.notifications; 4 new tests pass. Want me to open the PR?' }], 'end_turn', 'claude-sonnet-5', 47_000),
]);
reg(P[3], { sessionId: 'dddd4444', cwd: `${H}/mobile`, name: 'mobile-c2', entrypoint: 'claude-desktop', startedAt: now - 60 * m });

// 5. idle: infra (CLI), waiting for the next prompt
write('-Users-dev-code-infra', 'eeee5555', [
  title('Rotate the staging DB credentials'),
  user(120 * m, 'Rotate the staging database credentials and update the secret in the deploy config.', `${H}/infra`, 'main'),
  asst(118 * m, 'e1', [{ type: 'tool_use', id: 'e1c', name: 'Read', input: { file_path: `${H}/infra/deploy/staging.yaml` } }], 'tool_use', 'claude-opus-5', 30_000),
  res(118 * m - 1000, 'e1c'),
  asst(115 * m, 'e2', [{ type: 'text', text: 'Rotation prepared. I did not apply it: the deploy config change needs your `terraform apply`. Command and diff are above.' }], 'end_turn', 'claude-opus-5', 33_000),
]);
reg(P[4], { sessionId: 'eeee5555', cwd: `${H}/infra`, name: 'infra-0d', status: 'idle', statusUpdatedAt: now - 115 * m, tmux: 'claude-infra-4410:@2.%2', startedAt: now - 130 * m });

// 6. idle bg job
write('-Users-dev-code-mobile', 'ffff6666', [
  title('Refresh store screenshots'),
  user(200 * m, 'Regenerate the App Store screenshots for all six device sizes.', `${H}/mobile`, 'main'),
  asst(190 * m, 'f1', [{ type: 'text', text: 'All 6 sizes regenerated under fastlane/screenshots/.' }], 'end_turn', 'claude-sonnet-5', 20_000),
]);
reg(P[5], { sessionId: 'ffff6666', cwd: `${H}/mobile`, name: 'Refresh store screenshots', kind: 'bg', status: 'idle', statusUpdatedAt: now - 190 * m, startedAt: now - 200 * m });

// recently ended
write('-Users-dev-code-api', '99998888', [
  title('Rate-limit the search endpoint'),
  user(70 * m, 'Add a per-user rate limit to /search.', `${H}/api`, 'main'),
  asst(65 * m, 'g1', [{ type: 'text', text: 'Rate limit added (60 req/min per user) with a 429 test. Merged as #412.' }], 'end_turn', 'claude-fable-5', 50_000),
]);

writeFileSync(join(out, 'history.jsonl'), '');
console.log('fixture at', out);
