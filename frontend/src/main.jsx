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
  save: (credentials) =>
    api.request('/auth/codex/accounts', {
      method: 'POST',
      body: JSON.stringify(credentials),
    }),
  batch: () =>
    api.request('/auth/codex/batch', {
      method: 'POST',
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
  const [saving, setSaving] = useState(false);
  const [startingBatch, setStartingBatch] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [refreshError, setRefreshError] = useState('');

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
          setRefreshError('');
        }
      } catch {
        if (mounted)
          setRefreshError(
            'Cannot refresh account status. Check API connection.',
          );
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    setError('');
    const credentials = form;
    try {
      await api.save(credentials);
      setForm({ email: credentials.email, password: '', totpSecret: '' });
      setMessage('Account saved. Add another account or start the batch.');
      const nextAccounts = await api.accounts();
      setAccounts(nextAccounts);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  const startBatch = async () => {
    setStartingBatch(true);
    setMessage('');
    setError('');
    try {
      await api.batch();
      setMessage('Batch started. Watch the progress panel.');
    } catch (batchError) {
      setError(batchError.message);
    } finally {
      setStartingBatch(false);
    }
  };

  const remove = async (connectionId) => {
    setDeleting(true);
    setError('');
    try {
      await api.delete(connectionId);
      setAccounts((current) =>
        current.filter((account) => account.connectionId !== connectionId),
      );
      setDeleteCandidate('');
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setDeleting(false);
    }
  };

  const batch = status.batch;
  const locked =
    saving || startingBatch || status.active || Boolean(batch?.active);
  const state = status.state ?? (batch?.active ? 'batch' : 'idle');

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
          <p className="subtitle">Save accounts, then run one sequential batch.</p>
        </div>
      </header>

      <div className="content-grid">
        <section className="panel login-panel" aria-labelledby="login-heading">
          <div className="panel-heading">
            <span className="pixel-badge" aria-hidden="true">
              01
            </span>
            <div>
              <p className="eyebrow">SAVE ACCOUNT</p>
              <h2 id="login-heading">Account credentials</h2>
            </div>
          </div>
          <form onSubmit={save}>
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
              Base32 secret. Saved encrypted; used only during batch sign-in.
            </p>
            <button className="primary-button" type="submit" disabled={locked}>
              {saving ? 'SAVING…' : 'SAVE ACCOUNT'}
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
          {refreshError && (
            <p className="notice failure" role="alert">
              {refreshError}
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
          {batch && (
            <>
              {batch.currentEmail && (
                <p className="state-email">Current: {batch.currentEmail}</p>
              )}
              <p className="quiet">
                Run {batch.runId} · {batch.state} · started{' '}
                {new Date(batch.startedAt).toLocaleString()}
                {batch.completedAt && ` · completed ${new Date(batch.completedAt).toLocaleString()}`}
              </p>
              <dl className="batch-counts" aria-label="Batch progress">
                <div><dt>PROCESSED</dt><dd>{batch.completed}</dd></div>
                <div><dt>SELECTED</dt><dd>{batch.total}</dd></div>
                <div><dt>SUCCESS</dt><dd>{batch.authenticated}</dd></div>
                <div><dt>SKIPPED</dt><dd>{batch.skipped}</dd></div>
                <div><dt>UNKNOWN</dt><dd>{batch.indeterminate}</dd></div>
                <div><dt>FAILED</dt><dd>{batch.failed}</dd></div>
              </dl>
              {!batch.active && batch.accounts.length > 0 && (
                <ul className="batch-report">
                  {batch.accounts.map((account) => (
                    <li key={`${account.email}-${account.outcome}`}>
                      <span>{account.email}</span>
                      <strong>{account.outcome}</strong>
                      {account.reason && <small>{account.reason}</small>}
                      <small>Completed {new Date(account.completedAt).toLocaleString()}</small>
                    </li>
                  ))}
                </ul>
              )}
            </>
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
        <button
          className="primary-button batch-button"
          type="button"
          disabled={locked || accounts.length === 0}
          onClick={startBatch}
        >
          {startingBatch || batch?.active ? 'BATCH RUNNING…' : 'START BATCH'}
        </button>
        {accounts.length ? (
          <ul className="account-list">
            {accounts.map((account) => (
              <li key={account.connectionId}>
                <span className="account-email">
                  {account.email} <small>({account.status})</small>
                </span>
                {deleteCandidate === account.connectionId ? (
                  <div
                    className="delete-confirm"
                    role="group"
                    aria-label={`Confirm deletion of ${account.email}`}
                  >
                    <span>Delete encrypted credentials permanently?</span>
                    <button
                      className="delete-button"
                      type="button"
                      disabled={deleting}
                      onClick={() => remove(account.connectionId)}
                    >
                      {deleting ? 'DELETING…' : 'CONFIRM DELETE'}
                    </button>
                    <button
                      className="cancel-button"
                      type="button"
                      disabled={deleting}
                      onClick={() => setDeleteCandidate('')}
                    >
                      CANCEL
                    </button>
                  </div>
                ) : (
                  <button
                    className="delete-button"
                    type="button"
                    onClick={() => setDeleteCandidate(account.connectionId)}
                    aria-label={`Delete ${account.email}`}
                  >
                    DELETE
                  </button>
                )}
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
