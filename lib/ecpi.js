const net = require('net');

// ECPI Protocol Constants
const STX = 0x02;
const ETX = 0x03;

// Command codes
const CMD = {
  ENABLE_READER: 0x01,
  INIT_SALE: 0x02,
  PROCEED_SALE: 0x03,
  CHECK_STATUS: 0x04,
  VOID: 0x05,
  SETTLEMENT: 0x06
};

// Response codes
const RESP = {
  0x00: 'success',
  0x01: 'pending',
  0x21: 'declined',
  0x30: 'timeout',
  0x40: 'cancelled',
  0x99: 'error'
};

class ECPIClient {
  constructor(options = {}) {
    this.host = options.host || 'localhost';
    this.port = parseInt(options.port) || 5000;
    this.timeout = parseInt(options.timeout) || 60000;
    this.checksumMode = options.checksumMode || 'bcc'; // 'bcc' or 'crc16'
    this.socket = null;
    this.connected = false;
    this.seq = 0;
    this.logs = [];
  }

  // --- Logging ---
  _log(direction, data) {
    const now = new Date();
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const hex = Buffer.isBuffer(data) ? data.toString('hex').toUpperCase().match(/.{1,2}/g).join(' ') : data;
    const entry = `${ts} ${direction} ${hex}`;
    this.logs.push(entry);
    if (this.logs.length > 200) this.logs.shift();
    console.log(`[ECPI] ${entry}`);
    return entry;
  }

