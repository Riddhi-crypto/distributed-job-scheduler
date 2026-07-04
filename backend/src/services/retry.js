/**
 * Compute the delay (ms) before the next attempt.
 *   fixed:       base
 *   linear:      base * attempt
 *   exponential: base * 2^(attempt-1)
 * Clamped to max_delay_ms. Optional full jitter to avoid retry stampedes.
 *
 * @param {{strategy:string, base_delay_ms:number, max_delay_ms:number, jitter?:boolean}} policy
 * @param {number} attempt  the attempt number that just FAILED (1-based)
 */
export function computeBackoffMs(policy, attempt) {
  const base = policy.base_delay_ms ?? 1000;
  const max = policy.max_delay_ms ?? 300000;
  let delay;
  switch (policy.strategy) {
    case 'fixed':
      delay = base;
      break;
    case 'linear':
      delay = base * attempt;
      break;
    case 'exponential':
    default:
      delay = base * Math.pow(2, Math.max(0, attempt - 1));
      break;
  }
  delay = Math.min(delay, max);
  if (policy.jitter) {
    // Full jitter: random point in [0, delay].
    delay = Math.floor(Math.random() * delay);
  }
  return delay;
}
