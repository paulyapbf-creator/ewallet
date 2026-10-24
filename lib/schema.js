const pool = require('./pool');
const crypto = require('crypto');

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      tx_running_no INTEGER,
      reference_no TEXT NOT NULL DEFAULT '',
      external_ref_no TEXT DEFAULT '',
      amount NUMERIC(10,2) DEFAULT 0,
      gateway TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      terminal_code TEXT DEFAULT '',
      cashier TEXT DEFAULT '',
      payment_method TEXT DEFAULT '',
      method TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      completed_at TEXT DEFAULT ''
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier'
    )
  `);

  // Seed default admin if no users exist
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) === 0) {
    const hash = crypto.createHash('sha256').update('admin').digest('hex');
    await pool.query(
      'INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
      ['admin', hash, 'admin']
    );
    console.log('[DB] Created default admin user (username: admin, password: admin)');
  }

  console.log('[DB] Schema ready');
}

module.exports = { init };
