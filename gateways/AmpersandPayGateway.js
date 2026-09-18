const crypto = require('crypto');
const BaseGateway = require('../lib/BaseGateway');

const STATUS_MAP = {
  'SUCCESS': 'success',
  'FAILED': 'failed',
  'PENDING': 'pending'
};

class AmpersandPayGateway extends BaseGateway {
  constructor(config) {
    super(config);
    this.provider = 'ampersandpay';

    const required = ['merchantId', 'secretKey', 'apiBaseUrl'];
    for (const key of required) {
      if (!config[key]) throw new Error(`AmpersandPay: missing config "${key}"`);
    }
  }

  // ret can be 0 (mock), "0000" (live), or "0" — all mean success
  _isSuccess(ret) {
    return ret === 0 || ret === '0' || ret === '0000';
  }

  // --- SHA512 signature: SHA512(requestBodyString + secretKey) ---
  _generateSignature(bodyString) {
    const payload = bodyString + this.config.secretKey;
    return crypto.createHash('sha512').update(payload, 'utf8').digest('hex');
  }

  // --- Create Transaction (Checkout) ---
  async createTransaction({ amount, referenceNo, terminalCode, channel, custName, custEmail }) {
    const body = {
      merchantId: this.config.merchantId,
      txType: 'SALE',
      txAmount: parseFloat(amount).toFixed(2),
      txCurrency: 'MYR',
      txChannel: channel || 'EW',
      orderId: referenceNo,
      orderRef: referenceNo,
      custName: custName || 'Customer',
      custEmail: custEmail || ''
    };

    const raw = await this._post('/tx/request', body);
    const ok = this._isSuccess(raw.ret);
    return {
      success: ok,
      status: ok ? 'pending' : 'error',
      referenceNo: referenceNo,
      externalRefNo: raw.txId || '',
      amount: parseFloat(amount),
      provider: this.provider,
      serviceName: channel || 'EW',
      message: raw.msg || '',
      checkoutUrl: raw.checkoutUrl || '',
      qrCode: raw.qrCode || '',
      raw
    };
  }

  // --- Query Transaction ---
  async checkTransaction({ referenceNo, externalRefNo }) {
    const body = {
      merchantId: this.config.merchantId,
      txId: externalRefNo || referenceNo
    };

    const raw = await this._post('/tx/query', body);
    return this.normalizeResponse(raw, { referenceNo });
  }

  // --- Void Transaction ---
  async cancelTransaction({ externalRefNo, amount }) {
    const body = {
      merchantId: this.config.merchantId,
      txId: externalRefNo,
      txAmount: parseFloat(amount).toFixed(2),
      txCurrency: 'MYR'
    };

    const raw = await this._post('/tx/void', body);
    return this.normalizeResponse(raw, { referenceNo: externalRefNo });
  }

  // --- Verify Callback Signature ---
  verifyCallback(payload, receivedSignature) {
    const bodyString = JSON.stringify(payload);
    const expectedSig = this._generateSignature(bodyString);

    if (expectedSig !== receivedSignature) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    return {
      valid: true,
      data: this.normalizeResponse(payload, {
        referenceNo: payload.orderId,
        amount: parseFloat(payload.txAmount)
      })
    };
  }

  // --- Poll (query until final) ---
  async pollTransaction({ referenceNo, externalRefNo }, options = {}) {
    const { intervalMs = 3000, maxAttempts = 20, signal } = options;

    for (let i = 0; i < maxAttempts; i++) {
      if (signal && signal.aborted) throw new Error('AmpersandPay: polling aborted');

      const result = await this.checkTransaction({ referenceNo, externalRefNo });
      if (result.status === 'success' || result.status === 'failed') return result;

      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, intervalMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('AmpersandPay: polling aborted'));
          }, { once: true });
        }
      });
    }

    throw new Error(`AmpersandPay: polling timeout after ${maxAttempts} attempts`);
  }

  // --- Normalize response ---
  normalizeResponse(raw, extra = {}) {
    const txStatus = raw.txStatus || '';
    return {
      success: txStatus === 'SUCCESS',
      status: STATUS_MAP[txStatus] || (this._isSuccess(raw.ret) ? 'pending' : 'error'),
      referenceNo: extra.referenceNo || raw.orderId || '',
      externalRefNo: raw.txId || '',
      amount: parseFloat(raw.txAmount) || extra.amount || 0,
      provider: this.provider,
      serviceName: raw.txChannel || '',
      message: raw.msg || raw.txStatus || '',
      raw
    };
  }

  // --- HTTP helper ---
  async _post(endpoint, body) {
    const url = this.config.apiBaseUrl.replace(/\/+$/, '') + endpoint;
    const bodyString = JSON.stringify(body);
    const signature = this._generateSignature(bodyString);
    const isMock = url.includes('/mock/');

    console.log(`[AmpersandPay] POST ${url}`);
    console.log(`[AmpersandPay] Body: ${bodyString}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'signature': signature
      },
      body: bodyString
    });

    const text = await res.text();
    console.log(`[AmpersandPay] Response ${res.status}: ${text.substring(0, 500)}`);

    if (!res.ok) {
      throw new Error(`AmpersandPay HTTP ${res.status}: ${text.substring(0, 200)}`);
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`AmpersandPay: Invalid response — ${text.substring(0, 200)}`);
    }
  }
}

module.exports = AmpersandPayGateway;
