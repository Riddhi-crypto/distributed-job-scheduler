import { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Card, Icon, Badge, Field, usePoll, Banner, LoadingFull, EmptyState, timeAgo, shortId,
} from '../components/ui.jsx';

function Msg({ msg }) {
  if (!msg) return null;
  return <Banner kind={msg.kind}>{msg.text}</Banner>;
}

export default function ChaosLab() {
  const chaos = usePoll(() => api.get('/chaos'), 6000);
  const queues = usePoll(() => api.get('/queues'), 6000);
  const workers = usePoll(() => api.get('/workers'), 3000);

  // fault injection form
  const [failRate, setFailRate] = useState(0);
  const [latencyMs, setLatencyMs] = useState(0);
  const [seeded, setSeeded] = useState(false);

  // flood form
  const [floodQueue, setFloodQueue] = useState('');
  const [floodCount, setFloodCount] = useState(40);
  const [floodHandler, setFloodHandler] = useState('cpu');

  const [injectMsg, setInjectMsg] = useState(null);
  const [floodMsg, setFloodMsg] = useState(null);
  const [killMsg, setKillMsg] = useState(null);

  // Seed the injection sliders once from server state (don't clobber edits after).
  useEffect(() => {
    if (!seeded && chaos.data) {
      setFailRate(Number(chaos.data.fail_rate) || 0);
      setLatencyMs(Number(chaos.data.latency_ms) || 0);
      setSeeded(true);
    }
  }, [chaos.data, seeded]);

  // Default the flood queue to the first available one.
  useEffect(() => {
    if (!floodQueue && queues.data?.data?.length) setFloodQueue(queues.data.data[0].id);
  }, [queues.data, floodQueue]);

  async function inject() {
    setInjectMsg(null);
    try {
      const r = await api.post('/chaos/inject', { failRate: Number(failRate), latencyMs: Number(latencyMs) });
      setInjectMsg({ kind: 'ok', text: `Fault injection armed — ${Math.round(r.fail_rate * 100)}% fail rate, +${r.latency_ms}ms latency on every handler.` });
      chaos.refresh();
    } catch (e) {
      setInjectMsg({ kind: 'err', text: e.message });
    }
  }

  async function clearChaos() {
    setInjectMsg(null);
    try {
      await api.post('/chaos/clear');
      setFailRate(0);
      setLatencyMs(0);
      setInjectMsg({ kind: 'ok', text: 'All chaos cleared. Handlers run clean again.' });
      chaos.refresh();
    } catch (e) {
      setInjectMsg({ kind: 'err', text: e.message });
    }
  }

  async function flood() {
    setFloodMsg(null);
    if (!floodQueue) return setFloodMsg({ kind: 'err', text: 'Pick a queue to flood.' });
    try {
      const r = await api.post('/chaos/flood', {
        queueId: floodQueue,
        count: Number(floodCount),
        handler: floodHandler,
      });
      setFloodMsg({ kind: 'ok', text: `Enqueued ${r.enqueued} "${floodHandler}" jobs. Watch the workers drain them on the Overview.` });
    } catch (e) {
      setFloodMsg({ kind: 'err', text: e.message });
    }
  }

  async function kill(w) {
    setKillMsg(null);
    try {
      const r = await api.post(`/chaos/kill-worker/${w.id}`);
      setKillMsg({ kind: 'ok', text: `Killed ${w.name} — ${r.jobsRequeued} in-flight job(s) reclaimed by the dispatcher and requeued.` });
      workers.refresh();
    } catch (e) {
      setKillMsg({ kind: 'err', text: e.message });
    }
  }

  if (chaos.loading && !chaos.data) return <LoadingFull />;

  const qList = queues.data?.data || [];
  const wList = workers.data?.data || [];
  const aliveWorkers = wList.filter((w) => w.is_alive);
  const active = (Number(chaos.data?.fail_rate) || 0) > 0 || (Number(chaos.data?.latency_ms) || 0) > 0;

  return (
    <>
      <Card
        title="Chaos Lab"
        icon={Icon.bolt}
        hint="prove the self-healing"
        bodyPad={false}
      >
        <div className="card-pad">
          <p className="faint" style={{ marginTop: 0, fontSize: 13 }}>
            Deliberately break things and watch the platform recover. Fault injection and latency are read live by
            every worker; killing a worker forces the dispatcher to reclaim and requeue its jobs.
          </p>

          {/* fault injection */}
          <div className="chaos-op">
            <div className="between">
              <h4>Inject failures &amp; latency</h4>
              <Badge className={active ? 'warn' : 'ok'}>{active ? 'chaos active' : 'clean'}</Badge>
            </div>
            <p>Force handlers to fail (driving retries → dead-letter → AI diagnosis) and add artificial latency.</p>

            <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'end' }}>
              <Field label={`Fail rate — ${Math.round(failRate * 100)}%`} hint="0 = never fail, 1 = always fail">
                <input
                  type="range" min="0" max="1" step="0.05"
                  value={failRate}
                  onChange={(e) => setFailRate(e.target.value)}
                  style={{ accentColor: 'var(--accent)', width: '100%' }}
                />
              </Field>
              <Field label="Added latency (ms)" hint="applied to every handler run">
                <input
                  className="input mono" type="number" min="0" step="50"
                  value={latencyMs}
                  onChange={(e) => setLatencyMs(e.target.value)}
                />
              </Field>
            </div>

            <div className="row" style={{ marginTop: 14, gap: 10 }}>
              <button className="btn indigo" onClick={inject}>Arm injection</button>
              <button className="btn ghost" onClick={clearChaos}>Clear all chaos</button>
              <span className="faint" style={{ fontSize: 12, marginLeft: 'auto', fontFamily: 'var(--mono)' }}>
                live: {Math.round((Number(chaos.data?.fail_rate) || 0) * 100)}% · {chaos.data?.latency_ms || 0}ms
              </span>
            </div>
            <Msg msg={injectMsg} />
          </div>

          {/* flood */}
          <div className="chaos-op">
            <h4>Flood a queue</h4>
            <p>Bulk-enqueue jobs to stress concurrency limits and watch throughput climb.</p>

            <div className="grid" style={{ gridTemplateColumns: '2fr 1fr 1fr', gap: 12, alignItems: 'end' }}>
              <Field label="Queue">
                <select className="select" value={floodQueue} onChange={(e) => setFloodQueue(e.target.value)}>
                  {qList.length === 0 && <option value="">no queues</option>}
                  {qList.map((q) => (
                    <option key={q.id} value={q.id}>{q.name} (shard {q.shard})</option>
                  ))}
                </select>
              </Field>
              <Field label="Count">
                <input
                  className="input mono" type="number" min="1" max="1000"
                  value={floodCount}
                  onChange={(e) => setFloodCount(e.target.value)}
                />
              </Field>
              <Field label="Handler">
                <select className="select" value={floodHandler} onChange={(e) => setFloodHandler(e.target.value)}>
                  <option value="cpu">cpu</option>
                  <option value="echo">echo</option>
                  <option value="sleep">sleep</option>
                  <option value="http">http</option>
                  <option value="fail">fail</option>
                </select>
              </Field>
            </div>

            <button className="btn primary" style={{ marginTop: 14 }} onClick={flood} disabled={!floodQueue}>
              <Icon.bolt style={{ width: 15, height: 15 }} /> Flood {floodCount} jobs
            </button>
            <Msg msg={floodMsg} />
          </div>

          {/* kill worker */}
          <div className="chaos-op">
            <h4>Kill a worker</h4>
            <p>Simulate a crash. The worker flatlines and the dispatcher requeues its in-flight jobs for another worker to pick up.</p>

            <Msg msg={killMsg} />

            {aliveWorkers.length === 0 ? (
              <EmptyState icon={Icon.workers} title="No live workers">
                Start a worker to have something to kill.
              </EmptyState>
            ) : (
              <div className="grid" style={{ gap: 10 }}>
                {aliveWorkers.map((w) => (
                  <div key={w.id} className="between" style={{
                    padding: '12px 14px', border: '1px solid var(--border)',
                    borderRadius: 10, background: 'var(--surface)',
                  }}>
                    <div className="row" style={{ gap: 10 }}>
                      <span className="live-dot" />
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{w.name}</div>
                        <div className="faint" style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                          {shortId(w.id)} · running {w.running_count}/{w.concurrency} · beat {timeAgo(w.last_heartbeat)} ago
                        </div>
                      </div>
                    </div>
                    <button className="btn danger sm" onClick={() => kill(w)}>Kill worker</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>
    </>
  );
}
