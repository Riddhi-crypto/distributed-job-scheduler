import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/services/ai.js';

// No database required; always runs.

test('classifies timeouts', () => {
  const r = classifyFailure({ error: 'Error: handler timed out after 60s', handler: 'sleep' });
  assert.equal(r.category, 'TIMEOUT');
  assert.ok(r.confidence > 0.5);
  assert.ok(r.summary.length > 0);
  assert.ok(r.fix.length > 0);
});

test('classifies network failures', () => {
  const r = classifyFailure({ error: 'connect ECONNREFUSED 127.0.0.1:9200', handler: 'http' });
  assert.equal(r.category, 'NETWORK');
});

test('classifies resource/OOM failures', () => {
  const r = classifyFailure({ error: 'JavaScript heap out of memory', handler: 'cpu' });
  assert.equal(r.category, 'RESOURCE');
});

test('classifies auth failures', () => {
  const r = classifyFailure({ error: 'Request failed with status code 403 Forbidden', handler: 'http' });
  assert.equal(r.category, 'AUTH');
});

test('classifies bad input / validation failures', () => {
  const r = classifyFailure({ error: 'ValidationError: payload failed schema check', handler: 'echo' });
  assert.equal(r.category, 'BAD_INPUT');
});

test('falls back to UNKNOWN with low confidence for unrecognised errors', () => {
  const r = classifyFailure({ error: 'something completely unexpected happened', handler: 'echo' });
  assert.equal(r.category, 'UNKNOWN');
  assert.ok(r.confidence <= 0.5);
});

test('always returns the full diagnosis shape', () => {
  for (const input of [
    { error: 'timeout', handler: 'sleep' },
    {},
    { error: '', handler: '' },
  ]) {
    const r = classifyFailure(input);
    assert.ok('category' in r && 'summary' in r && 'fix' in r && 'confidence' in r);
    assert.equal(typeof r.confidence, 'number');
  }
});

test('is deterministic — same input yields same category', () => {
  const a = classifyFailure({ error: 'timed out', handler: 'x' });
  const b = classifyFailure({ error: 'timed out', handler: 'x' });
  assert.deepEqual(a, b);
});
