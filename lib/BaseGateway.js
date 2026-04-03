class BaseGateway {
  constructor(config) {
    this.config = config;
    this.provider = 'base';
  }

  async createTransaction(params) {
    throw new Error(`${this.provider}: createTransaction() not implemented`);
  }

  async checkTransaction(params) {
    throw new Error(`${this.provider}: checkTransaction() not implemented`);
  }

  async cancelTransaction(params) {
    throw new Error(`${this.provider}: cancelTransaction() not implemented`);
  }

  verifyCallback(payload) {
    throw new Error(`${this.provider}: verifyCallback() not implemented`);
  }

  normalizeResponse(raw) {
    throw new Error(`${this.provider}: normalizeResponse() not implemented`);
  }

  getTimestamp() {
    // Malaysia time (UTC+8) — required by J&C
    const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
  }
}

module.exports = BaseGateway;
