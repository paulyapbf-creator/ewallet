const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { getGateway } = require('./index');
const { generateSignature } = require('./lib/signature');
const settings = require('./lib/settings');
const usersLib = require('./lib/users');

const db = require('./lib/db');
const { mytNow } = db;
const schema = require('./lib/schema');

function getTxDate() {
  const now = new Date(Date.now() + 8 * 3600000);
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(now.getUTCFullYear()).slice(-2);
  return dd + mm + yy;
}

const PORT = process.env.PORT || 4568;
const RAILWAY_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
const BASE_URL = RAILWAY_DOMAIN ? `https://${RAILWAY_DOMAIN}` : `http://localhost:${PORT}`;

const app = express();
app.use(express.json());

const server = http.createServer(app);

// --- WebSocket ---
const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

function broadcastToPos(data) {
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ================================================================
// Auth: token store + middleware
// ================================================================
const sessions = new Map(); // token -> { username, role, expires }

function createSession(username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, role, expires: Date.now() + 24 * 60 * 60 * 1000 });
  return token;
}

async function requireAuth(req, res, next) {
  // Legacy PIN header (backward compat)
  const pin = req.headers['x-admin-pin'];
  if (pin) {
    const s = await settings.load();
    if (!s.adminPin || pin === s.adminPin) { req.userRole = 'admin'; req.username = 'admin'; return next(); }
  }
  // Bearer token
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && sessions.has(token)) {
    const sess = sessions.get(token);
    if (sess.expires > Date.now()) { req.userRole = sess.role; req.username = sess.username; return next(); }
    sessions.delete(token);
  }
  res.status(401).json({ error: 'Unauthorized' });
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// Alias for backward compat with existing route code
const requirePin = requireAdmin;

// ================================================================
// Auth endpoints
// ================================================================
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = await usersLib.authenticate(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const token = createSession(user.username, user.role);
  console.log(`[AUTH] Login: ${user.username} (${user.role})`);
  res.json({ ok: true, token, role: user.role, username: user.username });
});

// ================================================================
// User management (admin only)
// ================================================================
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  res.json({ users: await usersLib.getAll() });
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!['admin', 'cashier'].includes(role)) return res.status(400).json({ error: 'Role must be admin or cashier' });
  await usersLib.upsert(username, password, role);
  console.log(`[USERS] Upsert: ${username} (${role}) by ${req.username}`);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:username', requireAdmin, async (req, res) => {
  const ok = await usersLib.remove(req.params.username);
  if (!ok) return res.status(400).json({ error: 'Cannot delete the last admin account' });
  console.log(`[USERS] Deleted: ${req.params.username} by ${req.username}`);
  res.json({ ok: true });
});

// ================================================================
// Admin Settings API
// ================================================================
app.get('/api/admin/settings', requirePin, async (req, res) => {
  const s = await settings.load();
  res.json(s);
});

app.put('/api/admin/settings', requirePin, async (req, res) => {
  const saved = await settings.save(req.body);
  console.log('[ADMIN] Settings updated');
  res.json(saved);
});

// --- Profiles API ---
app.get('/api/admin/profiles', requireAuth, async (req, res) => {
  res.json({ profiles: await settings.listProfiles() });
});

app.get('/api/admin/profiles/all', requireAuth, async (req, res) => {
  res.json({ profiles: await settings.loadProfiles() });
});

// Export all profiles as downloadable JSON — MUST be before /:name route
app.get('/api/admin/profiles/export', requirePin, async (req, res) => {
  const profiles = await settings.loadProfiles();
  const json = JSON.stringify(profiles, null, 2);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="profiles-backup.json"');
  res.send(json);
});

// Import profiles from JSON — MUST be before /:name route
app.post('/api/admin/profiles/import', requirePin, async (req, res) => {
  try {
    const incoming = req.body;
    if (typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'Expected a JSON object of profiles' });
    }
    const replace = req.query.replace === '1';
    const existing = replace ? {} : await settings.loadProfiles();
    const merged = { ...existing, ...incoming };
    for (const [name, data] of Object.entries(incoming)) {
      await settings.saveProfile(name, data);
    }
    console.log(`[ADMIN] Profiles imported: ${Object.keys(incoming).join(', ')} (replace=${replace})`);
    res.json({ success: true, count: Object.keys(merged).length, profiles: await settings.listProfiles() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/profiles/:name', requirePin, async (req, res) => {
  // Only save fields for the profile's own gateway — never store other gateways' credentials in a profile
  const gw = req.body.activeGateway || 'duitnow';
  const otherPrefixes = ['duitnow', 'ampersandpay', 'ecpi'].filter(p => p !== gw);
  const safeBody = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => !otherPrefixes.some(p => k.startsWith(p)))
  );
  await settings.saveProfile(req.params.name, safeBody);
  console.log('[ADMIN] Profile saved: ' + req.params.name + ' (gateway=' + gw + ') | apiUrl=' + safeBody.ampersandpayApiUrl);
  res.json({ success: true, profiles: await settings.listProfiles() });
});

