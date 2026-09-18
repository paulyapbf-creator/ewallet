const BaseGateway = require('../lib/BaseGateway');
const { ECPIClient, RESP } = require('../lib/ecpi');

class ECPIGateway extends BaseGateway {
  constructor(config) {
    super(config);
    this.provider = 'ecpi';

    if (!config.host) throw new Error('ECPI: missing config "host"');

    this.client = new ECPIClient({
      host: config.host,
      port: config.port || 5000,
      timeout: config.timeout || 60000,
      checksumMode: config.checksumMode || 'bcc'
    });
  }

  // --- Connect to terminal ---
  async connect() {
    return this.client.connect();
  }

  // --- Disconnect ---
  disconnect() {
    return this.client.disconnect();
  }

  // --- Create Transaction (full payment flow) ---
  async createTransaction({ amount }) {
    // Ensure connected
    if (!this.client.connected) {
      await this.client.connect();
    }

    const result = await this.client.processPayment(parseFloat(amount));
    return this.normalizeResponse(result, { amount: parseFloat(amount) });
  }

  // --- Check terminal status ---
  async checkTransaction() {
    if (!this.client.connected) {
      return { success: false, status: 'error', message: 'Not connected', provider: this.provider };
    }
    const result = await this.client.checkStatus();
    return this.normalizeResponse(result);
  }

  // --- Void transaction ---
  async cancelTransaction({ approvalCode }) {
    if (!this.client.connected) {
      await this.client.connect();
    }
    const result = await this.client.void(approvalCode);
    return this.normalizeResponse(result);
  }

  // --- No webhook for ECPI ---
  verifyCallback() {
    return { valid: false, reason: 'ECPI does not use webhooks' };
  }

  // --- No polling needed — payment is synchronous ---
  async pollTransaction() {
    return { success: false, status: 'error', message: 'ECPI is synchronous — use createTransaction', provider: this.provider };
  }

  // --- Normalize terminal response ---
  normalizeResponse(raw, extra = {}) {
    const isSuccess = raw.status === 'success' && raw.responseCode === 0x00;
    const fields = raw.fields || {};

    return {
      success: isSuccess,
      status: raw.status || 'error',
      referenceNo: fields.rrn || fields.stan || '',
      externalRefNo: fields.approvalCode || '',
      amount: parseFloat(fields.amount) || extra.amount || 0,
      provider: this.provider,
      serviceName: fields.cardType || 'CARD',
      message: fields.responseMessage || raw.status || '',
      cardNumber: fields.cardNumber || '',
      cardType: fields.cardType || '',
      approvalCode: fields.approvalCode || '',
      rrn: fields.rrn || '',
      stan: fields.stan || '',
      step: raw.step || '',
      raw
    };
  }

  // --- Get connection status ---
  getStatus() {
    return {
      connected: this.client.connected,
      host: this.client.host,
      port: this.client.port,
      checksumMode: this.client.checksumMode
    };
  }

  // --- Get logs ---
  getLogs() {
    return this.client.getLogs();
  }

  clearLogs() {
    this.client.clearLogs();
  }
}

module.exports = ECPIGateway;
