import { useEffect, useRef, useState, useCallback } from 'react';

/* ----------------------------------------------------------------- icons */
const P = (d, extra = {}) => (
  <path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...extra} />
);
export const Icon = {
  gauge: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M12 14a2 2 0 1 0 0-4')}{P('m14 12 4-3')}{P('M4.5 18a9 9 0 1 1 15 0')}</svg>,
  layers: (p) => <svg viewBox="0 0 24 24" {...p}>{P('m12 3 9 5-9 5-9-5 9-5Z')}{P('m3 13 9 5 9-5')}</svg>,
  queue: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M4 6h16M4 12h16M4 18h10')}</svg>,
  jobs: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M4 5h16v14H4zM8 3v4M16 3v4M8 12h8M8 16h5')}</svg>,
  workers: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M6 20v-1a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v1')}<circle cx="12" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.7" /></svg>,
  skull: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M12 3a7 7 0 0 0-4 12.7V19a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-3.3A7 7 0 0 0 12 3Z')}<circle cx="9.5" cy="11" r="1" fill="currentColor" stroke="none" /><circle cx="14.5" cy="11" r="1" fill="currentColor" stroke="none" /></svg>,
  chart: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6')}</svg>,
  bolt: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M13 3 4 14h7l-1 7 9-11h-7l1-7Z')}</svg>,
  activity: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M3 12h4l3 8 4-16 3 8h4')}</svg>,
  crown: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M4 8l3.5 3L12 5l4.5 6L20 8l-1.5 10h-13L4 8Z')}</svg>,
  spark: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18')}</svg>,
  back: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M15 6l-6 6 6 6')}</svg>,
  logout: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2M10 12h10m0 0-3-3m3 3-3 3')}</svg>,
  menu: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M4 7h16M4 12h16M4 17h16')}</svg>,
  plus: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M12 5v14M5 12h14')}</svg>,
  inbox: (p) => <svg viewBox="0 0 24 24" {...p}>{P('M4 13h4l2 3h4l2-3h4M4 13 6 5h12l2 8v6H4v-6Z')}</svg>,
};

/* -------------------------------------------------------------- formatters */
export function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
export function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
export const shortId = (id) => (id ? String(id).slice(0, 8) : '—');

/* --------------------------------------------------------------- usePoll */
// Runs an async fn immediately and then on an interval. Returns {data, error,
// loading, refresh}. Skips overlapping runs and stops when the tab is hidden.
export function usePoll(fn, intervalMs = 4000, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);
  const savedFn = useRef(fn);
  savedFn.current = fn;

  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const d = await savedFn.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      busy.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLoading(true);
    run();
    const id = setInterval(() => {
      if (!document.hidden) run();
    }, intervalMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refresh: run };
}

/* --------------------------------------------------------------- atoms */
export function Card({ title, icon: I, hint, children, bodyPad = true, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <div className="card-head">
          {I && <I className="card-icon" />}
          <h3>{title}</h3>
          {hint && <span className="hint">{hint}</span>}
        </div>
      )}
      <div className={bodyPad ? 'card-pad' : ''}>{children}</div>
    </section>
  );
}

export function StatCard({ label, value, unit, color = 'accent', live = false }) {
  return (
    <div className={`stat ${live ? 'pulse' : ''}`} style={{ '--c': `var(--${color})` }}>
      <span className={`stat-dot bg-${color}`} />
      <div className="stat-val tabular">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      <div className="stat-label">{label}</div>
      <div className="stat-bar" />
    </div>
  );
}

export function Badge({ status, children, className = '', dot = false }) {
  const cls = status ? `st-${status}` : '';
  return <span className={`badge ${cls} ${dot ? 'dot' : ''} ${className}`}>{children ?? status?.replace('_', ' ')}</span>;
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="loading" />;
}
export function LoadingFull() {
  return (
    <div className="loading-full">
      <Spinner />
    </div>
  );
}

export function EmptyState({ icon: I = Icon.inbox, title, children }) {
  return (
    <div className="empty">
      <I />
      <h4>{title}</h4>
      {children && <div>{children}</div>}
    </div>
  );
}

export function Banner({ kind = 'err', children }) {
  if (!children) return null;
  return <div className={`banner ${kind}`}>{children}</div>;
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      {label && <span>{label}</span>}
      {children}
      {hint && <span className="hint-text">{hint}</span>}
    </label>
  );
}

/* --------------------------------------------------------------- charts */
// Grouped bar chart: done (green) vs failed (amber) per time bucket. Hand-rolled
// SVG so the app carries no charting dependency.
export function ThroughputChart({ data, height = 200 }) {
  if (!data || data.length === 0) {
    return <EmptyState icon={Icon.chart} title="No throughput yet">Run some jobs to see the curve.</EmptyState>;
  }
  const W = Math.max(320, data.length * 26);
  const H = height;
  const pad = { l: 30, r: 10, t: 14, b: 22 };
  const max = Math.max(1, ...data.map((d) => Math.max(d.done || 0, d.failed || 0)));
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const bandW = iw / data.length;
  const barW = Math.min(9, bandW / 3);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const ticks = [0, Math.ceil(max / 2), max];

  return (
    <div>
      <div className="chart-legend">
        <span className="k" style={{ '--c': 'var(--done)' }}>done</span>
        <span className="k" style={{ '--c': 'var(--failed)' }}>failed</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMinYMid meet">
          {ticks.map((t, i) => (
            <g key={i}>
              <line className="grid-line" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
              <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="var(--faint)" fontFamily="var(--mono)">{t}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = pad.l + i * bandW + bandW / 2;
            return (
              <g key={i}>
                <rect x={cx - barW - 1} y={y(d.done || 0)} width={barW} height={pad.t + ih - y(d.done || 0)} rx="2" fill="var(--done)" opacity="0.9" />
                <rect x={cx + 1} y={y(d.failed || 0)} width={barW} height={pad.t + ih - y(d.failed || 0)} rx="2" fill="var(--failed)" opacity="0.9" />
                {i % Math.ceil(data.length / 8 || 1) === 0 && (
                  <text x={cx} y={H - 6} textAnchor="middle" fontSize="8.5" fill="var(--faint)" fontFamily="var(--mono)">{d.t}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// Single-series line/area sparkline for queue stats.
export function Sparkline({ points, color = 'running', height = 120, label = 'avg ms' }) {
  if (!points || points.length === 0) {
    return <EmptyState icon={Icon.activity} title="No samples yet" />;
  }
  const W = 560;
  const H = height;
  const pad = { l: 8, r: 8, t: 10, b: 10 };
  const max = Math.max(1, ...points);
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const step = points.length > 1 ? iw / (points.length - 1) : 0;
  const y = (v) => pad.t + ih - (v / max) * ih;
  const line = points.map((v, i) => `${pad.l + i * step},${y(v)}`).join(' ');
  const area = `${pad.l},${pad.t + ih} ${line} ${pad.l + (points.length - 1) * step},${pad.t + ih}`;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
      <polygon points={area} fill={`var(--${color})`} opacity="0.1" />
      <polyline points={line} fill="none" stroke={`var(--${color})`} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
