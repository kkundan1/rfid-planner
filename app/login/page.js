'use client';
import { useEffect, useState } from 'react';

const MARK = (
  <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="3" y="7" width="6" height="6" rx="1.2" fill="currentColor" />
    <path d="M12 6.5a5 5 0 0 1 0 7M14.6 4a8.6 8.6 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

export default function LoginPage() {
  const [setup, setSetup] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    fetch('/api/auth/setup').then((r) => r.json()).then((j) => setSetup(!!j.needsSetup)).catch(() => setSetup(false));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    const f = new FormData(e.currentTarget);
    const body = setup
      ? { name: f.get('name'), loginId: f.get('loginId'), password: f.get('password') }
      : { loginId: f.get('loginId'), password: f.get('password'), keep: f.get('keep') === 'on' };
    if (setup && f.get('password') !== f.get('password2')) return setErr('The two passwords don’t match.');
    setBusy(true);
    try {
      const r = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || 'Sign-in failed. Try again.'); setBusy(false); return; }
      location.href = '/';
    } catch {
      setErr('Can’t reach the server. Check your connection.');
      setBusy(false);
    }
  }

  if (setup === null) return <div className="login-wrap"><div className="loading">Loading…</div></div>;

  return (
    <div className="login-wrap">
      <div>
        <form className="gate-card" onSubmit={submit} noValidate>
          <div className="mark lg">{MARK}</div>
          <div>
            <div className="eyebrow">{setup ? 'First-time setup' : 'Sign in'}</div>
            <h1>RFID R&amp;D Planner</h1>
          </div>
          {setup && <p>Create the first admin account. You can add your team and their logins from Admin settings afterwards.</p>}
          <div className="gate-form">
            {setup && (
              <div className="fld"><label htmlFor="name">Your name</label><input type="text" id="name" name="name" autoComplete="name" required /></div>
            )}
            <div className="fld"><label htmlFor="loginId">Login ID</label><input type="text" id="loginId" name="loginId" autoComplete="username" autoCapitalize="none" spellCheck="false" maxLength={32} required autoFocus /></div>
            <div className="fld">
              <label htmlFor="password">Password</label>
              <div className="codebox">
                <input type={show ? 'text' : 'password'} id="password" name="password" autoComplete={setup ? 'new-password' : 'current-password'} maxLength={64} required />
                <button type="button" className="btn" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
              </div>
            </div>
            {setup ? (
              <div className="fld"><label htmlFor="password2">Repeat password</label><input type={show ? 'text' : 'password'} id="password2" name="password2" autoComplete="new-password" maxLength={64} required /></div>
            ) : (
              <label className="chk"><input type="checkbox" name="keep" /> Keep me signed in on this device for 7 days</label>
            )}
            {err && <div className="err" role="alert">{err}</div>}
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Please wait…' : setup ? 'Create admin account' : 'Sign in'}</button>
            {!setup && <p className="hint">Forgot your password? Ask an admin to set a new one.</p>}
          </div>
        </form>
        <div className="login-foot">RFID R&amp;D Planner</div>
      </div>
    </div>
  );
}
