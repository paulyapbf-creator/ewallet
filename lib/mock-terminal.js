const net = require('net');
const { STX, ETX, CMD } = require('./ecpi');

class MockTerminal {
  constructor(port = 5001) {
    this.port = port;
    this.server = null;
    this.scenario = 'success'; // 'success', 'declined', 'timeout'
  }

  start() {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        console.log(`[MOCK TERMINAL] Client connected`);

        socket.on('data', (data) => {
          console.log(`[MOCK TERMINAL] Received: ${data.toString('hex').toUpperCase()}`);
          this._handleCommand(socket, data);
        });

        socket.on('close', () => {
          console.log(`[MOCK TERMINAL] Client disconnected`);
        });

        socket.on('error', (err) => {
          console.log(`[MOCK TERMINAL] Socket error: ${err.message}`);
        });
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[MOCK TERMINAL] Listening on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  _handleCommand(socket, data) {
    if (data[0] !== STX || data[data.length - 1] !== ETX) {
      console.log(`[MOCK TERMINAL] Invalid framing`);
      return;
    }

    const seq = data[3];
    const cmd = data[4];

    switch (cmd) {
      case CMD.ENABLE_READER:
        console.log(`[MOCK TERMINAL] Enable Reader`);
        this._sendResponse(socket, seq, 0x00);
        break;

      case CMD.INIT_SALE:
        console.log(`[MOCK TERMINAL] Init Sale`);
        this._sendResponse(socket, seq, 0x00);
        break;

      case CMD.PROCEED_SALE:
        const amountData = data.slice(5, data.length - 2); // strip checksum + ETX
        const amountStr = amountData.toString('ascii').replace(/\0/g, '');
        const amountMYR = (parseInt(amountStr) / 100).toFixed(2);
        console.log(`[MOCK TERMINAL] Proceed Sale: RM${amountMYR}`);

        // Simulate card processing delay
        setTimeout(() => {
          if (this.scenario === 'declined') {
            this._sendResponse(socket, seq, 0x21, this._buildDeclineData());
          } else if (this.scenario === 'timeout') {
            // Don't respond — simulate timeout
            console.log(`[MOCK TERMINAL] Simulating timeout (no response)`);
          } else {
            this._sendResponse(socket, seq, 0x00, this._buildApprovalData(amountMYR));
          }
        }, 3000); // 3 second delay to simulate card tap
        break;

      case CMD.CHECK_STATUS:
        console.log(`[MOCK TERMINAL] Check Status`);
        this._sendResponse(socket, seq, 0x00);
        break;

      case CMD.VOID:
        console.log(`[MOCK TERMINAL] Void`);
        setTimeout(() => {
          this._sendResponse(socket, seq, 0x00);
        }, 1000);
        break;

      default:
        console.log(`[MOCK TERMINAL] Unknown command: 0x${cmd.toString(16)}`);
        this._sendResponse(socket, seq, 0x99);
    }
  }

  _buildApprovalData(amount) {
    const fields = [
      'AP' + String(Math.floor(Math.random() * 999999)).padStart(6, '0'),
      'RN' + String(Math.floor(Math.random() * 999999999999)).padStart(12, '0'),
      'ST' + String(Math.floor(Math.random() * 999999)).padStart(6, '0'),
      'CN' + '****-****-****-' + String(Math.floor(Math.random() * 9999)).padStart(4, '0'),
      'CT' + ['VISA', 'MASTERCARD', 'AMEX'][Math.floor(Math.random() * 3)],
      'AM' + amount,
      'RC' + '00',
      'RM' + 'APPROVED'
    ];
    return Buffer.from(fields.join('\x1C'), 'ascii');
  }

  _buildDeclineData() {
    const fields = [
      'RC' + '21',
      'RM' + 'DECLINED - INSUFFICIENT FUNDS'
    ];
    return Buffer.from(fields.join('\x1C'), 'ascii');
  }

  _sendResponse(socket, seq, responseCode, data = Buffer.alloc(0)) {
    const payload = Buffer.concat([Buffer.from([seq, responseCode]), data]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length);

    // BCC checksum
    const checksumData = Buffer.concat([len, payload]);
    let bcc = 0;
    for (const byte of checksumData) bcc ^= byte;

    const response = Buffer.concat([
      Buffer.from([STX]),
      len,
      payload,
      Buffer.from([bcc]),
      Buffer.from([ETX])
    ]);

    console.log(`[MOCK TERMINAL] Sending: ${response.toString('hex').toUpperCase()}`);
    try {
      socket.write(response);
    } catch (e) {
      console.log(`[MOCK TERMINAL] Send failed: ${e.message}`);
    }
  }

  setScenario(scenario) {
    this.scenario = scenario;
    console.log(`[MOCK TERMINAL] Scenario: ${scenario}`);
  }
}

module.exports = { MockTerminal };
