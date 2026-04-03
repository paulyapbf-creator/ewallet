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
      Amount: amt,
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
    const isMock = url.includes('/mock/');

    console.log(`[DuitNow] POST ${url}`);
    console.log(`[DuitNow] Body:`, JSON.stringify(body));

    let res;
    if (isMock) {
      // Mock server accepts JSON
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } else {
      // J&C ASMX endpoint — try form-encoded first, then JSON
      const formBody = Object.entries(body)
        .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
        .join('&');

      console.log(`[DuitNow] Form body: ${formBody}`);

      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: formBody
      });
    }

    const text = await res.text();
    console.log(`[DuitNow] Response ${res.status}:`, text.substring(0, 500));

    if (!res.ok) {
      throw new Error(`DuitNow HTTP ${res.status}: ${text.substring(0, 200)}`);
    }

    try {
      // Try JSON first
      const parsed = JSON.parse(text);
      // ASMX may wrap in {"d": "..."}
      if (parsed.d) {
        return typeof parsed.d === 'string' ? JSON.parse(parsed.d) : parsed.d;
      }
      return parsed;
    } catch (e) {
      // ASMX may return XML — try to extract JSON from XML
      const jsonMatch = text.match(/<string[^>]*>([\s\S]*?)<\/string>/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[1]);
        } catch (e2) {}
      }
      throw new Error(`DuitNow: Unexpected response — ${text.substring(0, 300)}`);
    }
  }
}

module.exports = DuitNowGateway;
