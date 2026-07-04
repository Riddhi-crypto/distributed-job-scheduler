import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Card, StatCard, Badge, Icon, usePoll, fmtTime, fmtDuration, shortId, LoadingFull, Banner, EmptyState } from '../components/ui.jsx';

const EVENT_STATUS = { enqueued: 'queued', running: 'running', completed: 'completed', failed: 'failed' };

function EventRow({ e }) {
  const st = EVENT_STATUS[e.event] || e.status;
  return (
    <div className="ev">
      <span className="ev-time">{fmtTime(e.ts)}</span>
      <span className="ev-tag"><Badge status={st}>{e.event}</Badge></span>
      <span className="ev-msg">
        <b>{e.handler}</b> {e.event} <span className="faint">({e.queue_name})</span>
        {e.duration_ms != null && <span className="faint"> · {fmtDuration(e.duration_ms)}</span>}
      </span>
    </div>
  );
}

export default function Overview() {
  const { data: ov, error, loading } = usePoll(() => api.get('/metrics/overview'), 3000);
  const { data: ev } = usePoll(() => api.get('/metrics/events'), 2500);
  const { data: disp } = usePoll(() => api.get('/metrics/dispatcher'), 2000);

  if (loading && !ov) return <LoadingFull />;

  return (
    <>
      <Banner kind="err">{error?.message}</Banner>

      <div className="kpis">
        <StatCard label="In Flight" value={ov?.in_flight ?? 0} color="running" live={ov?.in_flight > 0} />
        <StatCard label="Done / min" value={ov?.done_per_min ?? 0} color="done" live={ov?.done_per_min > 0} />
        <StatCard label="Failed / min" value={ov?.failed_per_min ?? 0} color="failed" live={ov?.failed_per_min > 0} />
        <StatCard label="Dead Letters" value={ov?.dead_letters ?? 0} color="dead" />
        <StatCard label="Workers Alive" value={ov?.workers_alive ?? 0} unit={`/${ov?.workers_total ?? 0}`} color="accent" live={ov?.workers_alive > 0} />
        <StatCard label="Avg Duration" value={ov?.avg_duration_ms ?? 0} unit="ms" color="pending" />
      </div>

      <div className="grid two-col section-gap" style={{ gridTemplateColumns: '1.55fr 1fr' }}>
        <Card title="Live Event Stream" icon={Icon.activity} hint="streaming…" bodyPad={false}>
          {ev?.data?.length ? (
            <div className="stream">
              {ev.data.map((e, i) => <EventRow key={`${e.job_id}-${e.event}-${i}`} e={e} />)}
            </div>
          ) : (
            <EmptyState icon={Icon.activity} title="Nothing happening yet">
              Enqueue a job from the <Link to="/jobs" className="c-accent">Job Explorer</Link> or flood the system in the <Link to="/chaos" className="c-accent">Chaos Lab</Link>.
            </EmptyState>
          )}
        </Card>

        <div className="stack" style={{ gap: 16 }}>
          <div className="leader">
            <div className="row">
              <Badge className="shard" ><Icon.crown style={{ width: 13, height: 13 }} /> Dispatcher Leader</Badge>
              <span style={{ marginLeft: 'auto' }}>
                <Badge className={disp?.holder ? 'ok' : ''}>{disp?.holder ? 'active' : 'no leader'}</Badge>
              </span>
            </div>
            <div className="mono" style={{ marginTop: 14, fontSize: 13, color: 'var(--muted)', wordBreak: 'break-all' }}>
              {disp?.holder || '—'}
            </div>
            <div className="leader-lease">
              <span className="mono"><b className="c-accent">fence token:</b> {disp?.fenceToken ?? 0}</span>
              <span className="mono faint"> · lease {disp?.leaseRemainingSec ?? 0}s remaining</span>
            </div>
            <p className="hint-text" style={{ marginTop: 14, marginBottom: 0, lineHeight: 1.5 }}>
              Run a second API instance for HA — only the lease-holder schedules. Kill it and another takes over within one lease.
            </p>
          </div>

          <Card title="Pipeline" icon={Icon.gauge}>
            <div className="kv">
              <dt>Pending</dt><dd className="c-pending">{ov?.pending ?? 0}</dd>
              <dt>In flight</dt><dd className="c-running">{ov?.in_flight ?? 0}</dd>
              <dt>Dead letters</dt><dd className="c-dead">{ov?.dead_letters ?? 0}</dd>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
