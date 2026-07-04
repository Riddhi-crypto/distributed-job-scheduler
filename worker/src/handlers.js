import { pool } from './db.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Handler registry. Each handler receives (payload, ctx) where ctx exposes a
 * log(level, message) function that appends to job_logs. Handlers should be
 * idempotent where possible — the platform may re-run a job after a crash.
 */
export const handlers = {
  // Echoes the payload back. The simplest possible unit of work.
  async echo(payload, ctx) {
    await ctx.log('info', `echo ${JSON.stringify(payload)}`);
    return { echoed: payload };
  },

  // Sleeps for payload.ms (default 500). Useful for testing timeouts/concurrency.
  async sleep(payload, ctx) {
    const ms = Number(payload.ms ?? 500);
    await ctx.log('info', `sleeping ${ms}ms`);
    await sleep(ms);
    return { sleptMs: ms };
  },

  // Burns CPU for payload.iterations (default 5e6). Simulates real load.
  async cpu(payload, ctx) {
    const iters = Number(payload.iterations ?? 5_000_000);
    let acc = 0;
    for (let i = 0; i < iters; i++) acc += Math.sqrt(i);
    await ctx.log('info', `cpu burn done (${iters} iters)`);
    return { checksum: Math.round(acc) };
  },

  // Fetches a URL (Node 18+ global fetch). Demonstrates network-bound work.
  async http(payload, ctx) {
    const url = payload.url;
    if (!url) throw new Error('http handler requires payload.url');
    await ctx.log('info', `GET ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`http ${res.status} from ${url}`);
    return { status: res.status };
  },

  // Always fails — used to exercise retries and the dead-letter queue.
  async fail(payload, ctx) {
    await ctx.log('warn', 'intentional failure handler invoked');
    throw new Error(payload.reason || 'intentional failure');
  },
};

/** Read the global fault-injection config (set from the Chaos Lab). */
export async function readChaos() {
  try {
    const { rows } = await pool.query('SELECT fail_rate, latency_ms FROM chaos_config WHERE id=1');
    return rows[0] || { fail_rate: 0, latency_ms: 0 };
  } catch {
    return { fail_rate: 0, latency_ms: 0 };
  }
}

/** Wrap a handler so global chaos (latency + random failure) applies to all jobs. */
export async function runHandler(name, payload, ctx) {
  const chaos = await readChaos();
  if (chaos.latency_ms > 0) await sleep(Number(chaos.latency_ms));
  if (chaos.fail_rate > 0 && Math.random() < Number(chaos.fail_rate)) {
    throw new Error(`chaos-injected failure (rate=${chaos.fail_rate})`);
  }
  const handler = handlers[name];
  if (!handler) throw new Error(`unknown handler '${name}'`);
  return handler(payload, ctx);
}