app.get('/api/admin/profiles/:name/load', requireAuth, async (req, res) => {
  const profile = await settings.loadProfile(req.params.name);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  // Only apply fields for the profile's own gateway + general fields.
  // Prevents activating an AmpersandPay profile from wiping DuitNow credentials.
  const gw = profile.activeGateway || 'duitnow';
  const otherPrefixes = ['duitnow', 'ampersandpay', 'ecpi'].filter(p => p !== gw);
  const safeProfile = Object.fromEntries(
    Object.entries(profile).filter(([k]) => !otherPrefixes.some(p => k.startsWith(p)))
  );
  const saved = await settings.save({ ...safeProfile, activeProfile: req.params.name });
  console.log('[ADMIN] Profile loaded: ' + req.params.name + ' (gateway=' + gw + ')');
  res.json(saved);
});

app.delete('/api/admin/profiles/:name', requirePin, async (req, res) => {
  await settings.deleteProfile(req.params.name);
  console.log(`[ADMIN] Profile deleted: ${req.params.name}`);
  res.json({ success: true, profiles: await settings.listProfiles() });
});

app.post('/api/admin/test-signature', requirePin, (req, res) => {
  try {
    const { gateway } = req.body;
    if (gateway === 'ampersandpay') {
      const crypto = require('crypto');
      const testBody = JSON.stringify({ merchantId: req.body.ampersandpayMerchantId, txType: 'SALE', txAmount: '1.00', orderId: 'TEST001' });
      const payload = testBody + (req.body.ampersandpaySecretKey || '');
      const sig = crypto.createHash('sha512').update(payload, 'utf8').digest('hex');
      res.json({ success: true, gateway: 'AmpersandPay', signature: sig });
    } else {
      const testString = '1.00' + (req.body.duitnowAppCode || '') + (req.body.duitnowMerchantCode || '') + 'TESTREF001' + 'POS-01' + '2025-12-17 23:24:34';
      const sig = generateSignature(req.body.duitnowSecretKey || '', testString);
      res.json({ success: true, gateway: 'DuitNow', signature: sig });
    }
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ================================================================
// MOCK J&C API (sandbox mode)
// ================================================================
const mockTransactions = {};

app.post('/mock/Transaction', async (req, res) => {
  const ref = req.body.ReferenceNo;
  const amt = parseFloat(req.body.Amount).toFixed(2);
  mockTransactions[ref] = { status: 'pending', count: 0, amount: amt, terminal: req.body.TerminalCode, paid: false };
  console.log(`[MOCK J&C] Created: ${ref} - RM${amt}`);

  const s = await settings.load();
  const qrPayload = JSON.stringify({
    type: 'DUITNOW', merchant: s.duitnowMerchantCode || 'DEMO',
    ref, amount: amt, currency: 'MYR', server: BASE_URL
  });
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 280, margin: 2, color: { dark: '#1a1a2e' } });

  res.json({
    ResponseCode: '00', ResponseMessage: 'Successful',
    ExternalRefNo: 'EXT-' + Date.now(), ServiceName: 'DUITNOW',
    QRCode: qrDataUrl
  });
});

app.post('/mock/CheckQRTransaction', (req, res) => {
  const ref = req.body.ReferenceNo;
  const txn = mockTransactions[ref];
  if (!txn) return res.json({ ResponseCode: '05', ResponseMessage: 'Not found' });
  txn.count++;
  if (txn.paid) {
    res.json({ ReferenceNo: ref, Amount: txn.amount, ExternalRefNo: 'EXT-' + ref, ServiceName: 'DUITNOW', ResponseCode: '00', ResponseMessage: 'Successful' });
  } else {
    res.json({ ReferenceNo: ref, ResponseCode: '01', ResponseMessage: 'Pending' });
  }
});

app.post('/mock/Cancellation', (req, res) => {
  console.log(`[MOCK J&C] Cancelled: ${req.body.TransactionNo}`);
  res.json({ ResponseCode: '00', ResponseMessage: '' });
});

app.post('/mock/simulate-pay', async (req, res) => {
  const ref = req.body.referenceNo;
  const txn = mockTransactions[ref];
  if (!txn) return res.json({ success: false, message: 'Transaction not found' });
  if (txn.paid) return res.json({ success: false, message: 'Already paid' });

  txn.paid = true;
  console.log(`[MOCK J&C] Customer paid: ${ref}`);

  const s = await settings.load();
  const appCode = s.duitnowAppCode || 'DEMOAPP';
  const merchantCode = s.duitnowMerchantCode || 'DEMOMERCHANT';
  const secretKey = s.duitnowSecretKey || 'DEMOSECRET';

  const extRef = 'EXT-' + ref + '-PAID';
  const callbackPayload = {
    ApplicationCode: appCode, MerchantCode: merchantCode,
    TerminalCode: txn.terminal, ReferenceNo: ref, Amount: txn.amount,
    Date: new Date().toISOString().split('T')[0],
    Time: new Date().toTimeString().split(' ')[0],
    ExternalRefNo: extRef, ServiceName: 'DUITNOW', ResponseCode: '00'
  };
  const fields = Object.keys(callbackPayload).sort();
  callbackPayload.Signature = generateSignature(secretKey, fields.map(k => String(callbackPayload[k])).join(''));

  fetch(`${BASE_URL}/api/payment/duitnow/callback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(callbackPayload)
  }).then(r => r.json()).then(r => {
    console.log(`[MOCK J&C] Callback: ${r.ResponseCode}`);
  }).catch(e => console.log(`[MOCK J&C] Callback failed: ${e.message}`));

  res.json({ success: true });
});

// ================================================================
// MOCK AmpersandPay API (sandbox mode)
// ================================================================
const mockAmpersandTxns = {};

app.post('/mock/ampersandpay/tx/request', async (req, res) => {
  const ref = req.body.orderId;
  const amt = parseFloat(req.body.txAmount).toFixed(2);
  const txId = 'AP-' + Date.now();
  mockAmpersandTxns[txId] = { status: 'PENDING', amount: amt, orderId: ref, paid: false };
  console.log(`[MOCK AmpersandPay] Created: ${ref} txId=${txId} RM${amt}`);

  const qrPayload = JSON.stringify({
    type: 'AMPERSANDPAY', txId, ref, amount: amt, currency: 'MYR', server: BASE_URL
  });
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 280, margin: 2, color: { dark: '#1a1a2e' } });

  res.json({
    ret: 0,
    msg: 'Success',
    txId,
    qrCode: qrDataUrl
  });
});

app.post('/mock/ampersandpay/tx/query', (req, res) => {
  const txId = req.body.txId;
  const txn = mockAmpersandTxns[txId];
  if (!txn) return res.json({ ret: 1, msg: 'Not found', txStatus: 'FAILED' });

  res.json({
    ret: 0,
    msg: 'Success',
    txId,
    orderId: txn.orderId,
    txAmount: txn.amount,
    txStatus: txn.paid ? 'SUCCESS' : 'PENDING',
    txChannel: 'EW'
  });
});

app.post('/mock/ampersandpay/tx/void', (req, res) => {
  const txId = req.body.txId;
  console.log(`[MOCK AmpersandPay] Voided: ${txId}`);
  if (mockAmpersandTxns[txId]) mockAmpersandTxns[txId].status = 'FAILED';
  res.json({ ret: 0, msg: 'Voided', txId, txStatus: 'FAILED' });
});

app.post('/mock/ampersandpay/simulate-pay', (req, res) => {
  const txId = req.body.txId;
  const txn = mockAmpersandTxns[txId];
  if (!txn) return res.json({ success: false, message: 'Transaction not found' });
  if (txn.paid) return res.json({ success: false, message: 'Already paid' });

  txn.paid = true;
  console.log(`[MOCK AmpersandPay] Customer paid: ${txn.orderId} txId=${txId}`);

  // Send callback
  const callbackPayload = {
    txId, orderId: txn.orderId, txAmount: txn.amount,
    txCurrency: 'MYR', txStatus: 'SUCCESS', txChannel: 'EW'
  };

  fetch(`${BASE_URL}/api/payment/ampersandpay/callback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(callbackPayload)
  }).then(r => r.json()).then(r => {
    console.log(`[MOCK AmpersandPay] Callback sent`);
  }).catch(e => console.log(`[MOCK AmpersandPay] Callback failed: ${e.message}`));

  res.json({ success: true });
});

