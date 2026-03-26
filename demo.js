const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const { getGateway } = require('./index');
const { generateSignature } = require('./lib/signature');
const os = require('os');

const app = express();
app.use(express.json());

// HTTPS for camera access on mobile
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))
};
const server = https.createServer(sslOptions, app);

// Get local IP for network access
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

// --- WebSocket: push payment updates to browser ---
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

// --- Config ---
const DEMO_CONFIG = {
  applicationCode: 'DEMOAPP',
  merchantCode: 'DEMOMERCHANT',
  secretKey: 'DEMOSECRET',
  apiBaseUrl: `https://${LOCAL_IP}:4568/mock`
};

// --- Mock J&C API Server ---
let mockTransactions = {};

// Create transaction — returns QR data URL
app.post('/mock/Transaction', async (req, res) => {
  const ref = req.body.ReferenceNo;
  const amt = parseFloat(req.body.Amount).toFixed(2);
  mockTransactions[ref] = { status: 'pending', count: 0, amount: amt, terminal: req.body.TerminalCode, paid: false };
  console.log(`[J&C] Created: ${ref} - RM${amt}`);

  // Generate QR code containing payment info (in real J&C this would be a DuitNow QR string)
  const qrPayload = JSON.stringify({
    type: 'DUITNOW',
    merchant: DEMO_CONFIG.merchantCode,
    ref: ref,
    amount: amt,
    currency: 'MYR',
    server: `https://${LOCAL_IP}:4568`
  });
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 280, margin: 2, color: { dark: '#1a1a2e' } });

  res.json({
    ResponseCode: '00', ResponseMessage: 'Successful',
    ExternalRefNo: 'EXT-' + Date.now(), ServiceName: 'DUITNOW',
    QRCode: qrDataUrl
  });
});

// Check transaction
app.post('/mock/CheckTransaction', (req, res) => {
  const ref = req.body.ReferenceNo;
  const txn = mockTransactions[ref];
  if (!txn) return res.json({ ResponseCode: '05', ResponseMessage: 'Not found' });

  txn.count++;
  if (txn.paid) {
    res.json({
      ReferenceNo: ref, Amount: txn.amount, ExternalRefNo: 'EXT-' + ref,
      ServiceName: 'DUITNOW', ResponseCode: '00', ResponseMessage: 'Successful'
    });
  } else {
    res.json({ ReferenceNo: ref, ResponseCode: '01', ResponseMessage: 'Pending' });
  }
});

// Cancel
app.post('/mock/Cancellation', (req, res) => {
  console.log(`[J&C] Cancelled: ${req.body.TransactionNo}`);
  res.json({ ResponseCode: '00', ResponseMessage: '' });
});

// Simulate customer paying (triggered from UI or QR scan)
app.post('/mock/simulate-pay', (req, res) => {
  const ref = req.body.referenceNo;
  const txn = mockTransactions[ref];
  if (!txn) return res.json({ success: false, message: 'Transaction not found' });
  if (txn.paid) return res.json({ success: false, message: 'Already paid' });

  txn.paid = true;
  console.log(`[J&C] Customer paid: ${ref}`);

  // Send webhook callback (like real J&C would)
  const extRef = 'EXT-' + ref + '-PAID';
  const callbackPayload = {
    ApplicationCode: DEMO_CONFIG.applicationCode,
    MerchantCode: DEMO_CONFIG.merchantCode,
    TerminalCode: txn.terminal,
    ReferenceNo: ref,
    Amount: txn.amount,
    Date: new Date().toISOString().split('T')[0],
    Time: new Date().toTimeString().split(' ')[0],
    ExternalRefNo: extRef,
    ServiceName: 'DUITNOW',
    ResponseCode: '00'
  };

  const fields = Object.keys(callbackPayload).sort();
  const combinationString = fields.map(k => String(callbackPayload[k])).join('');
  callbackPayload.Signature = generateSignature(DEMO_CONFIG.secretKey, combinationString);

  console.log(`[J&C] Sending webhook for ${ref}...`);
  fetch(`https://${LOCAL_IP}:4568/api/payment/duitnow/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(callbackPayload)
  }).then(r => r.json()).then(r => {
    console.log(`[J&C] Callback response: ${r.ResponseCode} - ${r.ResponseMessage}`);
  }).catch(e => console.log(`[J&C] Callback failed: ${e.message}`));

  res.json({ success: true });
});

// --- Payment API routes ---
const createPaymentRouter = require('./routes/payment');

const mockStore = {
  getSettings: async () => ({
    duitnowApplicationCode: DEMO_CONFIG.applicationCode,
    duitnowMerchantCode: DEMO_CONFIG.merchantCode,
    duitnowSecretKey: DEMO_CONFIG.secretKey,
    duitnowApiBaseUrl: DEMO_CONFIG.apiBaseUrl
  })
};

app.use(createPaymentRouter(mockStore, {
  onPaymentUpdate: (result) => {
    console.log(`[PUSH] Sending to POS: ${result.referenceNo} → ${result.status}`);
    broadcastToPos({ type: 'payment_update', ...result });
  }
}));

// --- Serve UI ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'demo.html')));
app.get('/pay', (req, res) => res.sendFile(path.join(__dirname, 'demo-customer.html')));

// Allow self-signed cert for internal webhook calls
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

server.listen(4568, '0.0.0.0', () => {
  console.log('\n=== DuitNow Payment Demo ===');
  console.log(`POS Terminal:  https://${LOCAL_IP}:4568`);
  console.log(`Customer App:  https://${LOCAL_IP}:4568/pay`);
  console.log('\nFlow: POS shows QR → Customer scans & pays → Webhook confirms\n');
});
