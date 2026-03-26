const express = require('express');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { getGateway } = require('./index');
const { generateSignature } = require('./lib/signature');

const PORT = process.env.PORT || 4568;
const RAILWAY_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN;
const BASE_URL = RAILWAY_DOMAIN ? `https://${RAILWAY_DOMAIN}` : `http://localhost:${PORT}`;

// DuitNow credentials from environment
const DUITNOW_CONFIG = {
  applicationCode: process.env.DUITNOW_APP_CODE || 'DEMOAPP',
  merchantCode: process.env.DUITNOW_MERCHANT_CODE || 'DEMOMERCHANT',
  secretKey: process.env.DUITNOW_SECRET_KEY || 'DEMOSECRET',
  apiBaseUrl: process.env.DUITNOW_API_URL || `${BASE_URL}/mock`
};

const IS_SANDBOX = !process.env.DUITNOW_API_URL; // If no real API URL, use mock

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
// MOCK J&C API (only active in sandbox mode)
// ================================================================
if (IS_SANDBOX) {
  const mockTransactions = {};

  app.post('/mock/Transaction', async (req, res) => {
    const ref = req.body.ReferenceNo;
    const amt = parseFloat(req.body.Amount).toFixed(2);
    mockTransactions[ref] = { status: 'pending', count: 0, amount: amt, terminal: req.body.TerminalCode, paid: false };
    console.log(`[MOCK J&C] Created: ${ref} - RM${amt}`);

    const qrPayload = JSON.stringify({
      type: 'DUITNOW', merchant: DUITNOW_CONFIG.merchantCode,
      ref, amount: amt, currency: 'MYR', server: BASE_URL
    });
    const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 280, margin: 2, color: { dark: '#1a1a2e' } });

    res.json({
      ResponseCode: '00', ResponseMessage: 'Successful',
      ExternalRefNo: 'EXT-' + Date.now(), ServiceName: 'DUITNOW',
      QRCode: qrDataUrl
    });
  });

  app.post('/mock/CheckTransaction', (req, res) => {
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

    const extRef = 'EXT-' + ref + '-PAID';
    const callbackPayload = {
      ApplicationCode: DUITNOW_CONFIG.applicationCode,
      MerchantCode: DUITNOW_CONFIG.merchantCode,
      TerminalCode: txn.terminal,
      ReferenceNo: ref, Amount: txn.amount,
      Date: new Date().toISOString().split('T')[0],
      Time: new Date().toTimeString().split(' ')[0],
      ExternalRefNo: extRef, ServiceName: 'DUITNOW', ResponseCode: '00'
    };
    const fields = Object.keys(callbackPayload).sort();
    callbackPayload.Signature = generateSignature(DUITNOW_CONFIG.secretKey, fields.map(k => String(callbackPayload[k])).join(''));

    fetch(`${BASE_URL}/api/payment/duitnow/callback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callbackPayload)
    }).then(r => r.json()).then(r => {
      console.log(`[MOCK J&C] Callback: ${r.ResponseCode}`);
    }).catch(e => console.log(`[MOCK J&C] Callback failed: ${e.message}`));

    res.json({ success: true });
  });

  console.log('[MODE] Sandbox — mock J&C API enabled');
} else {
  console.log('[MODE] Live — using real J&C API at', DUITNOW_CONFIG.apiBaseUrl);
}

// ================================================================
// Payment API routes
// ================================================================
const createPaymentRouter = require('./routes/payment');

const store = {
  getSettings: async () => ({
    duitnowApplicationCode: DUITNOW_CONFIG.applicationCode,
    duitnowMerchantCode: DUITNOW_CONFIG.merchantCode,
    duitnowSecretKey: DUITNOW_CONFIG.secretKey,
    duitnowApiBaseUrl: DUITNOW_CONFIG.apiBaseUrl
  })
};

app.use(createPaymentRouter(store, {
  onPaymentUpdate: (result) => {
    console.log(`[WEBHOOK → POS] ${result.referenceNo} → ${result.status}`);
    broadcastToPos({ type: 'payment_update', ...result });
  }
}));

// ================================================================
// Serve UI
// ================================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'demo.html')));
app.get('/pay', (req, res) => res.sendFile(path.join(__dirname, 'demo-customer.html')));

// Health check for Railway
app.get('/health', (req, res) => res.json({ status: 'ok', mode: IS_SANDBOX ? 'sandbox' : 'live' }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n=== DuitNow Payment Gateway ===`);
  console.log(`POS Terminal:  ${BASE_URL}`);
  console.log(`Customer App:  ${BASE_URL}/pay`);
  console.log(`Callback URL:  ${BASE_URL}/api/payment/duitnow/callback`);
  console.log(`Health Check:  ${BASE_URL}/health`);
  console.log(`Mode: ${IS_SANDBOX ? 'SANDBOX (mock)' : 'LIVE'}\n`);
});
