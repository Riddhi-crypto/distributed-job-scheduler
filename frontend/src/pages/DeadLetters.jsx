import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import {
  Card, Icon, Badge, StatCard, usePoll, Banner, EmptyState, LoadingFull,
  timeAgo, shortId,
} from '../components/ui.jsx';

// Map an AI failure category to one of the existing badge colour variants so the
// insight cards stay visually consistent with the rest of the console.
const CATEGORY_CLASS = {
  TIMEOUT: 'shard',       // indigo
  NETWORK: 'st-running',  // cyan
  RESOURCE: 'st-failed',  // amber
  AUTH: 'warn',           // rose
  BAD_INPUT: 'st-queued', // blue
  UNKNOWN: '',            // neutral
};

function confidenceColor(c) {
  if (c >= 0.8) return 'var(--done)';
  if (c >= 0.55) return 'var(--failed)';
  return 'var(--faint)';
}

function InsightCard({ d, onRequeue, busy }) {
  const pct = Math.round((d.ai_confidence ?? 0) * 100);
  return (
    <div className="ai">
      <div className="ai-head">
        <Badge className={CATEGORY_CLASS[d.ai_category] ?? ''}>{d.ai_category || 'unknown'}</Badge>
        {d.handler && <Badge>{d.handler}</Badge>}
        <span className="ai-conf" style={{ color: confidenceColor(d.ai_confidence ?? 0) }}>
          confidence {pct}%
        </span>
      </div>

      <p className="ai-summary">{d.ai_summary || 'No diagnosis available for this failure.'}</p>

      {d.ai_fix && (
        <div className="ai-fix">
          <b>Suggested fix:</b> {d.ai_fix}
        </div>
      )}

      <div className="between" style={{ marginTop: 16, flexWrap: 'wrap', gap: 10 }}>
        <div className="row wrap" style={{ gap: 8, fontSize: 12, color: 'var(--faint)' }}>
          <span>queue <b style={{ color: 'var(--muted)' }}>{d.queue_name}</b></span>
          <span>·</span>
          <span>{d.attempts} attempt{d.attempts === 1 ? '' : 's'}</span>
          <span>·</span>
          <span>{timeAgo(d.created_at)} ago</span>
          {d.job_id && (
            <>
              <span>·</span>
              <Link to={`/jobs/${d.job_id}`} className="mono" style={{ color: 'var(--accent-2)', fontFamily: 'var(--mono)' }}>
                {shortId(d.job_id)}
              </Link>
            </>
          )}
        </div>
        <button className="btn primary sm" disabled={busy} onClick={() => onRequeue(d)}>
          <Icon.bolt style={{ width: 15, height: 15 }} /> Requeue job
        </button>
      </div>

      {d.reason && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--faint)' }}>raw error</summary>
          <pre className="mono" style={{
            marginTop: 8, fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'pre-wrap',
            wordBreak: 'break-word', background: 'var(--bg-2)', padding: 12, borderRadius: 8,
            border: '1px solid var(--border)',
          }}>{d.reason}</pre>
        </details>
      )}
    </div>
  );
}

export default function DeadLetters() {
  const { data, loading, error, refresh } = usePoll(() => api.get('/dead-letters?limit=50'), 5000);
  const [msg, setMsg] = useState(null);
  const [busyId, setBusyId] = useState(null);

  async function requeue(d) {
    setMsg(null);
    setBusyId(d.id);
    try {
      await api.post(`/dead-letters/${d.id}/requeue`);
      setMsg({ kind: 'ok', text: `Job ${shortId(d.job_id)} requeued — it will be re-attempted from a clean slate.` });
      refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: e.message });
    } finally {
      setBusyId(null);
    }
  }

  if (loading && !data) return <LoadingFull />;
  const items = data?.data || [];

  return (
    <>
      <div className="kpis" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 22 }}>
        <StatCard label="Dead letters" value={items.length} color="dead" live={items.length > 0} />
        <StatCard
          label="Auto-diagnosed"
          value={items.filter((d) => d.ai_category && d.ai_category !== 'UNKNOWN').length}
          color="accent"
        />
        <StatCard
          label="Timeouts"
          value={items.filter((d) => d.ai_category === 'TIMEOUT').length}
          color="running"
        />
      </div>

      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      <Banner kind="err">{error?.message}</Banner>

      <Card
        title="AI Failure Insights"
        icon={Icon.spark}
        hint="auto-diagnosed dead letters"
        bodyPad={false}
      >
        <div className="card-pad">
          {items.length === 0 ? (
            <EmptyState icon={Icon.skull} title="No dead letters">
              Nothing has exhausted its retries. Permanently failed jobs land here with an automatic diagnosis and a one-click requeue.
            </EmptyState>
          ) : (
            <div className="grid" style={{ gap: 14 }}>
              {items.map((d) => (
                <InsightCard key={d.id} d={d} onRequeue={requeue} busy={busyId === d.id} />
              ))}
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
