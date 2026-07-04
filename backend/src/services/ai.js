/**
 * Diagnose why a job died. Returns { category, summary, confidence, fix }.
 *
 * Default is a fast, deterministic heuristic over the error text + handler so
 * the demo works with zero external dependencies. If AI_API_KEY is set you can
 * swap `classify` for a real LLM call (Anthropic/OpenAI) behind the same shape.
 */
const RULES = [
  {
    match: /timeout|timed out|deadline|exceeded.*time/i,
    category: 'TIMEOUT',
    summary: 'The handler exceeded its execution time budget and was terminated before it could finish.',
    fix: "Raise the job's timeout_sec, optimise the handler, or check whether a downstream dependency is slow.",
    confidence: 0.88,
  },
  {
    match: /econnrefused|connection refused|network|dns|getaddrinfo|socket hang up/i,
    category: 'NETWORK',
    summary: 'A network call failed — the target service was unreachable or refused the connection.',
    fix: 'Verify the dependency is up, check service discovery/DNS, and add a circuit breaker for the call.',
    confidence: 0.82,
  },
  {
    match: /out of memory|heap|oom|allocation failed/i,
    category: 'RESOURCE',
    summary: 'The worker ran out of memory while processing the job.',
    fix: 'Stream large payloads instead of buffering, lower worker concurrency, or increase memory limits.',
    confidence: 0.8,
  },
  {
    match: /401|403|unauthor|forbidden|permission|token/i,
    category: 'AUTH',
    summary: 'The job failed an authorization/permission check against a downstream system.',
    fix: 'Rotate or refresh credentials and confirm the service account has the required scopes.',
    confidence: 0.78,
  },
  {
    match: /validation|invalid|schema|parse|unexpected token|bad request|400/i,
    category: 'BAD_INPUT',
    summary: 'The job payload was malformed or failed validation inside the handler.',
    fix: 'Validate payloads at enqueue time and reject bad input before it reaches the worker.',
    confidence: 0.85,
  },
];

export function classifyFailure({ error = '', handler = '' } = {}) {
  const text = `${error} ${handler}`;
  for (const rule of RULES) {
    if (rule.match.test(text)) {
      return {
        category: rule.category,
        summary: rule.summary,
        fix: rule.fix,
        confidence: rule.confidence,
      };
    }
  }
  return {
    category: 'UNKNOWN',
    summary: 'The job failed for a reason that does not match a known pattern.',
    fix: 'Inspect the execution logs and stack trace for this job to identify the root cause.',
    confidence: 0.4,
  };
}