  // --- Connection ---
  connect() {
    return new Promise((resolve, reject) => {
      if (this.connected) return resolve({ success: true, message: 'Already connected' });

      const timer = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, 10000);

      this.socket = new net.Socket();

      this.socket.connect(this.port, this.host, () => {
        clearTimeout(timer);
        this.connected = true;
        this.seq = 0;
        this._log('>>', 'CONNECTED');
        resolve({ success: true, message: `Connected to ${this.host}:${this.port}` });
      });

      this.socket.on('error', (err) => {
        clearTimeout(timer);
        this.connected = false;
        this._log('!!', `ERROR: ${err.message}`);
        reject(new Error(`Connection failed: ${err.message}`));
      });

      this.socket.on('close', () => {
        this.connected = false;
        this._log('<<', 'DISCONNECTED');
      });
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    return { success: true, message: 'Disconnected' };
  }

  // --- Sequence number ---
  _nextSeq() {
    this.seq = (this.seq % 0xFF) + 1;
    return this.seq;
  }

  // --- Checksum ---
  calculateBCC(data) {
    let bcc = 0;
    for (const byte of data) {
      bcc ^= byte;
    }
    return Buffer.from([bcc]);
  }

  calculateCRC16(data) {
    let crc = 0xFFFF;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) {
        if (crc & 0x0001) {
          crc = (crc >> 1) ^ 0xA001;
        } else {
          crc >>= 1;
        }
      }
    }
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(crc);
    return buf;
  }

  _checksum(data) {
    return this.checksumMode === 'crc16'
      ? this.calculateCRC16(data)
      : this.calculateBCC(data);
  }

  // --- Build message ---
  buildMessage(cmd, data = Buffer.alloc(0)) {
    const seq = this._nextSeq();
    const payload = Buffer.concat([Buffer.from([seq, cmd]), data]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length);
    const checksumData = Buffer.concat([len, payload]);
    const checksum = this._checksum(checksumData);

    return Buffer.concat([
      Buffer.from([STX]),
      len,
      payload,
      checksum,
      Buffer.from([ETX])
    ]);
  }

  // --- Parse response ---
  parseResponse(buffer) {
    if (!buffer || buffer.length < 5) {
      return { valid: false, error: 'Response too short' };
    }

    if (buffer[0] !== STX || buffer[buffer.length - 1] !== ETX) {
      return { valid: false, error: 'Invalid framing (no STX/ETX)' };
    }

    const len = buffer.readUInt16BE(1);
    const seq = buffer[3];
    const responseCode = buffer[4];
    const data = buffer.slice(5, 3 + len);
    const status = RESP[responseCode] || 'unknown';

    const result = {
      valid: true,
      seq,
      responseCode,
      status,
      data,
      fields: {}
    };

    // Parse data fields if present (TLV-like: field separator 0x1C)
    if (data.length > 0) {
      try {
        const dataStr = data.toString('ascii');
        const parts = dataStr.split('\x1C');
        for (const part of parts) {
          if (part.length >= 2) {
            const tag = part.substring(0, 2);
            const value = part.substring(2);
            switch (tag) {
              case 'AP': result.fields.approvalCode = value; break;
              case 'RN': result.fields.rrn = value; break;
              case 'ST': result.fields.stan = value; break;
              case 'CN': result.fields.cardNumber = value; break;
              case 'CT': result.fields.cardType = value; break;
              case 'AM': result.fields.amount = value; break;
              case 'TI': result.fields.terminalId = value; break;
              case 'MI': result.fields.merchantId = value; break;
              case 'RC': result.fields.responseCode = value; break;
              case 'RM': result.fields.responseMessage = value; break;
              default: result.fields[tag] = value;
            }
          }
        }
      } catch (e) {
        // Data might not be ASCII, keep as raw
      }
    }

    return result;
  }

  // --- Send command and wait for response ---
  sendCommand(cmd, data = Buffer.alloc(0), timeout = null) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        return reject(new Error('Not connected'));
      }

      const cmdTimeout = timeout || this.timeout;
      const message = this.buildMessage(cmd, data);
      this._log('>>', message);

      const timer = setTimeout(() => {
        reject(new Error(`Command timeout after ${cmdTimeout}ms`));
      }, cmdTimeout);

      const onData = (responseBuffer) => {
        clearTimeout(timer);
        this._log('<<', responseBuffer);
        const parsed = this.parseResponse(responseBuffer);
        resolve(parsed);
      };

      this.socket.once('data', onData);
      this.socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Socket error: ${err.message}`));
      });

      this.socket.write(message);
    });
  }

  // --- High-level commands ---
  async enableReader() {
    // Send current datetime as data: YYMMDDHHMMSS
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dt = `${pad(now.getFullYear() % 100)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return this.sendCommand(CMD.ENABLE_READER, Buffer.from(dt, 'ascii'), 10000);
  }

  async initSale() {
    return this.sendCommand(CMD.INIT_SALE, Buffer.alloc(0), 10000);
  }

  async proceedSale(amountCents) {
    // Amount as 12-digit string in cents
    const amtStr = String(amountCents).padStart(12, '0');
    return this.sendCommand(CMD.PROCEED_SALE, Buffer.from(amtStr, 'ascii'), this.timeout);
  }

  async checkStatus() {
    return this.sendCommand(CMD.CHECK_STATUS, Buffer.alloc(0), 10000);
  }

  async void(approvalCode) {
    return this.sendCommand(CMD.VOID, Buffer.from(approvalCode || '', 'ascii'), 30000);
  }

  // --- Full payment flow ---
  async processPayment(amountMYR) {
    const amountCents = Math.round(amountMYR * 100);

    // Step 1: Enable Reader
    const enableResult = await this.enableReader();
    if (enableResult.status !== 'success') {
      return { step: 'enable', ...enableResult };
    }

    // Step 2: Init Sale
    const initResult = await this.initSale();
    if (initResult.status !== 'success') {
      return { step: 'init', ...initResult };
    }

    // Step 3: Proceed Sale (waits for card)
    const saleResult = await this.proceedSale(amountCents);
    return { step: 'sale', ...saleResult };
  }

  getLogs() {
    return [...this.logs];
  }

  clearLogs() {
    this.logs = [];
  }
}

module.exports = { ECPIClient, CMD, RESP, STX, ETX };
