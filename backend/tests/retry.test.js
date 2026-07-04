import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoffMs } from '../src/services/retry.js';

// These tests need no database and always run: `npm test`.

test('fixed strategy returns the base delay regardless of attempt', () => {
  const p = { strategy: 'fixed', base_delay_ms: 1000, max_delay_ms: 300000 };
  assert.equal(computeBackoffMs(p, 1), 1000);
  assert.equal(computeBackoffMs(p, 5), 1000);
  assert.equal(computeBackoffMs(p, 99), 1000);
});

test('linear strategy scales with the attempt number', () => {
  const p = { strategy: 'linear', base_delay_ms: 500, max_delay_ms: 300000 };
  assert.equal(computeBackoffMs(p, 1), 500);
  assert.equal(computeBackoffMs(p, 2), 1000);
  assert.equal(computeBackoffMs(p, 4), 2000);
});

test('exponential strategy doubles each attempt from the base', () => {
  const p = { strategy: 'exponential', base_delay_ms: 1000, max_delay_ms: 300000 };
  assert.equal(computeBackoffMs(p, 1), 1000); // base * 2^0
  assert.equal(computeBackoffMs(p, 2), 2000); // base * 2^1
  assert.equal(computeBackoffMs(p, 3), 4000); // base * 2^2
  assert.equal(computeBackoffMs(p, 4), 8000); // base * 2^3
});

test('delay is clamped to max_delay_ms', () => {
  const p = { strategy: 'exponential', base_delay_ms: 1000, max_delay_ms: 5000 };
  // 2^10 * 1000 would be ~1M ms, but must clamp to 5000.
  assert.equal(computeBackoffMs(p, 11), 5000);
});

test('unknown strategy falls back to exponential', () => {
  const p = { strategy: 'nonsense', base_delay_ms: 1000, max_delay_ms: 300000 };
  assert.equal(computeBackoffMs(p, 3), 4000);
});

test('full jitter keeps the delay within [0, computed]', () => {
  const p = { strategy: 'exponential', base_delay_ms: 1000, max_delay_ms: 300000, jitter: true };
  for (let i = 0; i < 500; i++) {
    const d = computeBackoffMs(p, 4); // computed ceiling is 8000
    assert.ok(d >= 0 && d <= 8000, `jittered delay ${d} out of bounds`);
    assert.ok(Number.isInteger(d), 'jittered delay should be an integer');
  }
});

test('defaults apply when base/max are omitted', () => {
  assert.equal(computeBackoffMs({ strategy: 'fixed' }, 1), 1000);
});
