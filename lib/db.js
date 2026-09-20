// Pure JS JSON-based transaction store — no native modules, works everywhere
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.RAILWAY_PUBLIC_DOMAIN
  ? '/tmp/transactions.json'
  : path.join(__dirname, '..', 'transactions.json');

function load() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return { transactions: [], nextId: 1 };
}

function save(store) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(store), 'utf8'); }
  catch(e) { console.error('[DB] save failed:', e.message); }
}

function mytNow() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function insert(data) {
  const store = load();
  store.transactions.push({
    id: store.nextId++,
    txRunningNo: data.txRunningNo || null,
    referenceNo: data.referenceNo || '',
    externalRefNo: '',
    amount: data.amount || 0,
    gateway: data.gateway || '',
    status: 'pending',
    terminalCode: data.terminalCode || '',
    method: '',
    createdAt: mytNow(),
    completedAt: ''
  });
  save(store);
}

function updateByRef(referenceNo, updates) {
  const store = load();
  const tx = store.transactions.find(t => t.referenceNo === referenceNo);
  if (tx) Object.assign(tx, updates);
  save(store);
}

function query({ limit = 50, offset = 0, gateway = '', status = '', from = '', to = '' } = {}) {
  const store = load();
  let rows = [...store.transactions].reverse();
  if (gateway) rows = rows.filter(t => t.gateway === gateway);
  if (status)  rows = rows.filter(t => t.status  === status);
  if (from)    rows = rows.filter(t => t.createdAt >= from);
  if (to)      rows = rows.filter(t => t.createdAt <= to + ' 23:59:59');
  const total = rows.length;
  return { rows: rows.slice(offset, offset + limit), total };
}

function summary() {
  const { transactions: txs } = load();
  return {
    total:       txs.length,
    paid:        txs.filter(t => t.status === 'paid').length,
    cancelled:   txs.filter(t => t.status === 'cancelled').length,
    pending:     txs.filter(t => t.status === 'pending').length,
    totalAmount: Math.round(txs.filter(t => t.status === 'paid').reduce((s, t) => s + (t.amount || 0), 0) * 100) / 100
  };
}

module.exports = { insert, updateByRef, query, summary };
