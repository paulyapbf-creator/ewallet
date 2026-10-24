const pool = require('./pool');

function mytNow() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function rowToTx(r) {
  return {
    id:            r.id,
    txRunningNo:   r.tx_running_no,
    referenceNo:   r.reference_no,
    externalRefNo: r.external_ref_no,
    amount:        parseFloat(r.amount),
    gateway:       r.gateway,
    status:        r.status,
    terminalCode:  r.terminal_code,
    cashier:       r.cashier,
    paymentMethod: r.payment_method,
    method:        r.method,
    createdAt:     r.created_at,
    completedAt:   r.completed_at
  };
}

async function insert(data) {
  await pool.query(
    `INSERT INTO transactions
       (tx_running_no, reference_no, amount, gateway, terminal_code, cashier, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [data.txRunningNo || null, data.referenceNo || '', data.amount || 0,
     data.gateway || '', data.terminalCode || '', data.cashier || '', mytNow()]
  );
  console.log(`[DB] insert OK: "${data.referenceNo}"`);
}

async function updateByRef(referenceNo, updates) {
  const colMap = {
    status:        'status',
    externalRefNo: 'external_ref_no',
    method:        'method',
    completedAt:   'completed_at',
    paymentMethod: 'payment_method',
    cashier:       'cashier'
  };
  const setClauses = [];
  const vals = [];
  for (const [k, col] of Object.entries(colMap)) {
    if (k in updates) { vals.push(updates[k]); setClauses.push(`${col} = $${vals.length}`); }
  }
  if (!setClauses.length) return false;
  vals.push(referenceNo);
  const result = await pool.query(
    `UPDATE transactions SET ${setClauses.join(', ')} WHERE reference_no = $${vals.length}`,
    vals
  );
  if (result.rowCount > 0) {
    console.log(`[DB] updateByRef OK: "${referenceNo}" → ${updates.status || '(no status)'}`);
  } else {
    console.warn(`[DB] updateByRef NOT FOUND: "${referenceNo}"`);
  }
  return result.rowCount > 0;
}

async function query({ limit = 50, offset = 0, gateway = '', status = '', from = '', to = '', terminal = '' } = {}) {
  const wheres = [], vals = [];
  if (gateway)  { vals.push(gateway);           wheres.push(`gateway = $${vals.length}`); }
  if (status)   { vals.push(status);            wheres.push(`status = $${vals.length}`); }
  if (from)     { vals.push(from);              wheres.push(`created_at >= $${vals.length}`); }
  if (to)       { vals.push(to + ' 23:59:59');  wheres.push(`created_at <= $${vals.length}`); }
  if (terminal) { vals.push(terminal);          wheres.push(`terminal_code = $${vals.length}`); }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const [dataRes, countRes] = await Promise.all([
    pool.query(`SELECT * FROM transactions ${where} ORDER BY id DESC LIMIT $${vals.length+1} OFFSET $${vals.length+2}`, [...vals, limit, offset]),
    pool.query(`SELECT COUNT(*) FROM transactions ${where}`, vals)
  ]);
  return { rows: dataRes.rows.map(rowToTx), total: parseInt(countRes.rows[0].count) };
}

async function summary({ gateway = '', from = '', to = '', terminal = '' } = {}) {
  const wheres = [], vals = [];
  if (gateway)  { vals.push(gateway);           wheres.push(`gateway = $${vals.length}`); }
  if (from)     { vals.push(from);              wheres.push(`created_at >= $${vals.length}`); }
  if (to)       { vals.push(to + ' 23:59:59');  wheres.push(`created_at <= $${vals.length}`); }
  if (terminal) { vals.push(terminal);          wheres.push(`terminal_code = $${vals.length}`); }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const r = await pool.query(
    `SELECT
       COUNT(*)                                     AS total,
       COUNT(*) FILTER (WHERE status = 'paid')      AS paid,
       COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
       COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS total_amount
     FROM transactions ${where}`, vals
  );
  const row = r.rows[0];
  return {
    total:       parseInt(row.total),
    paid:        parseInt(row.paid),
    cancelled:   parseInt(row.cancelled),
    pending:     parseInt(row.pending),
    totalAmount: parseFloat(row.total_amount)
  };
}

async function byUser({ gateway = '', from = '', to = '', terminal = '', cashier = '' } = {}) {
  const wheres = [], vals = [];
  if (gateway)  { vals.push(gateway);           wheres.push(`gateway = $${vals.length}`); }
  if (from)     { vals.push(from);              wheres.push(`created_at >= $${vals.length}`); }
  if (to)       { vals.push(to + ' 23:59:59');  wheres.push(`created_at <= $${vals.length}`); }
  if (terminal) { vals.push(terminal);          wheres.push(`terminal_code = $${vals.length}`); }
  if (cashier)  { vals.push(cashier);           wheres.push(`cashier = $${vals.length}`); }
  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const r = await pool.query(
    `SELECT
       COALESCE(NULLIF(cashier,''), '(unknown)') AS cashier,
       LEFT(created_at, 10)                       AS date,
       COUNT(*)                                     AS total,
       COUNT(*) FILTER (WHERE status = 'paid')      AS paid,
       COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS total_amount
     FROM transactions ${where}
     GROUP BY cashier, LEFT(created_at, 10)
     ORDER BY date DESC, cashier ASC`, vals
  );
  return {
    rows: r.rows.map(row => ({
      cashier:     row.cashier,
      date:        row.date,
      total:       parseInt(row.total),
      paid:        parseInt(row.paid),
      cancelled:   parseInt(row.cancelled),
      totalAmount: parseFloat(row.total_amount)
    }))
  };
}

async function getCashiers() {
  const r = await pool.query(
    `SELECT DISTINCT cashier FROM transactions WHERE cashier IS NOT NULL AND cashier <> '' ORDER BY cashier`
  );
  return r.rows.map(r => r.cashier);
}

module.exports = { insert, updateByRef, query, summary, byUser, getCashiers, mytNow };
