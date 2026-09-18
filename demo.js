const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { getGateway } = require('./index');
const { generateSignature } = require('./lib/signature');
const settings = require('./lib/settings');

const PORT = 4568;

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
const LOCAL_IP = getLocalIP();
let BASE_URL = `https://${LOCAL_IP}:${PORT}`;

const app = express();
app.use(express.json());

// Use --http flag to force HTTP mode: node demo.js --http
const forceHttp = process.argv.includes('--http');
let server;
let protocol = 'http';
if (!forceHttp) {
  try {
    const sslOptions = {
      key: fs.readFileSync(path.join(__dirname, 'key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
    };
    server = https.createServer(sslOptions, app);
    protocol = 'https';
    console.log('[SSL] HTTPS enabled');
  } catch (e) {
    console.log('[SSL] No certs found, using HTTP');
    server = http.createServer(app);
  }
} else {
  console.log('[SSL] HTTP mode (--http flag)');
  server = http.createServer(app);
}

// Allow self-signed cert for internal calls
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
  res.json(settings.load());
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
// Mock J&C API (always available for sandbox testing)
// ================================================================
const mockTransactions = {};

app.post('/mock/Transaction', async (req, res) => {
  const ref = req.body.ReferenceNo;
  const amt = parseFloat(req.body.Amount).toFixed(2);
  mockTransactions[ref] = { status: 'pending', count: 0, amount: amt, terminal: req.body.TerminalCode, paid: false };
  console.log(`[MOCK J&C] Created: ${ref} - RM${amt}`);

  const qrPayload = JSON.stringify({
    type: 'DUITNOW', merchant: req.body.MerchantCode || 'DEMO',
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
// Payment API routes (reads from settings.json)
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
      ampersandpayApiUrl: s.ampersandpayApiUrl || `${BASE_URL}/mock/ampersandpay`,
      ecpiHost: s.ecpiHost || 'localhost',
      ecpiPort: s.ecpiPort || '5001',
      ecpiTimeout: s.ecpiTimeout || '60000',
      ecpiChecksumMode: s.ecpiChecksumMode || 'bcc'
    };
  }
};

app.use(createPaymentRouter(store, {
  onPaymentUpdate: (result) => {
    console.log(`[WEBHOOK → POS] ${result.referenceNo} → ${result.status}`);
    broadcastToPos({ type: 'payment_update', ...result });
  }
}));

// ================================================================
// ECPI Terminal API (separate from payment routes)
// ================================================================
let ecpiGateway = null;

app.post('/api/terminal/connect', requirePin, async (req, res) => {
  try {
    const s = settings.load();
    ecpiGateway = getGateway('ecpi', {
      host: req.body.host || s.ecpiHost || 'localhost',
      port: req.body.port || s.ecpiPort || '5001',
      timeout: s.ecpiTimeout || '60000',
      checksumMode: s.ecpiChecksumMode || 'bcc'
    });
    const result = await ecpiGateway.connect();
    res.json(result);
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/api/terminal/disconnect', (req, res) => {
  if (ecpiGateway) ecpiGateway.disconnect();
  res.json({ success: true, message: 'Disconnected' });
});

app.get('/api/terminal/status', (req, res) => {
  res.json(ecpiGateway ? ecpiGateway.getStatus() : { connected: false });
});

app.post('/api/terminal/pay', async (req, res) => {
  try {
    if (!ecpiGateway) throw new Error('Terminal not initialized — connect first');
    const result = await ecpiGateway.createTransaction({ amount: req.body.amount });
    res.json(result);
  } catch (e) {
    res.json({ success: false, status: 'error', message: e.message, provider: 'ecpi' });
  }
});

app.post('/api/terminal/void', async (req, res) => {
  try {
    if (!ecpiGateway) throw new Error('Terminal not initialized');
    const result = await ecpiGateway.cancelTransaction({ approvalCode: req.body.approvalCode });
    res.json(result);
  } catch (e) {
    res.json({ success: false, status: 'error', message: e.message });
  }
});

app.get('/api/terminal/logs', (req, res) => {
  res.json({ logs: ecpiGateway ? ecpiGateway.getLogs() : [] });
});

app.post('/api/terminal/scenario', (req, res) => {
  if (mockTerminal) {
    mockTerminal.setScenario(req.body.scenario || 'success');
    res.json({ success: true, scenario: req.body.scenario });
  } else {
    res.json({ success: false, message: 'Mock terminal not running' });
  }
});

app.get('/api/terminal/scenario', (req, res) => {
  res.json({ scenario: mockTerminal ? mockTerminal.scenario : 'success' });
});

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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'demo.html')));
app.get('/pay', (req, res) => res.sendFile(path.join(__dirname, 'demo-customer.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/terminal', (req, res) => res.sendFile(path.join(__dirname, 'terminal.html')));
app.get('/health', (req, res) => {
  const s = settings.load();
  res.json({ status: 'ok', mode: s.duitnowApiUrl ? 'live' : 'sandbox', enabled: s.duitnowEnabled });
});

// ================================================================
// Start mock terminal + server
// ================================================================
const { MockTerminal } = require('./lib/mock-terminal');
let mockTerminal = null;

async function startServer() {
  // Start mock terminal
  mockTerminal = new MockTerminal(5001);
  await mockTerminal.start();

  server.listen(PORT, '0.0.0.0', () => {
    BASE_URL = `${protocol}://${LOCAL_IP}:${PORT}`;
    const s = settings.load();
    const mode = s.duitnowApiUrl ? 'LIVE → ' + s.duitnowApiUrl : 'SANDBOX (mock)';
    console.log(`\n=== Payment Gateway (Local) ===`);
    console.log(`POS Terminal:  ${protocol}://localhost:${PORT}`);
    console.log(`Card Terminal: ${protocol}://localhost:${PORT}/terminal`);
    console.log(`Admin Panel:   ${protocol}://localhost:${PORT}/admin`);
    console.log(`Phone/Network: ${BASE_URL}`);
    console.log(`Mock Terminal: TCP port 5001`);
    console.log(`Mode: ${mode} | PIN: ${s.adminPin}\n`);
  });
}

startServer();
