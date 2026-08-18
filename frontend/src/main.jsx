import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  AppBar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  CssBaseline,
  Divider,
  Drawer,
  FormControl,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material';
import { createTheme, ThemeProvider } from '@mui/material/styles';
const sections = ['Overview', 'Gmail', 'Codex Account', 'SMSPool'];
const drawerWidth = 240;
const theme = createTheme({ palette: { mode: 'dark', primary: { main: '#7dd3a7' }, background: { default: '#101417', paper: '#171d21' } }, shape: { borderRadius: 10 } });
const api = {
  async request(path, options = {}) {
    const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }, ...options });
    const text = await response.text();
    let payload = text;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(typeof payload === 'string' ? payload : payload?.message ?? payload?.error?.message ?? `HTTP ${response.status}`);
    return payload;
  },
  health: () => api.request('/'),
  gmailConnections: () => api.request('/auth/google/gmail/connections'),
  gmailAuthorize: () => { window.location.href = '/auth/google/gmail/authorize'; },
  codexAccounts: () => api.request('/auth/codex/accounts'),
  codexStatus: () => api.request('/auth/codex/status'),
  codexAuthorize: () => api.request('/auth/codex/authorize'),
  startCodex: (email, password) => api.request('/auth/codex/accounts', { method: 'POST', body: JSON.stringify({ email, password }) }),
  balance: () => api.request('/smspool/balance'),
  orders: () => api.request('/smspool/orders'),
  buyPhone: () => api.request('/smspool/phone-number', { method: 'POST' }),
  smsCode: (orderId) => api.request(`/smspool/code/${encodeURIComponent(orderId)}`),
  refund: (orderId, expiresAt) => api.request('/smspool/refund', { method: 'POST', body: JSON.stringify({ orderId, expiresAt }) }),
};

function usePolling(loader, interval = 2000) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try { const data = await loader(); if (active) setState({ data, loading: false, error: '' }); }
      catch (error) { if (active) setState((current) => ({ ...current, loading: false, error: error.message })); }
    };
    refresh();
    const timer = window.setInterval(refresh, interval);
    return () => { active = false; window.clearInterval(timer); };
  }, [loader, interval]);
  return state;
}

function SectionTitle({ eyebrow, title, action }) { return <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} flexWrap="wrap" gap={2} mb={3}><Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="overline" color="primary">{eyebrow}</Typography><Typography variant="h4" sx={{ overflowWrap: 'anywhere' }}>{title}</Typography></Box><Box sx={{ flexShrink: 0 }}>{action}</Box></Stack>; }
function Empty({ children }) { return <Paper variant="outlined" sx={{ p: 3, color: 'text.secondary' }}>{children}</Paper>; }
function ErrorText({ message }) { return message ? <Alert severity="error" sx={{ mb: 2 }}>{message}</Alert> : null; }
function Loading() { return <Box sx={{ display: 'grid', placeItems: 'center', p: 4 }}><CircularProgress size={24} /></Box>; }

function GmailPage() {
  const connections = usePolling(api.gmailConnections, 3000);
  return <><SectionTitle eyebrow="Google OAuth" title="Gmail connections" action={<Button variant="contained" onClick={api.gmailAuthorize}>Connect Gmail</Button>} /><ErrorText message={connections.error} />{connections.loading && !connections.data ? <Loading /> : connections.data?.length ? <Stack spacing={2}>{connections.data.map((connection) => <Card key={connection.connectionId}><CardContent><Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2}><Box><Typography variant="h6">{connection.emailAddress ?? 'Unknown email'}</Typography><Typography variant="body2" color="text.secondary">Connection: {connection.connectionId}</Typography></Box><Chip color="success" label="Connected" /></Stack><Typography variant="body2" color="text.secondary" mt={2}>Scope: {connection.scope ?? '—'} · Expires: {connection.expiresAt ? new Date(connection.expiresAt).toLocaleString() : 'Unknown'}</Typography></CardContent></Card>)}</Stack> : <Empty>No Gmail credential found. Connect a Google account to begin.</Empty>}</>;
}