// ================================================================
// Payment API routes
// ================================================================
const createPaymentRouter = require('./routes/payment');

const store = {
  getSettings: async () => {
    const s = await settings.load();
    return {
      duitnowApplicationCode: s.duitnowAppCode || 'DEMOAPP',
      duitnowMerchantCode: s.duitnowMerchantCode || 'DEMOMERCHANT',
      duitnowSecretKey: s.duitnowSecretKey || 'DEMOSECRET',
      duitnowApiBaseUrl: s.duitnowApiUrl || `${BASE_URL}/mock`,
      ampersandpayMerchantId: s.ampersandpayMerchantId || '',
      ampersandpayTerminalId: s.ampersandpayTerminalId || '',
      ampersandpaySecretKey: s.ampersandpaySecretKey || '',
      ampersandpayApiUrl: s.ampersandpayApiUrl || `${BASE_URL}/mock/ampersandpay`,
      ampersandpayChannel: s.ampersandpayChannel || 'EW',
      ampersandpayScheme: s.ampersandpayScheme || '',
      ampersandpayCallbackUrl: s.ampersandpayCallbackUrl || '',
      ampersandpayReturnUrl: s.ampersandpayReturnUrl || ''
    };
  }
};

app.use(createPaymentRouter(store, {
  onTransactionCreate: (data) => {
    db.insert(data).catch(e => console.error('[DB] insert:', e.message));
  },
  onTransactionCancel: (referenceNo) => {
    db.updateByRef(referenceNo, { status: 'cancelled', completedAt: mytNow() }).catch(() => {});
  },
  onTransactionPaid: (result) => {
    console.log(`[POLL] onTransactionPaid called: referenceNo="${result.referenceNo}"`);
    db.updateByRef(result.referenceNo, {
      status: 'paid',
      externalRefNo: result.externalRefNo || '',
      method: 'polling',
      completedAt: mytNow()
    }).catch(e => console.error('[DB] poll update:', e.message));
  },
  onPaymentUpdate: (result) => {
    console.log(`[WEBHOOK → POS] ${result.referenceNo} → ${result.status}`);
    try { broadcastToPos({ type: 'payment_update', ...result }); } catch(e) { console.error('[WS] broadcast error:', e.message); }
    if (result.success) {
      db.updateByRef(result.referenceNo, {
        status: 'paid',
        externalRefNo: result.externalRefNo || '',
        method: result.method || 'webhook',
        completedAt: mytNow()
      }).catch(e => console.error('[DB] update:', e.message));
    }
  }
}));

