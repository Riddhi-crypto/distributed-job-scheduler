import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Icon, usePoll } from './ui.jsx';
import { api } from '../api.js';

// Route → (eyebrow, title) so the topbar always names the current view.
const TITLES = {
  '/': ['Live', 'Mission Control'],
  '/metrics': ['Analytics', 'Throughput & Metrics'],
  '/workers': ['Fleet', 'Worker Fleet'],
  '/queues': ['Scheduling', 'Queues'],
  '/jobs': ['Scheduling', 'Job Explorer'],
  '/dead-letters': ['Reliability', 'Dead Letter Queue'],
  '/projects': ['Workspace', 'Projects'],
  '/chaos': ['Resilience', 'Chaos Lab'],
};

const NAV = [
  ['Monitor', [
    ['/', 'Overview', Icon.gauge],
    ['/metrics', 'Metrics', Icon.chart],
    ['/workers', 'Workers', Icon.workers],
  ]],
  ['Scheduling', [
    ['/queues', 'Queues', Icon.queue],
    ['/jobs', 'Jobs', Icon.jobs],
    ['/dead-letters', 'Dead Letters', Icon.skull],
  ]],
  ['Configure', [
    ['/projects', 'Projects', Icon.layers],
  ]],
  ['Operate', [
    ['/chaos', 'Chaos Lab', Icon.bolt],
  ]],
];

function titleFor(pathname) {
  if (TITLES[pathname]) return TITLES[pathname];
  if (pathname.startsWith('/queues/')) return ['Scheduling', 'Queue Detail'];
  if (pathname.startsWith('/jobs/')) return ['Scheduling', 'Job Detail'];
  return ['AEGIS', 'Control Plane'];
}

function Shield() {
  return (
    <span className="brand-badge">
      <svg><use href="#aegis-shield" /></svg>
    </span>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const [eyebrow, title] = titleFor(loc.pathname);

  // A single lightweight poll drives the live pill + rail footer counters.
  const { data: ov } = usePoll(() => api.get('/metrics/overview'), 5000);
  const { data: disp } = usePoll(() => api.get('/metrics/dispatcher'), 5000);
  const alive = ov?.workers_alive ?? 0;
  const isLive = alive > 0;

  return (
    <div className="app-bg">
      <div className="shell">
        {open && <div className="rail-scrim" onClick={() => setOpen(false)} />}
        <aside className={`rail ${open ? 'open' : ''}`}>
          <div className="brand">
            <Shield />
            <div>
              <div className="brand-name">AEGIS</div>
              <div className="brand-sub">RESILIENCE CONTROL</div>
            </div>
          </div>

          <nav className="nav">
            {NAV.map(([group, links]) => (
              <div key={group}>
                <div className="nav-group-label">{group}</div>
                {links.map(([to, label, I]) => (
                  <NavLink key={to} to={to} end={to === '/'} className="nav-link" onClick={() => setOpen(false)}>
                    <I className="nav-ico" />
                    {label}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="rail-foot">
            <div className="rail-stat">
              <Icon.workers className="nav-ico" style={{ color: isLive ? 'var(--done)' : 'var(--failed)' }} />
              Workers <b>{alive}</b> / {ov?.workers_total ?? 0} live
            </div>
            <div className="rail-stat">
              <Icon.crown className="nav-ico" style={{ color: disp?.holder ? 'var(--done)' : 'var(--faint)' }} />
              Dispatcher <b>{disp?.holder ? 'leader up' : '—'}</b>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button className="menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation">
              <Icon.menu style={{ width: 18, height: 18 }} />
            </button>
            <div className="topbar-titles">
              <div className="eyebrow">{eyebrow}</div>
              <h1 className="page-title">{title}</h1>
            </div>
            <div className="topbar-right">
              <span className="live-pill">
                <span className={`live-dot ${isLive ? '' : 'stale'}`} />
                {isLive ? 'live' : 'idle'}
              </span>
              <select className="org-select" value={user?.org_id || ''} readOnly onChange={() => {}} aria-label="Organization">
                <option value={user?.org_id || ''}>{user?.org_name || 'Organization'}</option>
              </select>
              <button className="btn sm ghost" onClick={logout} title="Sign out">
                <Icon.logout style={{ width: 15, height: 15 }} />
                Sign out
              </button>
            </div>
          </header>

          <main className="content">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