function CodexPage() {
  const accounts = usePolling(api.codexAccounts, 3000);
  const status = usePolling(api.codexStatus, 1000);
  const [form, setForm] = useState({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const start = async (event) => { event.preventDefault(); setBusy(true); setMessage(''); try { await api.startCodex(form.email, form.password); setMessage('Flow started. Live status is updating below.'); } catch (error) { setMessage(error.message); } finally { setBusy(false); } };
  return <><SectionTitle eyebrow="Account automation" title="Codex accounts" action={<Button variant="outlined" onClick={async () => { const result = await api.codexAuthorize(); window.open(result.authorizationUrl, '_blank', 'noopener'); }}>Authorization link</Button>} /><Stack spacing={2}><Card><CardContent><Typography variant="h6" mb={2}>Start account flow</Typography><Box component="form" onSubmit={start} sx={{ display: 'grid', gap: 2, maxWidth: 520 }}><TextField required label="Email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /><TextField required label="Password" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /><Button type="submit" variant="contained" disabled={busy}>{busy ? 'Starting…' : 'Start flow'}</Button></Box>{message && <Alert severity={message.includes('started') ? 'success' : 'error'} sx={{ mt: 2 }}>{message}</Alert>}</CardContent></Card><Card><CardContent><Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}><Typography variant="h6">Live flow status</Typography><Chip color={status.data?.active ? 'warning' : 'default'} label={status.data?.active ? 'Running' : 'Idle'} /></Stack><Typography variant="body2" color="text.secondary" mb={2}>{status.data?.step ?? 'Waiting for a flow'}</Typography><Paper variant="outlined" sx={{ maxHeight: 300, overflow: 'auto', p: 2, bgcolor: '#0d1113' }}><Stack spacing={1}>{status.data?.logs?.length ? status.data.logs.map((log, index) => <Typography key={`${log.at}-${index}`} variant="body2" sx={{ fontFamily: 'monospace' }}><Box component="span" color="text.secondary">{new Date(log.at).toLocaleTimeString()} </Box>{log.message}</Typography>) : <Typography color="text.secondary">No live logs yet.</Typography>}</Stack></Paper></CardContent></Card><Card><CardContent><Typography variant="h6" mb={2}>Created accounts</Typography><ErrorText message={accounts.error} />{accounts.loading && !accounts.data ? <Loading /> : accounts.data?.length ? <List disablePadding>{accounts.data.map((account, index) => <React.Fragment key={`${account.email}-${index}`}><ListItemButton><ListItemText primary={account.email} secondary={account.connectionId ? `Connection: ${account.connectionId}` : 'Saved account'} /><Chip size="small" color="success" label="Created" /></ListItemButton>{index < accounts.data.length - 1 && <Divider />}</React.Fragment>)}</List> : <Empty>No Codex accounts created yet.</Empty>}</CardContent></Card></Stack></>;
}

function SmsPoolPage() {
  const orders = usePolling(api.orders, 1500);
  const balance = usePolling(api.balance, 3000);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const buy = async () => { setBusy(true); try { const order = await api.buyPhone(); setSelected(order.orderId); } catch (error) { window.alert(error.message); } finally { setBusy(false); } };
  const updateCode = async () => { if (!selected) return; setBusy(true); try { await api.smsCode(selected); } catch (error) { window.alert(error.message); } finally { setBusy(false); } };
  const refund = async () => { const order = orders.data?.find((item) => item.orderId === selected); if (!order) return; setBusy(true); try { await api.refund(order.orderId, order.expiresAt); } catch (error) { window.alert(error.message); } finally { setBusy(false); } };
  return <><SectionTitle eyebrow="Phone verification" title="SMSPool orders" action={<Button variant="contained" onClick={buy} disabled={busy}>{busy ? 'Working…' : 'Buy phone number'}</Button>} /><Stack spacing={2}><Card><CardContent><Typography color="text.secondary">Balance</Typography><Typography variant="h3">{balance.data?.balance ?? '—'} <Typography component="span" variant="h6">{balance.data?.currency ?? ''}</Typography></Typography><ErrorText message={balance.error} /></CardContent></Card><Card><CardContent><Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2} mb={2}><Typography variant="h6">Purchased numbers</Typography><Stack direction="row" spacing={1}><FormControl size="small" sx={{ minWidth: 220 }}><Select value={selected} displayEmpty onChange={(event) => setSelected(event.target.value)}><MenuItem value="">Select order</MenuItem>{(orders.data ?? []).map((order) => <MenuItem key={order.orderId} value={order.orderId}>{order.phoneNumber} · {order.orderId}</MenuItem>)}</Select></FormControl><Button variant="outlined" onClick={updateCode} disabled={!selected || busy}>Refresh code</Button><Button color="error" variant="outlined" onClick={refund} disabled={!selected || busy}>Refund</Button></Stack></Stack><ErrorText message={orders.error} />{orders.loading && !orders.data ? <Loading /> : orders.data?.length ? <List disablePadding>{orders.data.map((order, index) => <React.Fragment key={order.orderId}><ListItemButton selected={selected === order.orderId} onClick={() => setSelected(order.orderId)}><ListItemText primary={`${order.phoneNumber} · ${order.orderId}`} secondary={`Status: ${order.status ?? 'unknown'} · Expires: ${order.expiresAt ? new Date(order.expiresAt * 1000).toLocaleString() : 'unknown'}${order.code ? ` · Code: ${order.code}` : ''}`} /><Chip size="small" color={order.received ? 'success' : 'default'} label={order.received ? 'Code received' : 'Waiting'} /></ListItemButton>{index < orders.data.length - 1 && <Divider />}</React.Fragment>)}</List> : <Empty>No purchased numbers in the current process.</Empty>}</CardContent></Card></Stack></>;
}

function Overview({ onNavigate }) {
  const health = usePolling(api.health, 5000);
  const gmail = usePolling(api.gmailConnections, 5000);
  const orders = usePolling(api.orders, 3000);
  return <><Box sx={{ p: { xs: 3, md: 6 }, mb: 3, border: 1, borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}><Typography variant="overline" color="primary">Operations dashboard</Typography><Typography variant="h3" sx={{ maxWidth: 720, mb: 2 }}>One console for Gmail, Codex, and phone verification.</Typography><Typography color="text.secondary" sx={{ mb: 3 }}>Live lists. Explicit flows. Polling status.</Typography><Stack direction="row" spacing={1} flexWrap="wrap"><Button variant="contained" onClick={() => onNavigate('Gmail')}>Connect Gmail</Button><Button variant="outlined" onClick={() => onNavigate('SMSPool')}>View SMSPool</Button></Stack></Box><Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 2 }}><Card><CardContent><Typography color="text.secondary">API</Typography><Typography variant="h4">{health.error ? 'Offline' : health.data ? 'Online' : '…'}</Typography></CardContent></Card><Card><CardContent><Typography color="text.secondary">Gmail connections</Typography><Typography variant="h4">{gmail.data?.length ?? '…'}</Typography></CardContent></Card><Card><CardContent><Typography color="text.secondary">SMSPool orders</Typography><Typography variant="h4">{orders.data?.length ?? '…'}</Typography></CardContent></Card></Box></>;
}

