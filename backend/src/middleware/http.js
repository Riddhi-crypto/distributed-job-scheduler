/** Wrap an async handler so rejected promises reach the error middleware. */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parse ?page & ?limit into safe LIMIT/OFFSET values. */
export function paginate(req, defaultLimit = 25, maxLimit = 100) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit || String(defaultLimit), 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

/** Throwable HTTP error carrying a status code. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Express error-handling middleware (registered last). */
export function errorHandler(err, req, res, _next) {
  if (err?.name === 'ZodError') {
    return res.status(400).json({ error: 'validation failed', details: err.errors });
  }
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'internal error' });
}
