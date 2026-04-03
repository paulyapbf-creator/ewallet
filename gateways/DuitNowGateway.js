const BaseGateway = require('../lib/BaseGateway');
const { generateSignature } = require('../lib/signature');

const RESPONSE_CODES = {
  '00': 'success',
  '01': 'pending',
  '05': 'failed',
  '07': 'refunded',
  '99': 'error'
};

const FINAL_CODES = ['00', '05', '07', '99'];

class DuitNowGateway extends BaseGateway {
  constructor(config) {
    super(config);
    this.provider = 'duitnow';

    const required = ['applicationCode', 'merchantCode', 'secretKey', 'apiBaseUrl'];
    for (const key of required) {
      if (!config[key]) throw new Error(`DuitNow: missing config "${key}"`);
    }
  }

  // --- Transaction API (Create Payment) ---
  async createTransaction({ amount, referenceNo, terminalCode }) {
    const timestamp = this.getTimestamp();
    const amt = parseFloat(amount).toFixed(2);

    // Signature order: Amount + ApplicationCode + MerchantCode + ReferenceNo + TerminalCode + Timestamp
    const signature = generateSignature(
      this.config.secretKey,
      amt, this.config.applicationCode, this.config.merchantCode,
      referenceNo, terminalCode, timestamp
    );

    const body = {
      Amount: parseFloat(amt),
      ApplicationCode: this.config.applicationCode,
      MerchantCode: this.config.merchantCode,
      ReferenceNo: referenceNo,
      TerminalCode: terminalCode,
      Timestamp: timestamp,
      Signature: signature
    };

    const raw = await this._post('/Transaction', body);
    return this.normalizeResponse(raw, { referenceNo, amount: parseFloat(amt) });
  }

  // --- Check Transaction API ---
  async checkTransaction({ referenceNo, terminalCode }) {
    const timestamp = this.getTimestamp();

    // Signature order: ApplicationCode + MerchantCode + ReferenceNo + TerminalCode + Timestamp
    const signature = generateSignature(
      this.config.secretKey,
      this.config.applicationCode, this.config.merchantCode,
      referenceNo, terminalCode, timestamp
    );

    const body = {
      ApplicationCode: this.config.applicationCode,
      MerchantCode: this.config.merchantCode,
      ReferenceNo: referenceNo,
      TerminalCode: terminalCode,
      Timestamp: timestamp,
      Signature: signature
    };

    const raw = await this._post('/CheckQRTransaction', body);
    return this.normalizeResponse(raw, { referenceNo });
  }

  // --- Cancel Transaction API ---
  async cancelTransaction({ transactionNo, terminalCode }) {
    const timestamp = this.getTimestamp();

    // Signature order: ApplicationCode + MerchantCode + TerminalCode + Timestamp + TransactionNo
    const signature = generateSignature(
      this.config.secretKey,
      this.config.applicationCode, this.config.merchantCode,
      terminalCode, timestamp, transactionNo
    );

    const body = {
      ApplicationCode: this.config.applicationCode,
      MerchantCode: this.config.merchantCode,
      TransactionNo: transactionNo,
      TerminalCode: terminalCode,
      Timestamp: timestamp,
      Signature: signature
    };

    const raw = await this._post('/Cancellation', body);
    return this.normalizeResponse(raw, { referenceNo: transactionNo });
  }

  // --- Verify Callback Signature from J&C ---
  verifyCallback(payload) {
    const receivedSig = payload.Signature;
    if (!receivedSig) return { valid: false, reason: 'Missing Signature' };

    // Sort fields A-Z (exclude Signature), concatenate values
    const fields = Object.keys(payload)
      .filter(k => k !== 'Signature')
      .sort();
    const combinationString = fields.map(k => String(payload[k])).join('');

    const expectedSig = generateSignature(this.config.secretKey, combinationString);

    if (expectedSig !== receivedSig) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    return {
      valid: true,
      data: this.normalizeResponse(payload, {
        referenceNo: payload.ReferenceNo,
        amount: parseFloat(payload.Amount)
      })
    };
  }

  // --- Poll until final status (fallback if no webhook) ---
  async pollTransaction({ referenceNo, terminalCode }, options = {}) {
    const { intervalMs = 3000, maxAttempts = 20, signal } = options;

    for (let i = 0; i < maxAttempts; i++) {
      if (signal && signal.aborted) {
        throw new Error('DuitNow: polling aborted');
      }

      const result = await this.checkTransaction({ referenceNo, terminalCode });

      if (FINAL_CODES.includes(result.raw.ResponseCode)) {
        return result;
      }

      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, intervalMs);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('DuitNow: polling aborted'));
          }, { once: true });
        }
      });
    }

    throw new Error(`DuitNow: polling timeout after ${maxAttempts} attempts for ${referenceNo}`);
  }

  // --- Normalize to standard response ---
  normalizeResponse(raw, extra = {}) {
    const code = raw.ResponseCode || '';
    return {
      success: code === '00',
      status: RESPONSE_CODES[code] || 'error',
      referenceNo: extra.referenceNo || raw.ReferenceNo || '',
      externalRefNo: raw.ExternalRefNo || '',
      amount: parseFloat(raw.Amount) || extra.amount || 0,
      provider: this.provider,
      serviceName: raw.ServiceName || '',
      message: raw.ResponseMessage || '',
      raw
    };
  }

  // --- Internal HTTP helper ---
  async _post(endpoint, body) {
    const url = this.config.apiBaseUrl.replace(/\/+$/, '') + endpoint;

    console.log(`[DuitNow] POST ${url}`);
    console.log(`[DuitNow] Body:`, JSON.stringify(body));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    console.log(`[DuitNow] Response ${res.status}:`, text);

    if (!res.ok) {
      throw new Error(`DuitNow HTTP ${res.status}: ${text.substring(0, 200)}`);
    }

    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`DuitNow: Invalid response format — ${text.substring(0, 200)}`);
    }
  }
}

module.exports = DuitNowGateway;
