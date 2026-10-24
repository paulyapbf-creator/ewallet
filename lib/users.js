const pool = require('./pool');
const crypto = require('crypto');

function hashPw(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

async function authenticate(username, password) {
  const r = await pool.query(
    'SELECT * FROM users WHERE username = $1 AND password = $2',
    [username, hashPw(password)]
  );
  return r.rows[0] || null;
}

async function getAll() {
  const r = await pool.query('SELECT username, role FROM users ORDER BY username');
  return r.rows;
}

async function upsert(username, password, role) {
  if (password) {
    await pool.query(
      `INSERT INTO users (username, password, role) VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, password = EXCLUDED.password`,
      [username, hashPw(password), role]
    );
  } else {
    await pool.query(
      `INSERT INTO users (username, password, role) VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role`,
      [username, hashPw(''), role]
    );
  }
}

async function remove(username) {
  const [adminsRes, targetRes] = await Promise.all([
    pool.query("SELECT COUNT(*) FROM users WHERE role = 'admin'"),
    pool.query('SELECT role FROM users WHERE username = $1', [username])
  ]);
  if (!targetRes.rows.length) return false;
  if (targetRes.rows[0].role === 'admin' && parseInt(adminsRes.rows[0].count) <= 1) return false;
  const result = await pool.query('DELETE FROM users WHERE username = $1', [username]);
  return result.rowCount > 0;
}

module.exports = { authenticate, getAll, upsert, remove };
