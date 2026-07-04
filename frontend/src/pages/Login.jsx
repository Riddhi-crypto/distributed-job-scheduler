import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Banner, Spinner } from '../components/ui.jsx';

export default function Login() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('demo@aegis.dev');
  const [password, setPassword] = useState('password123');
  const [orgName, setOrgName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register({ email, password, orgName: orgName || undefined, displayName: displayName || undefined });
      nav('/', { replace: true });
    } catch (e2) {
      setErr(e2.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-bg auth-wrap">
      <div className="auth-card card card-pad">
        <div className="auth-brand">
          <span className="brand-badge">
            <svg><use href="#aegis-shield" /></svg>
          </span>
          <div style={{ textAlign: 'center' }}>
            <div className="auth-title">AEGIS</div>
            <div className="auth-sub">RESILIENCE CONTROL</div>
          </div>
        </div>

        <Banner kind="err">{err}</Banner>

        <form onSubmit={submit} className="spread">
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
          <label className="field">
            <span>Password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} required />
          </label>

          {mode === 'register' && (
            <>
              <label className="field">
                <span>Your name</span>
                <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="optional" />
              </label>
              <label className="field">
                <span>Organization name</span>
                <input className="input" value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="optional" />
              </label>
            </>
          )}

          <button className="btn primary block" disabled={busy} type="submit">
            {busy ? <Spinner /> : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="auth-toggle">
          {mode === 'login' ? "Don't have an account?" : 'Already have one?'}{' '}
          <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(null); }}>
            {mode === 'login' ? 'Create one' : 'Sign in'}
          </button>
        </div>

        {mode === 'login' && (
          <div className="demo-hint">
            Demo login — <code>demo@aegis.dev</code> · <code>password123</code>
          </div>
        )}
      </div>
    </div>
  );
}
