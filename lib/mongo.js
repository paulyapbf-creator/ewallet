const { MongoClient } = require('mongodb');

let db;

async function connect() {
  if (db) return db;
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db();
  return db;
}

module.exports = { connect };
