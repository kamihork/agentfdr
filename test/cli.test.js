import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

test('positional args are kept even when they equal a flag value', () => {
  const { flags, positional, errors } = parseArgs(['assert', '50', '--max-turns', '50']);
  assert.deepEqual(errors, []);
  assert.deepEqual(positional, ['assert', '50']); // session ref "50" survives
  assert.equal(flags.get('--max-turns'), '50');
});

test('supports --flag=value syntax', () => {
  const { flags, positional, errors } = parseArgs(['watch', '--port=6000', '--lang=ja']);
  assert.deepEqual(errors, []);
  assert.deepEqual(positional, ['watch']);
  assert.equal(flags.get('--port'), '6000');
  assert.equal(flags.get('--lang'), 'ja');
});

test('unknown flags are errors, not silently ignored', () => {
  const { errors } = parseArgs(['assert', '--no-loop']); // typo for --no-loops
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unknown option --no-loop/);
});

test('a value flag with a missing value is an error', () => {
  // --port followed by another flag: must NOT consume it as the value
  const { errors, flags } = parseArgs(['open', '--port', '--no-browser']);
  assert.match(errors[0], /--port requires a value/);
  assert.equal(flags.get('--no-browser'), true);
});

test('boolean flags reject =value', () => {
  const { errors } = parseArgs(['--json=yes']);
  assert.match(errors[0], /--json does not take a value/);
});
