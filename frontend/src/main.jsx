import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './main.css';

const api = {
  request: async (path, options = {}) => {
    const response = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok)
      throw new Error(data?.message ?? `HTTP ${response.status}`);
    return data;
  },
  accounts: () => api.request('/auth/codex/accounts'),
  status: () => api.request('/auth/codex/status'),
  start: (credentials) =>
    api.request('/auth/codex/accounts', {
      method: 'POST',
      body: JSON.stringify(credentials),
    }),
  delete: (connectionId) =>
    api.request(`/auth/codex/accounts/${encodeURIComponent(connectionId)}`, {
      method: 'DELETE',
    }),
};

function App() {
  const [accounts, setAccounts] = useState([]);
  const [status, setStatus] = useState({ active: false, logs: [] });
  const [form, setForm] = useState({ email: '', password: '', totpSecret: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const [nextAccounts, nextStatus] = await Promise.all([
          api.accounts(),
          api.status(),
        ]);
        if (mounted) {
          setAccounts(nextAccounts);
          setStatus(nextStatus);
        }
      } catch (refreshError) {
        if (mounted) setError(refreshError.message);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  const start = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    setError('');
    const credentials = form;
    setForm({ email: credentials.email, password: '', totpSecret: '' });
    try {
      await api.start(credentials);
      setMessage('Login started. Watch the status panel.');
    } catch (startError) {
      setError(startError.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (connectionId) => {
    setError('');
    try {
      await api.delete(connectionId);
      setAccounts((current) =>
        current.filter((account) => account.connectionId !== connectionId),
      );
    } catch (deleteError) {
      setError(deleteError.message);
    }
  };

  const locked = busy || status.active;
  const state = status.state ?? 'idle';

  return (
    <main className="page-shell">
      <header className="masthead">
        <div className="nyan-mark" aria-hidden="true">
          <span className="rainbow-tail" />
          <span className="pixel-cat">=^..^=</span>
        </div>
        <div>
          <p className="eyebrow">CODEX AUTH TERMINAL // 8-BIT MODE</p>
          <h1>Codex Login</h1>
          <p className="subtitle">One account. One secure sign-in flow.</p>
        </div>
      </header>

      <div className="content-grid">
        <section className="panel login-panel" aria-labelledby="login-heading">
          <div className="panel-heading">
            <span className="pixel-badge" aria-hidden="true">
              01
            </span>
            <div>
              <p className="eyebrow">AUTHENTICATE</p>
              <h2 id="login-heading">Account credentials</h2>
            </div>
          </div>
          <form onSubmit={start}>
            <label htmlFor="email">Email address</label>
            <input
              autoComplete="username"
              id="email"
              name="email"
              type="email"
              required
              value={form.email}
              onChange={(event) =>
                setForm({ ...form, email: event.target.value })
              }
            />
            <label htmlFor="password">Password</label>
            <input
              autoComplete="current-password"
              id="password"
              name="password"
              type="password"
              required
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value })
              }
            />
            <label htmlFor="totp-secret">Authenticator secret</label>
            <input
              autoComplete="off"
              id="totp-secret"
              name="totpSecret"
              type="password"
              inputMode="text"
              required
              value={form.totpSecret}
              onChange={(event) =>
                setForm({ ...form, totpSecret: event.target.value })
              }
            />
            <p className="field-hint">
              Base32 secret. The six-digit code is generated only during
              sign-in.
            </p>
            <button className="primary-button" type="submit" disabled={locked}>
              {locked ? 'LOGIN RUNNING…' : 'START CODEX LOGIN'}
            </button>
          </form>
          {message && (
            <p className="notice success" role="status">
              {message}
            </p>
          )}
          {error && (
            <p className="notice failure" role="alert">
              {error}
            </p>
          )}
        </section>

        <section
          className="panel status-panel"
          aria-labelledby="status-heading"
          aria-live="polite"
        >
          <div className="panel-heading">
            <span
              className={`status-lamp ${status.active ? 'active' : ''}`}
              aria-hidden="true"
            />
            <div>
              <p className="eyebrow">LIVE PROCESS</p>
              <h2 id="status-heading">Login status</h2>
            </div>
          </div>
          <p className="state-name">{state.replaceAll('_', ' ')}</p>
          {status.email && <p className="state-email">{status.email}</p>}
          {status.step && (
            <p className="state-step">
              STEP // {status.step.replaceAll('_', ' ')}
            </p>
          )}
          {status.logs?.length > 0 ? (
            <ol className="log-list">
              {status.logs.map((log) => (
                <li key={`${log.at}-${log.message}`}>{log.message}</li>
              ))}
            </ol>
          ) : (
            <p className="quiet">Ready when you are.</p>
          )}
          <div className="pixel-rainbow" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </section>
      </div>

      <section
        className="panel accounts-panel"
        aria-labelledby="accounts-heading"
      >
        <div className="panel-heading">
          <span className="pixel-badge" aria-hidden="true">
            02
          </span>
          <div>
            <p className="eyebrow">LOCAL VAULT</p>
            <h2 id="accounts-heading">
              Saved accounts <span className="count">{accounts.length}</span>
            </h2>
          </div>
        </div>
        {accounts.length ? (
          <ul className="account-list">
            {accounts.map((account) => (
              <li key={account.connectionId}>
                <span className="account-email">{account.email}</span>
                <button
                  className="delete-button"
                  type="button"
                  onClick={() => remove(account.connectionId)}
                  aria-label={`Delete ${account.email}`}
                >
                  DELETE
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet">No saved accounts yet.</p>
        )}
      </section>

      <footer>
        PIXEL LOGIN SYSTEM <span aria-hidden="true">//</span> SECRETS STAY IN
        THE VAULT
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
