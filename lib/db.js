const { connect } = require('./mongo');

function mytNow() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function docToTx(r) {
  return {
    id:            r._id ? r._id.toString() : null,
    txRunningNo:   r.tx_running_no,
    referenceNo:   r.reference_no,
    externalRefNo: r.external_ref_no,
    amount:        parseFloat(r.amount || 0),
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
  const db = await connect();
  await db.collection('transactions').insertOne({
    tx_running_no:   data.txRunningNo || null,
    reference_no:    data.referenceNo || '',
    external_ref_no: '',
    amount:          data.amount || 0,
    gateway:         data.gateway || '',
    status:          'pending',
    terminal_code:   data.terminalCode || '',
    cashier:         data.cashier || '',
    payment_method:  '',
    method:          '',
    created_at:      mytNow(),
    completed_at:    ''
  });
  console.log(`[DB] insert OK: "${data.referenceNo}"`);
}

async function updateByRef(referenceNo, updates) {
  const db = await connect();
  const fieldMap = {
    status:        'status',
    externalRefNo: 'external_ref_no',
    method:        'method',
    completedAt:   'completed_at',
    paymentMethod: 'payment_method',
    cashier:       'cashier'
  };
  const set = {};
  for (const [k, col] of Object.entries(fieldMap)) {
    if (k in updates) set[col] = updates[k];
  }
  if (!Object.keys(set).length) return false;
  const result = await db.collection('transactions').updateOne(
    { reference_no: referenceNo },
    { $set: set }
  );
  if (result.matchedCount > 0) {
    console.log(`[DB] updateByRef OK: "${referenceNo}" → ${updates.status || '(no status)'}`);
  } else {
    console.warn(`[DB] updateByRef NOT FOUND: "${referenceNo}"`);
  }
  return result.matchedCount > 0;
}

async function query({ limit = 50, offset = 0, gateway = '', status = '', from = '', to = '', terminal = '' } = {}) {
  const db = await connect();
  const filter = {};
  if (gateway)  filter.gateway = gateway;
  if (status)   filter.status = status;
  if (terminal) filter.terminal_code = terminal;
  if (from || to) {
    filter.created_at = {};
    if (from) filter.created_at.$gte = from;
    if (to)   filter.created_at.$lte = to + ' 23:59:59';
  }
  const [rows, total] = await Promise.all([
    db.collection('transactions').find(filter).sort({ _id: -1 }).skip(offset).limit(limit).toArray(),
    db.collection('transactions').countDocuments(filter)
  ]);
  return { rows: rows.map(docToTx), total };
}

async function summary({ gateway = '', from = '', to = '', terminal = '' } = {}) {
  const db = await connect();
  const filter = {};
  if (gateway)  filter.gateway = gateway;
  if (terminal) filter.terminal_code = terminal;
  if (from || to) {
    filter.created_at = {};
    if (from) filter.created_at.$gte = from;
    if (to)   filter.created_at.$lte = to + ' 23:59:59';
  }
  const pipeline = [
    { $match: filter },
    { $group: {
      _id: null,
      total:       { $sum: 1 },
      paid:        { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
      cancelled:   { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
      pending:     { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
      totalAmount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } }
    }}
  ];
  const result = await db.collection('transactions').aggregate(pipeline).toArray();
  if (!result.length) return { total: 0, paid: 0, cancelled: 0, pending: 0, totalAmount: 0 };
  const r = result[0];
  return {
    total:       r.total,
    paid:        r.paid,
    cancelled:   r.cancelled,
    pending:     r.pending,
    totalAmount: parseFloat(r.totalAmount)
  };
}

async function byUser({ gateway = '', from = '', to = '', terminal = '', cashier = '' } = {}) {
  const db = await connect();
  const filter = {};
  if (gateway)  filter.gateway = gateway;
  if (terminal) filter.terminal_code = terminal;
  if (cashier)  filter.cashier = cashier;
  if (from || to) {
    filter.created_at = {};
    if (from) filter.created_at.$gte = from;
    if (to)   filter.created_at.$lte = to + ' 23:59:59';
  }
  const pipeline = [
    { $match: filter },
    { $group: {
      _id: {
        cashier: { $cond: [{ $and: [{ $ne: ['$cashier', null] }, { $ne: ['$cashier', ''] }] }, '$cashier', '(unknown)'] },
        date:    { $substr: ['$created_at', 0, 10] }
      },
      total:       { $sum: 1 },
      paid:        { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
      cancelled:   { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
      totalAmount: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } }
    }},
    { $sort: { '_id.date': -1, '_id.cashier': 1 } }
  ];
  const rows = await db.collection('transactions').aggregate(pipeline).toArray();
  return {
    rows: rows.map(r => ({
      cashier:     r._id.cashier,
      date:        r._id.date,
      total:       r.total,
      paid:        r.paid,
      cancelled:   r.cancelled,
      totalAmount: parseFloat(r.totalAmount)
    }))
  };
}

async function getCashiers() {
  const db = await connect();
  const result = await db.collection('transactions').distinct('cashier', { cashier: { $nin: [null, ''] } });
  return result.sort();
}

module.exports = { insert, updateByRef, query, summary, byUser, getCashiers, mytNow };
