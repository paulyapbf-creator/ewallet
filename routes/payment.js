const express = require('express');
const { getGateway, listGateways } = require('../index');
const settings = require('../lib/settings');

/**
 * Create payment router.
 * @param {object} store - Data store with getSettings() method (used as fallback if no tenantId)
 * @param {object} options
 * @param {function} options.onPaymentUpdate - Called when webhook confirms payment: (result) => {}
 * @returns {express.Router}
 */
function createPaymentRouter(store, options = {}) {
  const router = express.Router();
  const { onPaymentUpdate, onTransactionCreate, onTransactionCancel, onTransactionPaid } = options;

  // Idempotency: track processed ExternalRefNos to avoid duplicate processing
  const processedCallbacks = new Set();

  // Helper: build gateway config from settings for a given provider
  function getGatewayConfig(s, provider) {
    if (provider === 'duitnow') {
      return {
        applicationCode: s.duitnowApplicationCode || s.duitnowAppCode,
        merchantCode: s.duitnowMerchantCode,
        secretKey: s.duitnowSecretKey,
        apiBaseUrl: s.duitnowApiBaseUrl || s.duitnowApiUrl
      };
    }
    if (provider === 'ampersandpay') {
      return {
        merchantId: s.ampersandpayMerchantId,
        secretKey: s.ampersandpaySecretKey,
        apiBaseUrl: s.ampersandpayApiUrl
      };
    }
    if (provider === 'ecpi') {
      return {
        host: s.ecpiHost,
        port: s.ecpiPort,
        timeout: s.ecpiTimeout,
        checksumMode: s.ecpiChecksumMode
      };
    }
    throw new Error(`No config mapping for provider: ${provider}`);
  }

  // Load settings based on tenantId (if provided) or fall back to global store
  async function loadTenantSettings(tenantId) {
    if (tenantId) {
      const profile = settings.loadProfile(tenantId);
      if (!profile) {
        throw new Error(`Tenant profile not found: ${tenantId}`);
      }
      return profile;
    }
    // No tenant specified → use global active settings
    return await store.getSettings();
  }

  // List available gateways
  router.get('/api/payment/gateways', (req, res) => {
    res.json({ gateways: listGateways() });
  });

  // List available tenants (profiles)
  router.get('/api/payment/tenants', (req, res) => {
    res.json({ tenants: settings.listProfiles() });
  });

  // Create transaction
  router.post('/api/payment/:provider/create', async (req, res) => {
    try {
      const { tenantId, amount, referenceNo, terminalCode, txRunningNo } = req.body;
      const s = await loadTenantSettings(tenantId);
      const config = getGatewayConfig(s, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      // Use tenant's terminalCode if not provided in request
      const termCode = terminalCode || s.terminalCode;
      const result = await gateway.createTransaction({ amount, referenceNo, terminalCode: termCode });

      // Save to DB
      if (onTransactionCreate) {
        onTransactionCreate({ txRunningNo: txRunningNo || null, referenceNo, amount: parseFloat(amount), gateway: req.params.provider, terminalCode: termCode });
      }

      res.json({ ...result, tenantId: tenantId || null });
    } catch (err) {
      res.status(500).json({ success: false, status: 'error', message: err.message });
    }
  });

  // Check transaction status
  router.post('/api/payment/:provider/check', async (req, res) => {
    try {
      const { tenantId, referenceNo, terminalCode } = req.body;
      const s = await loadTenantSettings(tenantId);
      const config = getGatewayConfig(s, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      const termCode = terminalCode || s.terminalCode;
      const result = await gateway.checkTransaction({ referenceNo, terminalCode: termCode });
      res.json({ ...result, tenantId: tenantId || null });
    } catch (err) {
      res.status(500).json({ success: false, status: 'error', message: err.message });
    }
  });

  // Poll transaction until final status
  router.post('/api/payment/:provider/poll', async (req, res) => {
    try {
      const { tenantId, referenceNo, terminalCode, intervalMs, maxAttempts } = req.body;
      const s = await loadTenantSettings(tenantId);
      const config = getGatewayConfig(s, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      const termCode = terminalCode || s.terminalCode;
      const result = await gateway.pollTransaction(
        { referenceNo, terminalCode: termCode },
        { intervalMs, maxAttempts }
      );

      console.log(`[POLL] result: success=${result.success} status=${result.status} ref="${referenceNo}" cb=${typeof onTransactionPaid}`);
      if (result.success && typeof onTransactionPaid === 'function') {
        console.log(`[POLL] calling onTransactionPaid...`);
        try { onTransactionPaid({ ...result, referenceNo }); } catch(e) { console.error('[POLL] db update error:', e.message); }
        console.log(`[POLL] onTransactionPaid done`);
      } else if (result.success) {
        console.log(`[POLL] WARNING: onTransactionPaid is ${typeof onTransactionPaid} — DB not updated!`);
      } else {
        console.log(`[POLL] not paid — final status: ${result.status}`);
      }

      res.json({ ...result, tenantId: tenantId || null });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ success: false, status: 'error', message: err.message });
      }
    }
  });

  // Cancel transaction
  router.post('/api/payment/:provider/cancel', async (req, res) => {
    try {
      const { tenantId, transactionNo, terminalCode, referenceNo } = req.body;
      const s = await loadTenantSettings(tenantId);
      const config = getGatewayConfig(s, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      const termCode = terminalCode || s.terminalCode;
      const result = await gateway.cancelTransaction({ transactionNo, terminalCode: termCode });

      if (onTransactionCancel && referenceNo) onTransactionCancel(referenceNo);

      res.json({ ...result, tenantId: tenantId || null });
    } catch (err) {
      res.status(500).json({ success: false, status: 'error', message: err.message });
    }
  });

  // ============================================================
  // WEBHOOK: provider calls this when payment status changes
  // ============================================================
  router.post('/api/payment/:provider/callback', async (req, res) => {
    try {
      // For webhooks: we don't know the tenant upfront, try to match by MerchantCode
      const merchantCode = req.body.MerchantCode;
      const profiles = settings.listProfiles();
      let tenantId = null;
      let tenantSettings = null;

      // Find tenant by merchant code
      for (const p of profiles) {
        const profile = settings.loadProfile(p.name);
        if (profile && profile.duitnowMerchantCode === merchantCode) {
          tenantId = p.name;
          tenantSettings = profile;
          break;
        }
      }

      // Fallback to global settings if no match
      if (!tenantSettings) {
        tenantSettings = await store.getSettings();
      }

      const config = getGatewayConfig(tenantSettings, req.params.provider);
      const gateway = getGateway(req.params.provider, config);

      // 1. Verify signature
      const verification = gateway.verifyCallback(req.body);
      if (!verification.valid) {
        console.log(`[WEBHOOK] Signature failed: ${verification.reason}`);
        return res.json({ ResponseCode: '99', ResponseMessage: verification.reason });
      }

      // 2. Idempotency check
      const extRef = req.body.ExternalRefNo;
      if (processedCallbacks.has(extRef)) {
        console.log(`[WEBHOOK] Duplicate ignored: ${extRef}`);
        return res.json({ ResponseCode: '00', ResponseMessage: 'Received' });
      }
      processedCallbacks.add(extRef);

      // 3. Notify POS via callback with tenant info
      const result = { ...verification.data, tenantId };
      console.log(`[WEBHOOK] ${result.referenceNo} → ${result.status} (tenant: ${tenantId || 'default'})`);

      if (onPaymentUpdate) {
        onPaymentUpdate(result);
      }

      // 4. Acknowledge to provider
      res.json({ ResponseCode: '00', ResponseMessage: 'Received' });
    } catch (err) {
      console.error('[WEBHOOK] Error:', err.message);
      res.json({ ResponseCode: '99', ResponseMessage: 'Internal error' });
    }
  });

  return router;
}

module.exports = createPaymentRouter;