function App() {
  const [section, setSection] = useState('Overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const content = useMemo(() => ({ Overview: <Overview onNavigate={setSection} />, Gmail: <GmailPage />, 'Codex Account': <CodexPage />, SMSPool: <SmsPoolPage /> }[section]), [section]);
  const drawer = <Box sx={{ width: drawerWidth, p: 2 }}><Typography variant="h6" sx={{ p: 2, mb: 2 }}>Codex Slayer</Typography><List>{sections.map((item) => <ListItemButton key={item} selected={section === item} onClick={() => { setSection(item); setMobileOpen(false); }}><ListItemText primary={item} /></ListItemButton>)}</List></Box>;
  return <ThemeProvider theme={theme}><CssBaseline /><Box sx={{ display: 'flex', minHeight: '100vh' }}><AppBar position="fixed" sx={{ display: { sm: 'none' } }}><Toolbar><Button color="inherit" onClick={() => setMobileOpen(true)}>Menu</Button><Typography>Codex Slayer</Typography></Toolbar></AppBar><Box component="nav"><Drawer variant="temporary" open={mobileOpen} onClose={() => setMobileOpen(false)} ModalProps={{ keepMounted: true }}>{drawer}</Drawer><Drawer variant="permanent" sx={{ display: { xs: 'none', sm: 'block' }, '& .MuiDrawer-paper': { width: drawerWidth, boxSizing: 'border-box' } }}>{drawer}</Drawer></Box><Box component="main" sx={{ flexGrow: 1, ml: { sm: `${drawerWidth}px` }, p: { xs: 3, md: 6 }, pt: { xs: 10, sm: 6 }, maxWidth: 1320, mx: 'auto', width: '100%' }}><Typography variant="overline" color="primary">Internal console</Typography><Typography variant="h2" sx={{ mb: 4 }}>{section}</Typography>{content}</Box></Box></ThemeProvider>;
}

createRoot(document.getElementById('root')).render(<App />);
