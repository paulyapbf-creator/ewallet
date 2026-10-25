const { connect } = require('./mongo');

const DEFAULTS = {
  // General
  adminPin: '8888',
  terminalCode: 'POS-01',
  txRunningNo: 1,
  txRunningDate: '',
  activeGateway: 'duitnow',
  activeProfile: '',

  // DuitNow (J&C)
  duitnowEnabled: false,
  duitnowAppCode: '',
  duitnowMerchantCode: '',
  duitnowSecretKey: '',
  duitnowApiUrl: '',

  // AmpersandPay
  ampersandpayEnabled: false,
  ampersandpayMerchantId: '',
  ampersandpayTerminalId: '',
  ampersandpaySecretKey: '',
  ampersandpayApiUrl: '',
  ampersandpayChannel: 'EW',
  ampersandpayScheme: '',
  ampersandpayReturnUrl: '',
  ampersandpayCallbackUrl: '',

  // ECPI (Card Terminal)
  ecpiEnabled: false,
  ecpiHost: '',
  ecpiPort: '5000',
  ecpiTimeout: '60000',
  ecpiChecksumMode: 'bcc'
};

function envOverrides() {
  const o = {};
  if (process.env.DUITNOW_APP_CODE) o.duitnowAppCode = process.env.DUITNOW_APP_CODE;
  if (process.env.DUITNOW_MERCHANT_CODE) o.duitnowMerchantCode = process.env.DUITNOW_MERCHANT_CODE;
  if (process.env.DUITNOW_SECRET_KEY) o.duitnowSecretKey = process.env.DUITNOW_SECRET_KEY;
  if (process.env.DUITNOW_API_URL) o.duitnowApiUrl = process.env.DUITNOW_API_URL;
  if (process.env.DUITNOW_ENABLED) o.duitnowEnabled = process.env.DUITNOW_ENABLED === 'true';
  if (process.env.AMPERSANDPAY_MERCHANT_ID) o.ampersandpayMerchantId = process.env.AMPERSANDPAY_MERCHANT_ID;
  if (process.env.AMPERSANDPAY_TERMINAL_ID) o.ampersandpayTerminalId = process.env.AMPERSANDPAY_TERMINAL_ID;
  if (process.env.AMPERSANDPAY_SECRET_KEY) o.ampersandpaySecretKey = process.env.AMPERSANDPAY_SECRET_KEY;
  if (process.env.AMPERSANDPAY_API_URL) o.ampersandpayApiUrl = process.env.AMPERSANDPAY_API_URL;
  if (process.env.AMPERSANDPAY_ENABLED) o.ampersandpayEnabled = process.env.AMPERSANDPAY_ENABLED === 'true';
  if (process.env.AMPERSANDPAY_CHANNEL) o.ampersandpayChannel = process.env.AMPERSANDPAY_CHANNEL;
  if (process.env.AMPERSANDPAY_CALLBACK_URL) o.ampersandpayCallbackUrl = process.env.AMPERSANDPAY_CALLBACK_URL;
  if (process.env.ECPI_HOST) o.ecpiHost = process.env.ECPI_HOST;
  if (process.env.ECPI_PORT) o.ecpiPort = process.env.ECPI_PORT;
  if (process.env.ECPI_ENABLED) o.ecpiEnabled = process.env.ECPI_ENABLED === 'true';
  if (process.env.ACTIVE_GATEWAY) o.activeGateway = process.env.ACTIVE_GATEWAY;
  if (process.env.ADMIN_PIN) o.adminPin = process.env.ADMIN_PIN;
  if (process.env.TERMINAL_CODE) o.terminalCode = process.env.TERMINAL_CODE;
  return o;
}

async function load() {
  const db = await connect();
  let dbSettings = {};
  try {
    const doc = await db.collection('settings').findOne({ _id: 'main' });
    if (doc) {
      const { _id, ...rest } = doc;
      dbSettings = rest;
    }
  } catch (e) {
    console.error('[SETTINGS] Failed to load:', e.message);
  }
  return { ...DEFAULTS, ...envOverrides(), ...dbSettings };
}

async function save(updates) {
  const db = await connect();
  const current = await load();
  const merged = { ...current, ...updates };
  try {
    await db.collection('settings').updateOne(
      { _id: 'main' },
      { $set: merged },
      { upsert: true }
    );
  } catch (e) {
    console.error('[SETTINGS] Failed to save:', e.message);
  }
  return merged;
}

// --- Profiles ---
async function loadProfiles() {
  const db = await connect();
  try {
    const docs = await db.collection('profiles').find({}).toArray();
    const profiles = {};
    for (const doc of docs) {
      const { _id, ...rest } = doc;
      profiles[_id] = rest;
    }
    return profiles;
  } catch (e) {
    console.error('[PROFILES] Failed to load:', e.message);
    return {};
  }
}

async function saveProfile(name, profileSettings) {
  const db = await connect();
  const { adminPin, activeProfile, ...gatewaySettings } = profileSettings;
  try {
    await db.collection('profiles').updateOne(
      { _id: name },
      { $set: { ...gatewaySettings, savedAt: new Date().toISOString() } },
      { upsert: true }
    );
  } catch (e) {
    console.error('[PROFILES] Failed to save:', e.message);
  }
}

async function loadProfile(name) {
  const db = await connect();
  try {
    const doc = await db.collection('profiles').findOne({ _id: name });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest;
  } catch (e) {
    console.error('[PROFILES] Failed to load profile:', e.message);
    return null;
  }
}

async function deleteProfile(name) {
  const db = await connect();
  try {
    await db.collection('profiles').deleteOne({ _id: name });
  } catch (e) {
    console.error('[PROFILES] Failed to delete:', e.message);
  }
}

async function listProfiles() {
  const profiles = await loadProfiles();
  return Object.keys(profiles).map(name => ({
    name,
    savedAt: profiles[name].savedAt,
    activeGateway: profiles[name].activeGateway,
    hasJC: !!profiles[name].duitnowApiUrl,
    hasAmpersand: !!profiles[name].ampersandpayApiUrl
  }));
}

module.exports = { load, save, DEFAULTS, saveProfile, loadProfile, loadProfiles, deleteProfile, listProfiles };
