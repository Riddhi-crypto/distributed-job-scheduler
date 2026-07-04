import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Card, Icon, Badge, usePoll, Banner, EmptyState, LoadingFull, Field, shortId, timeAgo } from '../components/ui.jsx';

const STATUSES = ['', 'queued', 'scheduled', 'claimed', 'running', 'completed', 'failed', 'dead_letter', 'cancelled'];
const HANDLERS = ['echo', 'sleep', 'cpu', 'http', 'fail'];
const KINDS = ['immediate', 'delayed', 'scheduled', 'recurring', 'batch'];

export default function Jobs() {
  const nav = useNavigate();
  const [filters, setFilters] = useState({ queueId: '', status: '', handler: '' });
  const [page, setPage] = useState(1);
  const limit = 20;

  const qs = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (filters.queueId) qs.set('queueId', filters.queueId);
  if (filters.status) qs.set('status', filters.status);
  if (filters.handler) qs.set('handler', filters.handler);

  const { data, loading, error, refresh } = usePoll(() => api.get(`/jobs?${qs.toString()}`), 4000, [qs.toString()]);
  const { data: queues } = usePoll(() => api.get('/queues'), 15000);

  const jobs = data?.data || [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const queueList = queues?.data || [];

  function setFilter(k, v) {
    setPage(1);
    setFilters((f) => ({ ...f, [k]: v }));
  }

  return (
    <div className="grid two-col" style={{ gridTemplateColumns: '1.7fr 1fr', alignItems: 'start' }}>
      <div className="stack" style={{ gap: 16 }}>
        <Card title="Job Explorer" icon={Icon.jobs} hint={`${total} job${total === 1 ? '' : 's'}`} bodyPad={false}>
          <div className="card-pad" style={{ paddingBottom: 12 }}>
            <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
              <Field label="Queue">
                <select className="select" value={filters.queueId} onChange={(e) => setFilter('queueId', e.target.value)}>
                  <option value="">all queues</option>
                  {queueList.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                </select>
              </Field>
              <Field label="Status">
                <select className="select" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s ? s.replace('_', ' ') : 'all statuses'}</option>)}
                </select>
              </Field>
              <Field label="Handler">
                <input className="input" list="handlers" value={filters.handler} onChange={(e) => setFilter('handler', e.target.value)} placeholder="any" />
                <datalist id="handlers">{HANDLERS.map((h) => <option key={h} value={h} />)}</datalist>
              </Field>
            </div>
          </div>

          <Banner kind="err">{error?.message}</Banner>

          {loading && !data ? (
            <LoadingFull />
          ) : jobs.length === 0 ? (
            <EmptyState icon={Icon.jobs} title="No jobs match">Adjust the filters, or submit a job on the right.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>ID</th><th>Handler</th><th>Queue</th><th>Kind</th><th>Status</th><th>Attempt</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id} onClick={() => nav(`/jobs/${j.id}`)}>
                      <td className="id-chip">{shortId(j.id)}</td>
                      <td className="mono" style={{ color: 'var(--text)' }}>{j.handler}</td>
                      <td className="c-muted">{j.queue_name}</td>
                      <td className="c-muted mono" style={{ fontSize: 12 }}>{j.kind}</td>
                      <td><Badge status={j.status} /></td>
                      <td className="mono">{j.attempt}/{j.max_attempts}</td>
                      <td className="c-muted">{timeAgo(j.created_at)} ago</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="pagination">
            <button className="btn sm ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
            <span className="mono">page {page} / {pages}</span>
            <button className="btn sm ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </Card>
      </div>

      <SubmitJob queues={queueList} onSubmitted={refresh} />
    </div>
  );
}

