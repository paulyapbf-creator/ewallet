const { connect } = require('./mongo');
const crypto = require('crypto');

function hashPw(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

async function authenticate(username, password) {
  const db = await connect();
  const user = await db.collection('users').findOne({ username, password: hashPw(password) });
  return user ? { username: user.username, role: user.role } : null;
}

async function getAll() {
  const db = await connect();
  const users = await db.collection('users').find({}, { projection: { username: 1, role: 1 } }).sort({ username: 1 }).toArray();
  return users.map(u => ({ username: u.username, role: u.role }));
}

async function upsert(username, password, role) {
  const db = await connect();
  if (password) {
    await db.collection('users').updateOne(
      { username },
      { $set: { role, password: hashPw(password) } },
      { upsert: true }
    );
  } else {
    const existing = await db.collection('users').findOne({ username });
    if (existing) {
      await db.collection('users').updateOne({ username }, { $set: { role } });
    } else {
      await db.collection('users').insertOne({ username, password: hashPw(''), role });
    }
  }
}

async function remove(username) {
  const db = await connect();
  const [adminCount, target] = await Promise.all([
    db.collection('users').countDocuments({ role: 'admin' }),
    db.collection('users').findOne({ username })
  ]);
  if (!target) return false;
  if (target.role === 'admin' && adminCount <= 1) return false;
  const result = await db.collection('users').deleteOne({ username });
  return result.deletedCount > 0;
}

module.exports = { authenticate, getAll, upsert, remove };
