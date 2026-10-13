import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, Box, Button, Card, CardContent, CircularProgress, CssBaseline, Stack, TextField, Typography } from '@mui/material';
import { createTheme, ThemeProvider } from '@mui/material/styles';

const theme = createTheme({ palette: { mode: 'dark', primary: { main: '#7dd3a7' } } });
const api = {
  request: async (path, options) => {
    const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
    const body = await response.text();
    const data = body ? JSON.parse(body) : null;
    if (!response.ok) throw new Error(data?.message ?? `HTTP ${response.status}`);
    return data;
  },
  accounts: () => api.request('/auth/codex/accounts'),
  status: () => api.request('/auth/codex/status'),
  authorize: () => api.request('/auth/codex/authorize'),
  start: (email, password) => api.request('/auth/codex/accounts', { method: 'POST', body: JSON.stringify({ email, password }) }),
};

function App() {
  const [accounts, setAccounts] = useState([]);
  const [status, setStatus] = useState({ logs: [] });
  const [form, setForm] = useState({ email: '', password: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const refresh = async () => {
      try { setAccounts(await api.accounts()); setStatus(await api.status()); } catch (error) { setMessage(error.message); }
    };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const start = async (event) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try { await api.start(form.email, form.password); setMessage('Codex flow started.'); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };

  return <ThemeProvider theme={theme}><CssBaseline /><Box sx={{ maxWidth: 900, mx: 'auto', p: { xs: 3, md: 6 } }}><Typography variant="h3" gutterBottom>Codex Slayer</Typography><Typography color="text.secondary" gutterBottom>Codex OAuth and account flow</Typography><Stack spacing={3} mt={4}><Card><CardContent><Typography variant="h6" gutterBottom>Start account flow</Typography><Box component="form" onSubmit={start} sx={{ display: 'grid', gap: 2, maxWidth: 520 }}><TextField required label="Email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /><TextField required label="Password" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /><Button type="submit" variant="contained" disabled={busy}>{busy ? <CircularProgress size={22} /> : 'Start Codex'}</Button></Box></CardContent></Card><Button variant="outlined" onClick={async () => { const result = await api.authorize(); window.open(result.authorizationUrl, '_blank', 'noopener'); }}>Authorization link</Button>{message && <Alert severity="info">{message}</Alert>}<Card><CardContent><Typography variant="h6">Status</Typography><Typography>{status.state ?? 'idle'}{status.email ? ` — ${status.email}` : ''}</Typography>{status.logs?.map((log) => <Typography key={`${log.at}-${log.message}`} variant="body2" color="text.secondary">{log.message}</Typography>)}</CardContent></Card><Card><CardContent><Typography variant="h6">Accounts</Typography>{accounts.length ? accounts.map((account) => <Typography key={account.connectionId}>{account.email}</Typography>) : <Typography color="text.secondary">No Codex accounts.</Typography>}</CardContent></Card></Stack></Box></ThemeProvider>;
}

createRoot(document.getElementById('root')).render(<App />);