// --- Render QR image from EMV string (for J&C real QR data) ---
app.get('/api/qr', async (req, res) => {
  try {
    const data = req.query.data;
    if (!data) return res.status(400).send('Missing data');
    const buf = await QRCode.toBuffer(data, { width: 320, margin: 2, color: { dark: '#1a1a2e' } });
    res.type('png').send(buf);
  } catch (e) {
    res.status(500).send('QR render failed: ' + e.message);
  }
});

// ================================================================
// Serve UI
// ================================================================
const NO_CACHE = { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' };
app.get('/', (req, res) => { res.set(NO_CACHE); res.sendFile(path.join(__dirname, 'demo.html')); });
app.get('/pay', (req, res) => { res.set(NO_CACHE); res.sendFile(path.join(__dirname, 'demo-customer.html')); });
app.get('/admin', (req, res) => { res.set(NO_CACHE); res.sendFile(path.join(__dirname, 'admin.html')); });

// Public config (active gateway + tx running no, no PIN required)
app.get('/api/config', async (req, res) => {
  const s = await settings.load();
  const VALID_GW = ['duitnow', 'ampersandpay', 'ecpi'];
  const gw = VALID_GW.includes(s.activeGateway) ? s.activeGateway : 'duitnow';
  const mask = v => v && v.length > 6 ? '••••••' + v.slice(-6) : v ? '••••••' : '(not set)';

  let gwInfo = {};
  if (gw === 'duitnow') {
    gwInfo = {
      apiUrl: s.duitnowApiUrl || '(not set)',
      merchantId: s.duitnowMerchantCode || s.duitnowAppCode || '(not set)',
      secretKey: mask(s.duitnowSecretKey)
    };
  } else if (gw === 'ampersandpay') {
    gwInfo = {
      apiUrl: s.ampersandpayApiUrl || '(not set)',
      merchantId: s.ampersandpayMerchantId || '(not set)',
      secretKey: mask(s.ampersandpaySecretKey)
    };
  }

  const today = getTxDate();
  const seq = s.txRunningDate === today ? (parseInt(s.txRunningNo) || 1) : 1;
  const txRunningNo = today + String(seq).padStart(3, '0');

  res.json({
    activeGateway: gw,
    activeProfile: s.activeProfile || '',
    txRunningNo,
    terminalCode: s.terminalCode || 'POS-01',
    gwInfo
  });
});

// Mark transaction as paid (called by POS frontend after payment confirmed)
app.post('/api/payment/paid', async (req, res) => {
  const { referenceNo, externalRefNo, method } = req.body;
  if (!referenceNo) return res.status(400).json({ error: 'referenceNo required' });
  try {
    await db.updateByRef(referenceNo, {
      status: 'paid',
      externalRefNo: externalRefNo || '',
      method: method || 'unknown',
      completedAt: mytNow()
    });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Increment transaction running no + mark transaction as paid (called by POS after successful payment)
app.post('/api/txno/increment', async (req, res) => {
  const s = await settings.load();
  const today = getTxDate();
  const nextSeq = s.txRunningDate === today ? (parseInt(s.txRunningNo) || 1) + 1 : 2;
  await settings.save({ txRunningNo: nextSeq, txRunningDate: today });
  const txRunningNo = today + String(nextSeq).padStart(3, '0');

  const { referenceNo, externalRefNo, method, paymentMethod } = req.body || {};
  console.log(`[TXNO] increment called, referenceNo="${referenceNo || '(none)'}", txNo="${txRunningNo}"`);
  if (referenceNo) {
    db.updateByRef(referenceNo, {
      status: 'paid',
      externalRefNo: externalRefNo || '',
      method: method || 'unknown',
      paymentMethod: paymentMethod || '',
      completedAt: mytNow()
    }).catch(e => console.error('[DB] paid update failed:', e.message));
  }

  res.json({ txRunningNo });
});

// APK version info
app.get('/api/version', (req, res) => {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8'));
    res.json(info);
  } catch (e) {
    res.json({ version: '1.0.0', githubRepo: '' });
  }
});

// Admin: update current version in version.json
app.put('/api/admin/version', requirePin, (req, res) => {
  try {
    const versionFile = path.join(__dirname, 'version.json');
    const info = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
    info.version = req.body.version;
    fs.writeFileSync(versionFile, JSON.stringify(info, null, 2), 'utf8');
    console.log(`[ADMIN] App version updated to ${info.version}`);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// Transactions Report API
// ================================================================
app.get('/api/admin/transactions', requireAuth, async (req, res) => {
  try {
    const { limit, offset, gateway, status, from, to, terminal } = req.query;
    res.json(await db.query({ limit: parseInt(limit)||50, offset: parseInt(offset)||0, gateway, status, from, to, terminal }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/transactions/summary', requireAuth, async (req, res) => {
  try {
    const { gateway, from, to, terminal } = req.query;
    res.json(await db.summary({ gateway: gateway || '', from: from || '', to: to || '', terminal: terminal || '' }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/transactions/by-user', requireAuth, async (req, res) => {
  try {
    const { gateway, from, to, terminal, cashier } = req.query;
    res.json(await db.byUser({ gateway: gateway || '', from: from || '', to: to || '', terminal: terminal || '', cashier: cashier || '' }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/transactions/cashiers', requireAuth, async (req, res) => {
  try { res.json(await db.getCashiers()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Health check
app.get('/health', async (req, res) => {
  const s = await settings.load();
  res.json({ status: 'ok', mode: s.duitnowApiUrl ? 'live' : 'sandbox', enabled: s.duitnowEnabled });
});

schema.init().catch(err => {
  console.error('[DB] Schema init failed:', err.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', async () => {
  // Ensure data directory exists
  const dataDir = process.env.DATA_DIR || path.join(__dirname);
  if (process.env.DATA_DIR) {
    try { fs.mkdirSync(process.env.DATA_DIR, { recursive: true }); } catch(e) {}
  }

  const s = await settings.load();
  const mode = s.duitnowApiUrl ? 'LIVE' : 'SANDBOX';
  console.log(`\n=== DuitNow Payment Gateway ===`);
  console.log(`POS Terminal:  ${BASE_URL}`);
  console.log(`Admin Panel:   ${BASE_URL}/admin`);
  console.log(`Callback URL:  ${BASE_URL}/api/payment/duitnow/callback`);
  console.log(`Data directory: ${process.env.DATA_DIR || '(project root — not persistent)'}`);
  console.log(`Mode: ${mode}\n`);
});
