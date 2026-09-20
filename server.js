const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { getGateway } = require('./index');
const { generateSignature } = require('./lib/signature');
const settings = require('./lib/settings');

const db = require('./lib/db');
const { mytNow } = db;

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
// Admin PIN middleware
// ================================================================
function requirePin(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  const current = settings.load();
  if (!current.adminPin || pin === current.adminPin) return next();
  res.status(401).json({ error: 'Wrong PIN' });
}

// ================================================================
// Admin Settings API
// ================================================================
app.get('/api/admin/settings', requirePin, (req, res) => {
  const s = settings.load();
  // Mask secret key for display (show last 4 chars only)
  res.json(s);
});

app.put('/api/admin/settings', requirePin, (req, res) => {
  const saved = settings.save(req.body);
  console.log('[ADMIN] Settings updated');
  res.json(saved);
});

// --- Profiles API ---
app.get('/api/admin/profiles', requirePin, (req, res) => {
  res.json({ profiles: settings.listProfiles() });
});

app.post('/api/admin/profiles/:name', requirePin, (req, res) => {
  const current = settings.load();
  settings.saveProfile(req.params.name, { ...current, ...req.body });
  console.log(`[ADMIN] Profile saved: ${req.params.name}`);
  res.json({ success: true, profiles: settings.listProfiles() });
});

app.get('/api/admin/profiles/:name/load', requirePin, (req, res) => {
  const profile = settings.loadProfile(req.params.name);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  const saved = settings.save(profile);
  console.log(`[ADMIN] Profile loaded: ${req.params.name}`);
  res.json(saved);
});

app.delete('/api/admin/profiles/:name', requirePin, (req, res) => {
  settings.deleteProfile(req.params.name);
  console.log(`[ADMIN] Profile deleted: ${req.params.name}`);
  res.json({ success: true, profiles: settings.listProfiles() });
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

  const s = settings.load();
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

app.post('/mock/simulate-pay', (req, res) => {
  const ref = req.body.referenceNo;
  const txn = mockTransactions[ref];
  if (!txn) return res.json({ success: false, message: 'Transaction not found' });
  if (txn.paid) return res.json({ success: false, message: 'Already paid' });

  txn.paid = true;
  console.log(`[MOCK J&C] Customer paid: ${ref}`);

  const s = settings.load();
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
    const s = settings.load();
    return {
      duitnowApplicationCode: s.duitnowAppCode || 'DEMOAPP',
      duitnowMerchantCode: s.duitnowMerchantCode || 'DEMOMERCHANT',
      duitnowSecretKey: s.duitnowSecretKey || 'DEMOSECRET',
      duitnowApiBaseUrl: s.duitnowApiUrl || `${BASE_URL}/mock`,
      ampersandpayMerchantId: s.ampersandpayMerchantId || '',
      ampersandpaySecretKey: s.ampersandpaySecretKey || '',
      ampersandpayApiUrl: s.ampersandpayApiUrl || `${BASE_URL}/mock/ampersandpay`
    };
  }
};

app.use(createPaymentRouter(store, {
  onTransactionCreate: (data) => {
    try { db.insert(data); } catch(e) { console.error('[DB] insert:', e.message); }
  },
  onTransactionCancel: (referenceNo) => {
    try { db.updateByRef(referenceNo, { status: 'cancelled', completedAt: new Date().toISOString() }); } catch(e) {}
  },
  onTransactionPaid: (result) => {
    console.log(`[POLL] onTransactionPaid called: referenceNo="${result.referenceNo}"`);
    try {
      db.updateByRef(result.referenceNo, {
        status: 'paid',
        externalRefNo: result.externalRefNo || '',
        method: 'polling',
        completedAt: mytNow()
      });
    } catch(e) { console.error('[DB] poll update:', e.message); }
  },
  onPaymentUpdate: (result) => {
    console.log(`[WEBHOOK → POS] ${result.referenceNo} → ${result.status}`);
    try { broadcastToPos({ type: 'payment_update', ...result }); } catch(e) { console.error('[WS] broadcast error:', e.message); }
    if (result.success) {
      try {
        db.updateByRef(result.referenceNo, {
          status: 'paid',
          externalRefNo: result.externalRefNo || '',
          method: result.method || 'webhook',
          completedAt: new Date().toISOString()
        });
      } catch(e) { console.error('[DB] update:', e.message); }
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
app.get('/', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'demo.html')); });
app.get('/pay', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'demo-customer.html')); });
app.get('/admin', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'admin.html')); });

// Public config (active gateway + tx running no, no PIN required)
app.get('/api/config', (req, res) => {
  const s = settings.load();
  res.json({ activeGateway: s.activeGateway || 'duitnow', txRunningNo: s.txRunningNo || 1, terminalCode: s.terminalCode || 'POS-01' });
});

// Mark transaction as paid (called by POS frontend after payment confirmed)
app.post('/api/payment/paid', (req, res) => {
  const { referenceNo, externalRefNo, method } = req.body;
  if (!referenceNo) return res.status(400).json({ error: 'referenceNo required' });
  try {
    db.updateByRef(referenceNo, {
      status: 'paid',
      externalRefNo: externalRefNo || '',
      method: method || 'unknown',
      completedAt: new Date().toISOString()
    });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Increment transaction running no + mark transaction as paid (called by POS after successful payment)
app.post('/api/txno/increment', (req, res) => {
  const s = settings.load();
  const next = (parseInt(s.txRunningNo) || 1) + 1;
  settings.save({ txRunningNo: next });

  // Update transaction DB status if referenceNo provided
  const { referenceNo, externalRefNo, method } = req.body || {};
  console.log(`[TXNO] increment called, referenceNo="${referenceNo || '(none)'}"`);
  if (referenceNo) {
    try {
      db.updateByRef(referenceNo, {
        status: 'paid',
        externalRefNo: externalRefNo || '',
        method: method || 'unknown',
        completedAt: mytNow()
      });
    } catch(e) { console.error('[DB] paid update failed:', e.message); }
  }

  res.json({ txRunningNo: next });
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
app.get('/api/admin/transactions', requirePin, (req, res) => {
  try {
    const { limit, offset, gateway, status, from, to, terminal } = req.query;
    const result = db.query({ limit: parseInt(limit)||50, offset: parseInt(offset)||0, gateway, status, from, to, terminal });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/transactions/summary', requirePin, (req, res) => {
  try { res.json(db.summary()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Health check
app.get('/health', (req, res) => {
  const s = settings.load();
  res.json({ status: 'ok', mode: s.duitnowApiUrl ? 'live' : 'sandbox', enabled: s.duitnowEnabled });
});

server.listen(PORT, '0.0.0.0', () => {
  const s = settings.load();
  const mode = s.duitnowApiUrl ? 'LIVE' : 'SANDBOX';
  console.log(`\n=== DuitNow Payment Gateway ===`);
  console.log(`POS Terminal:  ${BASE_URL}`);
  console.log(`Customer App:  ${BASE_URL}/pay`);
  console.log(`Admin Panel:   ${BASE_URL}/admin`);
  console.log(`Callback URL:  ${BASE_URL}/api/payment/duitnow/callback`);
  console.log(`Mode: ${mode} | Default PIN: ${s.adminPin}\n`);
});
