import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Card, Icon, Badge, usePoll, Banner, EmptyState, LoadingFull, Field } from '../components/ui.jsx';

function QueueCard({ q, onToggle }) {
  const metrics = [
    ['pending', q.pending, 'c-pending'],
    ['running', q.running, 'c-running'],
    ['done', q.done, 'c-done'],
    ['failed', q.failed, 'c-failed'],
    ['dead', q.dead, 'c-dead'],
  ];
  return (
    <div className="qcard">
      <div className="between">
        <div className="qcard-title">
          <Link to={`/queues/${q.id}`}><h4>{q.name}</h4></Link>
          <Badge className={q.is_paused ? 'warn' : 'ok'}>{q.is_paused ? 'paused' : 'active'}</Badge>
          <Badge className="shard">shard {q.shard}</Badge>
        </div>
        <button className={`btn sm ${q.is_paused ? 'primary' : 'ghost'}`} onClick={() => onToggle(q)}>
          {q.is_paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      <div className="qmetrics">
        {metrics.map(([label, n, c]) => (
          <div className="qmetric" key={label}>
            <div className={`n ${c}`}>{n ?? 0}</div>
            <div className="l">{label}</div>
          </div>
        ))}
      </div>

      <div className="between" style={{ marginTop: 12 }}>
        <span className="hint-text">priority {q.priority} · concurrency {q.concurrency_limit}{q.rate_limit_per_sec ? ` · ${q.rate_limit_per_sec}/s` : ''}</span>
        <Link to={`/queues/${q.id}`} className="c-accent" style={{ fontSize: 13, fontWeight: 600 }}>Configure →</Link>
      </div>
    </div>
  );
}

export default function Queues() {
  const { data, loading, error, refresh } = usePoll(() => api.get('/queues'), 4000);
  const { data: projData } = usePoll(() => api.get('/projects'), 20000);
  const [form, setForm] = useState({ projectId: '', name: '', priority: 100, concurrencyLimit: 10, shard: 0 });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function toggle(q) {
    try {
      await api.post(`/queues/${q.id}/${q.is_paused ? 'resume' : 'pause'}`);
      refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    }
  }

  async function create(e) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await api.post('/queues', {
        projectId: form.projectId || projData?.data?.[0]?.id,
        name: form.name,
        priority: Number(form.priority),
        concurrencyLimit: Number(form.concurrencyLimit),
        shard: Number(form.shard),
      });
      setForm((f) => ({ ...f, name: '' }));
      setMsg({ kind: 'ok', text: 'Queue created.' });
      refresh();
    } catch (e2) {
      setMsg({ kind: 'err', text: e2.message });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <LoadingFull />;
  const queues = data?.data || [];
  const projects = projData?.data || [];

  return (
    <>
      <Banner kind="err">{error?.message}</Banner>
      <div className="grid two-col" style={{ gridTemplateColumns: '1.7fr 1fr', alignItems: 'start' }}>
        <div className="stack" style={{ gap: 16 }}>
          {queues.length === 0 ? (
            <Card title="Queue Health" icon={Icon.queue}>
              <EmptyState icon={Icon.queue} title="No queues yet">Create a queue to start scheduling work.</EmptyState>
            </Card>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
              {queues.map((q) => <QueueCard key={q.id} q={q} onToggle={toggle} />)}
            </div>
          )}
        </div>

        <Card title="New Queue" icon={Icon.plus}>
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          <form onSubmit={create} className="spread">
            <Field label="Project">
              <select className="select" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Name">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="emails" required />
            </Field>
            <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Field label="Priority" hint="higher drains first">
                <input className="input mono" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
              </Field>
              <Field label="Concurrency">
                <input className="input mono" type="number" min="0" value={form.concurrencyLimit} onChange={(e) => setForm({ ...form, concurrencyLimit: e.target.value })} />
              </Field>
            </div>
            <Field label="Shard" hint="queue sharding for horizontal fan-out">
              <input className="input mono" type="number" value={form.shard} onChange={(e) => setForm({ ...form, shard: e.target.value })} />
            </Field>
            <button className="btn primary block" disabled={busy || !form.name}>Create queue</button>
          </form>
        </Card>
      </div>
    </>
  );
}
