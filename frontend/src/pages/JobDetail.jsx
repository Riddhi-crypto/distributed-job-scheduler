import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Card, Icon, Badge, usePoll, Banner, EmptyState, LoadingFull, fmtDuration, fmtTime, timeAgo, shortId } from '../components/ui.jsx';

export default function JobDetail() {
  const { id } = useParams();
  const { data: job, loading, error, refresh } = usePoll(() => api.get(`/jobs/${id}`), 3000, [id]);
  const { data: execs } = usePoll(() => api.get(`/jobs/${id}/executions`), 3000, [id]);
  const { data: logs } = usePoll(() => api.get(`/jobs/${id}/logs`), 3000, [id]);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function act(kind) {
    setMsg(null);
    setBusy(true);
    try {
      await api.post(`/jobs/${id}/${kind}`);
      setMsg({ kind: 'ok', text: kind === 'retry' ? 'Job requeued.' : 'Job cancelled.' });
      refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !job) return <LoadingFull />;
  if (error) return <Banner kind="err">{error.message}</Banner>;

  const canRetry = ['failed', 'dead_letter'].includes(job.status);
  const canCancel = ['queued', 'scheduled'].includes(job.status);
  const executions = execs?.data || [];
  const logLines = logs?.data || [];

  return (
    <>
      <Link to="/jobs" className="back-link"><Icon.back style={{ width: 16, height: 16 }} /> All jobs</Link>

      <div className="between" style={{ marginBottom: 18 }}>
        <div className="row wrap">
          <h2 style={{ margin: 0, fontSize: 22 }} className="mono">{job.handler}</h2>
          <Badge status={job.status} />
          <span className="id-chip">{shortId(job.id)}</span>
        </div>
        <div className="row">
          {canRetry && <button className="btn primary sm" disabled={busy} onClick={() => act('retry')}>Retry now</button>}
          {canCancel && <button className="btn danger sm" disabled={busy} onClick={() => act('cancel')}>Cancel</button>}
        </div>
      </div>

      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      {job.last_error && <Banner kind="err">Last error: {job.last_error}</Banner>}

      <div className="detail-grid">
        <Card title="Details" icon={Icon.jobs}>
          <dl className="kv">
            <dt>Queue</dt><dd>{job.queue_name}</dd>
            <dt>Kind</dt><dd>{job.kind}</dd>
            <dt>Priority</dt><dd>{job.priority}</dd>
            <dt>Attempt</dt><dd>{job.attempt} / {job.max_attempts}</dd>
            <dt>Timeout</dt><dd>{job.timeout_sec}s</dd>
            <dt>Retry policy</dt><dd>{job.retry_policy_name || 'default'}{job.strategy ? ` (${job.strategy})` : ''}</dd>
            <dt>Fence token</dt><dd>{job.fence_token}</dd>
            <dt>Run at</dt><dd>{fmtTime(job.run_at)}</dd>
            <dt>Created</dt><dd>{timeAgo(job.created_at)} ago</dd>
            {job.completed_at && (<><dt>Completed</dt><dd>{fmtTime(job.completed_at)}</dd></>)}
            {job.depends_on?.length > 0 && (<><dt>Depends on</dt><dd>{job.depends_on.map(shortId).join(', ')}</dd></>)}
          </dl>
          <div style={{ marginTop: 16 }}>
            <div className="stat-label" style={{ marginBottom: 8 }}>Payload</div>
            <pre className="input mono" style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify(job.payload, null, 2)}
            </pre>
          </div>
        </Card>

        <div className="stack" style={{ gap: 16 }}>
          <Card title="Execution History" icon={Icon.activity} hint={`${executions.length} attempt${executions.length === 1 ? '' : 's'}`} bodyPad={false}>
            {executions.length === 0 ? (
              <EmptyState icon={Icon.activity} title="Not executed yet">This job hasn't been claimed by a worker.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>#</th><th>Status</th><th>Worker</th><th>Duration</th><th>Started</th><th>Error</th></tr>
                  </thead>
                  <tbody>
                    {executions.map((e) => (
                      <tr key={e.id} style={{ cursor: 'default' }}>
                        <td className="mono">{e.attempt}</td>
                        <td><Badge status={e.status} /></td>
                        <td className="c-muted mono" style={{ fontSize: 12 }}>{e.worker_name || '—'}</td>
                        <td className="mono">{fmtDuration(e.duration_ms)}</td>
                        <td className="c-muted">{fmtTime(e.started_at)}</td>
                        <td className="c-dead" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.error || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Logs" icon={Icon.jobs} hint="newest first">
            {logLines.length === 0 ? (
              <EmptyState icon={Icon.jobs} title="No log lines" />
            ) : (
              <div style={{ maxHeight: 300, overflow: 'auto' }}>
                {logLines.map((l) => (
                  <div className="logline" key={l.id}>
                    <span className={`lvl ${l.level}`}>{l.level}</span>
                    <span className="faint" style={{ flex: 'none' }}>{fmtTime(l.ts)}</span>
                    <span style={{ color: 'var(--text)' }}>{l.message}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
