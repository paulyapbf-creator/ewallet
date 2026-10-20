const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const FILE = path.join(DATA_DIR, 'users.json');

function hashPw(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function load() {
  if (!fs.existsSync(FILE)) {
    const defaults = [{ username: 'admin', password: hashPw('admin'), role: 'admin' }];
    fs.writeFileSync(FILE, JSON.stringify(defaults, null, 2));
    console.log('[USERS] Created default admin user (username: admin, password: admin)');
    return defaults;
  }
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { return []; }
}

function save(users) {
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2));
}

function authenticate(username, password) {
  const users = load();
  return users.find(u => u.username === username && u.password === hashPw(password)) || null;
}

function getAll() {
  return load().map(u => ({ username: u.username, role: u.role }));
}

function upsert(username, password, role) {
  const users = load();
  const idx = users.findIndex(u => u.username === username);
  if (idx >= 0) {
    users[idx].role = role;
    if (password) users[idx].password = hashPw(password);
  } else {
    users.push({ username, password: hashPw(password || ''), role });
  }
  save(users);
}

function remove(username) {
  const users = load();
  const admins = users.filter(u => u.role === 'admin');
  const target = users.find(u => u.username === username);
  if (target && target.role === 'admin' && admins.length <= 1) return false;
  const updated = users.filter(u => u.username !== username);
  if (updated.length === users.length) return false;
  save(updated);
  return true;
}

module.exports = { authenticate, getAll, upsert, remove };