function SubmitJob({ queues, onSubmitted }) {
  const [f, setF] = useState({
    queueId: '', handler: 'echo', kind: 'immediate', payload: '{\n  "ms": 500\n}',
    priority: '', maxAttempts: '', timeoutSec: '', idempotencyKey: '',
    delaySeconds: 10, runAt: '', cronExpression: '*/5 * * * *', items: '[{ "n": 1 }, { "n": 2 }]',
  });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  async function submit(e) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const body = {
        queueId: f.queueId || queues[0]?.id,
        handler: f.handler,
        kind: f.kind,
      };
      if (f.priority) body.priority = Number(f.priority);
      if (f.maxAttempts) body.maxAttempts = Number(f.maxAttempts);
      if (f.timeoutSec) body.timeoutSec = Number(f.timeoutSec);
      if (f.idempotencyKey) body.idempotencyKey = f.idempotencyKey;

      if (f.kind === 'batch') {
        body.items = JSON.parse(f.items);
      } else {
        body.payload = f.payload.trim() ? JSON.parse(f.payload) : {};
      }
      if (f.kind === 'delayed') body.delaySeconds = Number(f.delaySeconds);
      if (f.kind === 'scheduled') body.runAt = new Date(f.runAt).toISOString();
      if (f.kind === 'recurring') body.cronExpression = f.cronExpression;

      const res = await api.post('/jobs', body);
      const id = res.id || res.jobIds?.[0] || res.schedule?.id;
      setMsg({ kind: 'ok', text: `Enqueued ${f.kind} job${id ? ` · ${shortId(id)}` : ''}.` });
      onSubmitted?.();
    } catch (e2) {
      setMsg({ kind: 'err', text: e2.message.includes('JSON') ? 'Payload is not valid JSON.' : e2.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Submit a Job" icon={Icon.bolt}>
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      <form onSubmit={submit} className="spread">
        <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Queue">
            <select className="select" value={f.queueId} onChange={(e) => set('queueId', e.target.value)}>
              {queues.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          </Field>
          <Field label="Handler">
            <select className="select" value={f.handler} onChange={(e) => set('handler', e.target.value)}>
              {HANDLERS.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Kind">
          <select className="select" value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Field>

        {f.kind === 'delayed' && (
          <Field label="Delay (seconds)"><input className="input mono" type="number" min="0" value={f.delaySeconds} onChange={(e) => set('delaySeconds', e.target.value)} /></Field>
        )}
        {f.kind === 'scheduled' && (
          <Field label="Run at"><input className="input" type="datetime-local" value={f.runAt} onChange={(e) => set('runAt', e.target.value)} required /></Field>
        )}
        {f.kind === 'recurring' && (
          <Field label="Cron expression" hint="standard 5-field cron"><input className="input mono" value={f.cronExpression} onChange={(e) => set('cronExpression', e.target.value)} /></Field>
        )}

        {f.kind === 'batch' ? (
          <Field label="Items (JSON array)" hint="one job per element">
            <textarea className="textarea mono" rows={5} value={f.items} onChange={(e) => set('items', e.target.value)} />
          </Field>
        ) : (
          <Field label="Payload (JSON)">
            <textarea className="textarea mono" rows={4} value={f.payload} onChange={(e) => set('payload', e.target.value)} />
          </Field>
        )}

        <details>
          <summary className="hint-text" style={{ cursor: 'pointer' }}>Advanced (priority, retries, timeout, idempotency)</summary>
          <div className="spread" style={{ marginTop: 12 }}>
            <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
              <Field label="Priority"><input className="input mono" type="number" value={f.priority} onChange={(e) => set('priority', e.target.value)} placeholder="100" /></Field>
              <Field label="Max attempts"><input className="input mono" type="number" min="1" value={f.maxAttempts} onChange={(e) => set('maxAttempts', e.target.value)} placeholder="policy" /></Field>
              <Field label="Timeout s"><input className="input mono" type="number" min="1" value={f.timeoutSec} onChange={(e) => set('timeoutSec', e.target.value)} placeholder="60" /></Field>
            </div>
            <Field label="Idempotency key" hint="repeat enqueues with the same key collapse to one job">
              <input className="input mono" value={f.idempotencyKey} onChange={(e) => set('idempotencyKey', e.target.value)} placeholder="optional" />
            </Field>
          </div>
        </details>

        <button className="btn primary block" disabled={busy}>Enqueue {f.kind} job</button>
      </form>
    </Card>
  );
}
