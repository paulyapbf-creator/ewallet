const { connect } = require('./mongo');
const crypto = require('crypto');

async function init() {
  const db = await connect();

  await db.collection('transactions').createIndex({ reference_no: 1 });
  await db.collection('transactions').createIndex({ created_at: -1 });

  const count = await db.collection('users').countDocuments();
  if (count === 0) {
    const hash = crypto.createHash('sha256').update('admin').digest('hex');
    await db.collection('users').insertOne({ username: 'admin', password: hash, role: 'admin' });
    console.log('[DB] Created default admin user (username: admin, password: admin)');
  }

  console.log('[DB] Schema ready');
}

module.exports = { init };
