const Database = require('better-sqlite3');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'payments.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_FILE);
    db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        txRunningNo  INTEGER,
        referenceNo  TEXT,
        externalRefNo TEXT,
        amount       REAL,
        gateway      TEXT,
        status       TEXT DEFAULT 'pending',
        terminalCode TEXT,
        method       TEXT,
        createdAt    TEXT,
        completedAt  TEXT
      )
    `);
  }
  return db;
}

function insert(data) {
  const d = getDb();
  return d.prepare(`
    INSERT INTO transactions (txRunningNo, referenceNo, amount, gateway, terminalCode, createdAt)
    VALUES (@txRunningNo, @referenceNo, @amount, @gateway, @terminalCode,
            strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'))
  `).run(data);
}

function updateByRef(referenceNo, updates) {
  const d = getDb();
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  return d.prepare(`UPDATE transactions SET ${fields} WHERE referenceNo = @referenceNo`)
    .run({ referenceNo, ...updates });
}

function query({ limit = 50, offset = 0, gateway = '', status = '', from = '', to = '' } = {}) {
  const d = getDb();
  const where = [];
  const p = { limit, offset };
  if (gateway) { where.push('gateway = @gateway'); p.gateway = gateway; }
  if (status)  { where.push('status = @status');   p.status  = status;  }
  if (from)    { where.push('createdAt >= @from');  p.from    = from;    }
  if (to)      { where.push('createdAt <= @to');    p.to      = to + ' 23:59:59'; }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows  = d.prepare(`SELECT * FROM transactions ${w} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all(p);
  const total = d.prepare(`SELECT COUNT(*) as n FROM transactions ${w}`).get(p).n;
  return { rows, total };
}

function summary() {
  const d = getDb();
  return d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='paid'      THEN 1 ELSE 0 END) as paid,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN status='pending'   THEN 1 ELSE 0 END) as pending,
      ROUND(SUM(CASE WHEN status='paid' THEN amount ELSE 0 END), 2) as totalAmount
    FROM transactions
  `).get();
}

module.exports = { insert, updateByRef, query, summary };
