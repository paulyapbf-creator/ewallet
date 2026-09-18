# Wallet Integration Guide (for POS/KDS)

## Overview

The wallet is a multi-tenant payment gateway service. POS/KDS clients call its REST API to process payments through J&C DuitNow, AmpersandPay, or ECPI Terminal.

## Multi-Tenant Setup

Each tenant (shop/outlet) has its own **profile** in the wallet admin panel containing:
- Gateway credentials (App Code, Merchant Code, Secret Key, API URL)
- Terminal Code
- Active gateway preference

Create profiles in the admin panel (`/admin`) — profile name = tenant ID.

Example profiles:
- `RG001_Live` — Merchant RG001, production credentials
- `RG002_Live` — Merchant RG002, production credentials
- `RG001_UAT` — Merchant RG001, UAT credentials

## POS → Wallet Flow

```
POS (BKT House) → Wallet Server → J&C API
                                 ↓
                                 Webhook
                                 ↓
                  Wallet Server → POS (via WebSocket)
```

## API Endpoints

All payment requests accept an optional `tenantId` in the body. If provided, the wallet loads that tenant's profile for the request. If omitted, uses global active settings.

### 1. List Available Tenants

```http
GET /api/payment/tenants
```

Response:
```json
{
  "tenants": [
    { "name": "RG001_Live", "activeGateway": "duitnow", "hasJC": true },
    { "name": "RG002_Live", "activeGateway": "duitnow", "hasJC": true }
  ]
}
```

### 2. Create Payment Transaction

```http
POST /api/payment/duitnow/create
Content-Type: application/json

{
  "tenantId": "RG001_Live",
  "amount": 10.00,
  "referenceNo": "ORDER-123",
  "terminalCode": "POS01"   // optional; uses profile's default if omitted
}
```

Response:
```json
{
  "success": true,
  "status": "success",
  "referenceNo": "ORDER-123",
  "externalRefNo": "16819956166982",
  "amount": 10.00,
  "provider": "duitnow",
  "qrData": "00020201021226580014A000...",   // EMV QR string for banking apps
  "tenantId": "RG001_Live"
}
```

### 3. Render QR Image

Convert the `qrData` EMV string to a scannable QR image:

```http
GET /api/qr?data=<URL_ENCODED_QR_DATA>
```

Returns a PNG image.

### 4. Poll Payment Status

```http
POST /api/payment/duitnow/poll
Content-Type: application/json

{
  "tenantId": "RG001_Live",
  "referenceNo": "ORDER-123",
  "intervalMs": 3000,
  "maxAttempts": 60
}
```

Long-polls until final status (success/failed/refunded). Returns the final result.

### 5. Cancel Transaction

```http
POST /api/payment/duitnow/cancel
Content-Type: application/json

{
  "tenantId": "RG001_Live",
  "transactionNo": "16819956166982"
}
```

### 6. Real-time Webhook Notifications

Connect to the wallet's WebSocket for push notifications when payments complete:

```javascript
const ws = new WebSocket('ws://wallet-host:4568');
ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.type === 'payment_update') {
    console.log('Payment completed:', data.tenantId, data.referenceNo, data.status);
  }
};
```

## POS Integration Example (Node.js)

```javascript
// kds/server.js
const WALLET_URL = process.env.WALLET_URL || 'http://localhost:4568';

async function createPayment(tenantId, amount, referenceNo) {
  const res = await fetch(`${WALLET_URL}/api/payment/duitnow/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, amount, referenceNo })
  });
  return res.json();
}

async function pollPayment(tenantId, referenceNo) {
  const res = await fetch(`${WALLET_URL}/api/payment/duitnow/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, referenceNo })
  });
  return res.json();
}

// Express route in KDS server
app.post('/api/pos/pay-duitnow', async (req, res) => {
  const { amount, orderId } = req.body;
  const tenantId = req.headers['x-tenant-id'] || 'default';

  // 1. Create transaction
  const payment = await createPayment(tenantId, amount, orderId);
  if (!payment.success) return res.json({ error: payment.message });

  // 2. Return QR image URL to frontend
  res.json({
    qrImage: `${WALLET_URL}/api/qr?data=${encodeURIComponent(payment.qrData)}`,
    externalRef: payment.externalRefNo,
    referenceNo: payment.referenceNo
  });
});
```

## POS Frontend Example

```javascript
// pos/app.js
async function payWithDuitNow(amount, orderId) {
  const tenantId = 'RG001_Live'; // current outlet's tenant

  const res = await fetch('/api/pos/pay-duitnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
    body: JSON.stringify({ amount, orderId })
  });
  const data = await res.json();

  // Display QR image
  document.getElementById('qrImage').src = data.qrImage;

  // Poll for completion
  const result = await fetch('/api/payment/duitnow/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, referenceNo: orderId })
  }).then(r => r.json());

  if (result.success) {
    showReceipt(result);
  }
}
```

## Webhook Callback URL

Give J&C this URL (publicly accessible via Railway/ngrok):

```
https://your-wallet-domain/api/payment/duitnow/callback
```

The wallet automatically detects the tenant by matching `MerchantCode` in the callback payload to the saved profiles.

## Settings vs Profiles

- **Settings** (`settings.json`) — the currently active configuration, used when no `tenantId` is provided
- **Profiles** (`profiles.json`) — saved tenant configurations, selected via `tenantId` in API calls

## Switching Gateway

If a tenant wants to use AmpersandPay instead of J&C, the POS just calls a different endpoint:

```
/api/payment/ampersandpay/create   → uses tenant's AmpersandPay credentials
/api/payment/ecpi/create           → uses tenant's ECPI terminal settings
```

Same tenant profile, different gateway — all credentials are stored in the same profile.
