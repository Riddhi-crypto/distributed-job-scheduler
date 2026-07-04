import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Card, Icon, Badge, usePoll, Banner, LoadingFull, Field, ThroughputChart, Sparkline, fmtTime } from '../components/ui.jsx';

export default function QueueDetail() {
  const { id } = useParams();
  const { data: q, loading, error, refresh } = usePoll(() => api.get(`/queues/${id}`), 4000, [id]);
  const { data: stats } = usePoll(() => api.get(`/queues/${id}/stats`), 5000, [id]);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  // seed the editable form once the queue loads (don't clobber user edits on poll)
  useEffect(() => {
    if (q && !form) {
      setForm({
        priority: q.priority,
        concurrencyLimit: q.concurrency_limit,
        rateLimitPerSec: q.rate_limit_per_sec ?? '',
      });
    }
  }, [q, form]);

  async function save(e) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await api.patch(`/queues/${id}`, {
        priority: Number(form.priority),
        concurrencyLimit: Number(form.concurrencyLimit),
        rateLimitPerSec: form.rateLimitPerSec === '' ? null : Number(form.rateLimitPerSec),
      });
      setMsg({ kind: 'ok', text: 'Configuration saved.' });
      refresh();
    } catch (e2) {
      setMsg({ kind: 'err', text: e2.message });
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    await api.post(`/queues/${id}/${q.is_paused ? 'resume' : 'pause'}`);
    refresh();
  }

  if (loading && !q) return <LoadingFull />;
  if (error) return <Banner kind="err">{error.message}</Banner>;

  const chartData = (stats?.data || []).map((r) => ({ t: fmtTime(r.minute), done: r.completed, failed: r.failed }));
  const latency = (stats?.data || []).map((r) => r.avg_ms || 0);

  return (
    <>
      <Link to="/queues" className="back-link"><Icon.back style={{ width: 16, height: 16 }} /> All queues</Link>

      <div className="between" style={{ marginBottom: 18 }}>
        <div className="row">
          <h2 style={{ margin: 0, fontSize: 24 }}>{q.name}</h2>
          <Badge className={q.is_paused ? 'warn' : 'ok'}>{q.is_paused ? 'paused' : 'active'}</Badge>
          <Badge className="shard">shard {q.shard}</Badge>
        </div>
        <button className={`btn ${q.is_paused ? 'primary' : 'danger'}`} onClick={toggle}>
          {q.is_paused ? 'Resume queue' : 'Pause queue'}
        </button>
      </div>

      <div className="kpis" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        <MiniStat n={q.pending} label="pending" c="pending" />
        <MiniStat n={q.running} label="running" c="running" />
        <MiniStat n={q.done} label="done" c="done" />
        <MiniStat n={q.failed} label="failed" c="failed" />
        <MiniStat n={q.dead} label="dead" c="dead" />
      </div>

      <div className="grid two-col section-gap" style={{ gridTemplateColumns: '1fr 1.5fr', alignItems: 'start' }}>
        <Card title="Configuration" icon={Icon.queue}>
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          {form && (
            <form onSubmit={save} className="spread">
              <Field label="Priority" hint="higher-priority queues drain first">
                <input className="input mono" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
              </Field>
              <Field label="Concurrency limit" hint="max jobs running at once across the fleet">
                <input className="input mono" type="number" min="0" value={form.concurrencyLimit} onChange={(e) => setForm({ ...form, concurrencyLimit: e.target.value })} />
              </Field>
              <Field label="Rate limit / sec" hint="blank = unlimited">
                <input className="input mono" type="number" min="0" value={form.rateLimitPerSec} onChange={(e) => setForm({ ...form, rateLimitPerSec: e.target.value })} placeholder="unlimited" />
              </Field>
              <button className="btn primary block" disabled={busy}>Save configuration</button>
            </form>
          )}
        </Card>

        <div className="stack" style={{ gap: 16 }}>
          <Card title="Throughput" icon={Icon.chart} hint="last hour · per minute">
            <ThroughputChart data={chartData} />
          </Card>
          <Card title="Average latency" icon={Icon.activity} hint="ms per minute">
            <Sparkline points={latency} color="running" />
          </Card>
        </div>
      </div>
    </>
  );
}

function MiniStat({ n, label, c }) {
  return (
    <div className="stat" style={{ minHeight: 96, '--c': `var(--${c})` }}>
      <span className={`stat-dot bg-${c}`} />
      <div className={`stat-val tabular c-${c}`} style={{ fontSize: 28 }}>{n ?? 0}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-bar" />
    </div>
  );
}
