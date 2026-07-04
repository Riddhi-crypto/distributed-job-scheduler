import { useState } from 'react';
import { api } from '../api.js';
import { Card, Icon, Badge, StatCard, usePoll, Banner, EmptyState, LoadingFull, timeAgo, shortId } from '../components/ui.jsx';

function WorkerCard({ w, onKill }) {
  const alive = w.is_alive;
  const pct = w.concurrency > 0 ? Math.min(100, Math.round((w.running_count / w.concurrency) * 100)) : 0;
  return (
    <div className={`wcard ${alive ? 'alive' : 'dead'}`}>
      <div className="between">
        <div>
          <div className="row">
            <span className={`live-dot ${alive ? '' : 'stale'}`} />
            <span className="wcard-name">{w.name}</span>
          </div>
          <div className="wcard-id">{shortId(w.id)} · {w.hostname || 'unknown host'}</div>
        </div>
        <Badge className={alive ? 'ok' : 'warn'}>{alive ? 'alive' : w.status}</Badge>
      </div>

      <div className="wcard-meter" title={`${w.running_count} / ${w.concurrency} slots`}>
        <span style={{ width: `${pct}%`, background: alive ? 'var(--running)' : 'var(--dead)' }} />
      </div>

      <div className="wcard-foot">
        <span>running <b>{w.running_count}</b> / {w.concurrency}</span>
        <span>heartbeat <b>{timeAgo(w.last_heartbeat)}</b> ago</span>
      </div>

      {alive && (
        <button className="btn danger sm block" style={{ marginTop: 14 }} onClick={() => onKill(w)}>
          Kill worker
        </button>
      )}
    </div>
  );
}

export default function Workers() {
  const { data, loading, error, refresh } = usePoll(() => api.get('/workers'), 2500);
  const [msg, setMsg] = useState(null);

  async function kill(w) {
    setMsg(null);
    try {
      const r = await api.post(`/chaos/kill-worker/${w.id}`);
      setMsg({ kind: 'ok', text: `Killed ${w.name} — ${r.jobsRequeued} in-flight job(s) requeued for recovery.` });
      refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    }
  }

  if (loading && !data) return <LoadingFull />;
  const workers = data?.data || [];

  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 22 }}>
        <StatCard label="Alive" value={data?.alive ?? 0} color="done" live={(data?.alive ?? 0) > 0} />
        <StatCard label="Total" value={data?.total ?? 0} color="accent" />
        <StatCard label="Running now" value={workers.reduce((s, w) => s + (w.is_alive ? w.running_count : 0), 0)} color="running" live />
      </div>

      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      <Banner kind="err">{error?.message}</Banner>

      <Card title="Worker Fleet" icon={Icon.workers} hint={`${data?.alive ?? 0} active / ${data?.total ?? 0} total`}>
        {workers.length === 0 ? (
          <EmptyState icon={Icon.workers} title="No workers registered">
            Start a worker with <code style={{ fontFamily: 'var(--mono)' }}>npm start</code> in the <b>worker/</b> directory. It'll appear here within a heartbeat.
          </EmptyState>
        ) : (
          <div className="fleet">
            {workers.map((w) => <WorkerCard key={w.id} w={w} onKill={kill} />)}
          </div>
        )}
      </Card>
    </>
  );
}
