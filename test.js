const express = require('express');
const { getGateway, listGateways } = require('./index');
const { generateSignature } = require('./lib/signature');

const app = express();
app.use(express.json());

// --- Mock DuitNow API server (simulates J&C responses) ---

let mockTransactions = {};

app.post('/mock/Transaction', (req, res) => {
  const ref = req.body.ReferenceNo;
  mockTransactions[ref] = { status: 'pending', count: 0 };
  console.log(`[MOCK] Create transaction: ${ref} - RM${req.body.Amount}`);
  console.log(`[MOCK] Signature received: ${req.body.Signature}`);
  res.json({
    ResponseCode: '00',
    ResponseMessage: 'Successful',
    ExternalRefNo: 'EXT-' + ref,
    ServiceName: 'DUITNOW'
  });
});

app.post('/mock/CheckTransaction', (req, res) => {
  const ref = req.body.ReferenceNo;
  const txn = mockTransactions[ref];

  if (!txn) {
    console.log(`[MOCK] Check unknown ref: ${ref}`);
    return res.json({ ResponseCode: '05', ResponseMessage: 'Not found' });
  }

  txn.count++;
  // Simulate: pending for first 2 checks, then success
  if (txn.count >= 3) {
    txn.status = 'success';
    console.log(`[MOCK] Check ${ref} → SUCCESS (attempt ${txn.count})`);
    res.json({
      ReferenceNo: ref,
      Amount: '1.00',
      ExternalRefNo: 'EXT-' + ref,
      ServiceName: 'DUITNOW',
      ResponseCode: '00',
      ResponseMessage: 'Successful'
    });
  } else {
    console.log(`[MOCK] Check ${ref} → PENDING (attempt ${txn.count})`);
    res.json({
      ReferenceNo: ref,
      ResponseCode: '01',
      ResponseMessage: 'Pending'
    });
  }
});

app.post('/mock/Cancellation', (req, res) => {
  console.log(`[MOCK] Cancel transaction: ${req.body.TransactionNo}`);
  delete mockTransactions[req.body.TransactionNo];
  res.json({ ResponseCode: '00', ResponseMessage: '' });
});

// --- Start server and run tests ---

const PORT = 4567;
const server = app.listen(PORT, async () => {
  console.log(`\n=== DuitNow Gateway Test ===\n`);
  console.log(`Mock API running on http://localhost:${PORT}\n`);

  try {
    // 1. Test signature generation
    console.log('--- Test 1: Signature Generation ---');
    const sig = generateSignature('JNC888', '1.00DEMOJCDemo99911111111628625730335674572025-12-17 23:24:34');
    console.log(`Signature: ${sig}`);
    console.log(`Match expected: ${sig === 'cKv9c+9lMX1Hk4Uxlkvhm7r7lLZOg+U0u93X241Jozo=' ? 'PASS' : 'FAIL'}\n`);

    // 2. Test gateway factory
    console.log('--- Test 2: Gateway Factory ---');
    console.log(`Available gateways: ${listGateways().join(', ')}`);

    const gateway = getGateway('duitnow', {
      applicationCode: 'TESTAPP',
      merchantCode: 'TESTMERCHANT',
      secretKey: 'TESTSECRET',
      apiBaseUrl: `http://localhost:${PORT}/mock`
    });
    console.log(`Gateway created: ${gateway.provider} - PASS\n`);

    // 3. Test create transaction
    console.log('--- Test 3: Create Transaction ---');
    const createResult = await gateway.createTransaction({
      amount: 1.00,
      referenceNo: 'REF-001',
      terminalCode: 'TERM-01'
    });
    console.log(`Success: ${createResult.success}`);
    console.log(`Status: ${createResult.status}`);
    console.log(`External Ref: ${createResult.externalRefNo}`);
    console.log(`Provider: ${createResult.provider}`);
    console.log(`Result: ${createResult.success ? 'PASS' : 'FAIL'}\n`);

    // 4. Test check transaction (single check - will be pending)
    console.log('--- Test 4: Check Transaction (single) ---');
    const checkResult = await gateway.checkTransaction({
      referenceNo: 'REF-001',
      terminalCode: 'TERM-01'
    });
    console.log(`Status: ${checkResult.status} (expected: pending)`);
    console.log(`Result: ${checkResult.status === 'pending' ? 'PASS' : 'FAIL'}\n`);

    // 5. Test poll transaction (should go pending → pending → success)
    console.log('--- Test 5: Poll Transaction ---');
    console.log('Polling (3s interval, mock succeeds on 3rd check)...');
    const pollResult = await gateway.pollTransaction(
      { referenceNo: 'REF-001', terminalCode: 'TERM-01' },
      { intervalMs: 1000, maxAttempts: 5 }
    );
    console.log(`Final status: ${pollResult.status}`);
    console.log(`Result: ${pollResult.success ? 'PASS' : 'FAIL'}\n`);

    // 6. Test create + cancel
    console.log('--- Test 6: Cancel Transaction ---');
    await gateway.createTransaction({
      amount: 5.50,
      referenceNo: 'REF-002',
      terminalCode: 'TERM-01'
    });
    const cancelResult = await gateway.cancelTransaction({
      transactionNo: 'EXT-REF-002',
      terminalCode: 'TERM-01'
    });
    console.log(`Cancel success: ${cancelResult.success}`);
    console.log(`Result: ${cancelResult.success ? 'PASS' : 'FAIL'}\n`);

    // 7. Test unknown gateway
    console.log('--- Test 7: Unknown Gateway ---');
    try {
      getGateway('grabpay', {});
      console.log('Result: FAIL (should have thrown)\n');
    } catch (e) {
      console.log(`Error: ${e.message}`);
      console.log('Result: PASS\n');
    }

    console.log('=== All tests complete ===');
  } catch (err) {
    console.error('TEST FAILED:', err.message);
  } finally {
    server.close();
  }
});
