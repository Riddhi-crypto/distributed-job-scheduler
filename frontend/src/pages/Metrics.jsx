import { useState } from 'react';
import { api } from '../api.js';
import {
  Card, Icon, StatCard, usePoll, Banner, LoadingFull, ThroughputChart, fmtDuration,
} from '../components/ui.jsx';

const WINDOWS = [
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '3h', minutes: 180 },
];

export default function Metrics() {
  const [minutes, setMinutes] = useState(30);

  const tp = usePoll(() => api.get(`/metrics/throughput?minutes=${minutes}`), 5000, [minutes]);
  const ov = usePoll(() => api.get('/metrics/overview'), 4000);

  if (tp.loading && !tp.data) return <LoadingFull />;

  const series = tp.data?.data || [];
  const o = ov.data || {};
  const totalDone = series.reduce((s, d) => s + (d.done || 0), 0);
  const totalFailed = series.reduce((s, d) => s + (d.failed || 0), 0);
  const successRate = totalDone + totalFailed > 0
    ? Math.round((totalDone / (totalDone + totalFailed)) * 100)
    : 100;

  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 22 }}>
        <StatCard label="Done / min" value={o.done_per_min ?? 0} color="done" live={(o.done_per_min ?? 0) > 0} />
        <StatCard label="Failed / min" value={o.failed_per_min ?? 0} color="failed" live={(o.failed_per_min ?? 0) > 0} />
        <StatCard label="In flight" value={o.in_flight ?? 0} color="running" live={(o.in_flight ?? 0) > 0} />
        <StatCard label="Avg duration" value={fmtDuration(o.avg_duration_ms ?? 0)} color="accent" />
      </div>

      <Banner kind="err">{tp.error?.message}</Banner>

      <Card
        title="Throughput"
        icon={Icon.chart}
        hint="done vs failed per minute"
        bodyPad={false}
      >
        <div className="card-pad">
          <div className="between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 12 }}>
            <div className="row wrap" style={{ gap: 18, fontSize: 13, color: 'var(--muted)' }}>
              <span>completed <b className="tabular" style={{ color: 'var(--done)' }}>{totalDone}</b></span>
              <span>failed <b className="tabular" style={{ color: 'var(--failed)' }}>{totalFailed}</b></span>
              <span>success rate <b className="tabular" style={{ color: successRate >= 90 ? 'var(--done)' : 'var(--failed)' }}>{successRate}%</b></span>
            </div>
            <div className="seg" role="tablist" aria-label="time window">
              {WINDOWS.map((w) => (
                <button
                  key={w.minutes}
                  className={`btn sm ${minutes === w.minutes ? 'primary' : 'ghost'}`}
                  onClick={() => setMinutes(w.minutes)}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>

          <ThroughputChart data={series} height={280} />

          <p className="faint" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            Each bar is one minute of execution history over the last {minutes} minutes, sampled from the
            <code style={{ fontFamily: 'var(--mono)', margin: '0 4px' }}>job_executions</code> ledger. Green is completed, amber is failed.
          </p>
        </div>
      </Card>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 22 }}>
        <Card title="Pending" icon={Icon.queue}>
          <div className="tabular" style={{ fontSize: 34, fontFamily: 'var(--mono)', color: 'var(--pending)' }}>{o.pending ?? 0}</div>
          <div className="faint" style={{ fontSize: 12 }}>queued or scheduled, awaiting a worker</div>
        </Card>
        <Card title="Dead letters" icon={Icon.skull}>
          <div className="tabular" style={{ fontSize: 34, fontFamily: 'var(--mono)', color: 'var(--dead)' }}>{o.dead_letters ?? 0}</div>
          <div className="faint" style={{ fontSize: 12 }}>exhausted all retries</div>
        </Card>
        <Card title="Workers alive" icon={Icon.workers}>
          <div className="tabular" style={{ fontSize: 34, fontFamily: 'var(--mono)', color: 'var(--done)' }}>
            {o.workers_alive ?? 0}<span className="faint" style={{ fontSize: 18 }}> / {o.workers_total ?? 0}</span>
          </div>
          <div className="faint" style={{ fontSize: 12 }}>heartbeating in the last 45s</div>
        </Card>
      </div>
    </>
  );
}
