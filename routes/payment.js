const express = require('express');
const { getGateway, listGateways } = require('../index');

/**
 * Create payment router.
 * @param {object} store - Data store with getSettings() method
 * @param {object} options
 * @param {function} options.onPaymentUpdate - Called when webhook confirms payment: (result) => {}
 * @returns {express.Router}
 */
function createPaymentRouter(store, options = {}) {
  const router = express.Router();
  const { onPaymentUpdate } = options;

  // Idempotency: track processed ExternalRefNos to avoid duplicate processing
  const processedCallbacks = new Set();

  // Helper: build gateway config from settings for a given provider
  function getGatewayConfig(settings, provider) {
    if (provider === 'duitnow') {
      return {
        applicationCode: settings.duitnowApplicationCode,
        merchantCode: settings.duitnowMerchantCode,
        secretKey: settings.duitnowSecretKey,
        apiBaseUrl: settings.duitnowApiBaseUrl
      };
    }
    throw new Error(`No config mapping for provider: ${provider}`);
  }

  // List available gateways
  router.get('/api/payment/gateways', (req, res) => {
    res.json({ gateways: listGateways() });
  });

  // Create transaction
  router.post('/api/payment/:provider/create', async (req, res) => {
    try {
      const settings = await store.getSettings();
      const config = getGatewayConfig(settings, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      const { amount, referenceNo, terminalCode } = req.body;
      const result = await gateway.createTransaction({ amount, referenceNo, terminalCode });
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, status: 'error', message: err.message });
    }
  });

  // Check transaction status
  router.post('/api/payment/:provider/check', async (req, res) => {
    try {
      const settings = await store.getSettings();
      const config = getGatewayConfig(settings, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      const { referenceNo, terminalCode } = req.body;
      const result = await gateway.checkTransaction({ referenceNo, terminalCode });
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, status: 'error', message: err.message });
    }
  });

  // Poll transaction until final status (fallback when no webhook)
  router.post('/api/payment/:provider/poll', async (req, res) => {
    try {
      const settings = await store.getSettings();
      const config = getGatewayConfig(settings, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      const { referenceNo, terminalCode, intervalMs, maxAttempts } = req.body;

      const result = await gateway.pollTransaction(
        { referenceNo, terminalCode },
        { intervalMs, maxAttempts }
      );
      res.json(result);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ success: false, status: 'error', message: err.message });
      }
    }
  });

  // Cancel transaction
  router.post('/api/payment/:provider/cancel', async (req, res) => {
    try {
      const settings = await store.getSettings();
      const config = getGatewayConfig(settings, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      const { transactionNo, terminalCode } = req.body;
      const result = await gateway.cancelTransaction({ transactionNo, terminalCode });
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, status: 'error', message: err.message });
    }
  });

  // ============================================================
  // WEBHOOK: J&C calls this when payment status changes
  // ============================================================
  router.post('/api/payment/:provider/callback', async (req, res) => {
    try {
      const settings = await store.getSettings();
      const config = getGatewayConfig(settings, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      // 1. Verify signature
      const verification = gateway.verifyCallback(req.body);
      if (!verification.valid) {
        console.log(`[WEBHOOK] Signature failed: ${verification.reason}`);
        return res.json({ ResponseCode: '99', ResponseMessage: verification.reason });
      }

      // 2. Idempotency check — skip if already processed
      const extRef = req.body.ExternalRefNo;
      if (processedCallbacks.has(extRef)) {
        console.log(`[WEBHOOK] Duplicate ignored: ${extRef}`);
        return res.json({ ResponseCode: '00', ResponseMessage: 'Received' });
      }
      processedCallbacks.add(extRef);

      // 3. Notify POS via callback
      const result = verification.data;
      console.log(`[WEBHOOK] ${result.referenceNo} → ${result.status} (${extRef})`);

      if (onPaymentUpdate) {
        onPaymentUpdate(result);
      }

      // 4. Acknowledge to J&C
      res.json({ ResponseCode: '00', ResponseMessage: 'Received' });
    } catch (err) {
      console.error('[WEBHOOK] Error:', err.message);
      res.json({ ResponseCode: '99', ResponseMessage: 'Internal error' });
    }
  });

  return router;
}

module.exports = createPaymentRouter;
