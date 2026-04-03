const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');

const DEFAULTS = {
  duitnowAppCode: '',
  duitnowMerchantCode: '',
  duitnowSecretKey: '',
  duitnowApiUrl: '',
  duitnowEnabled: false,
  adminPin: '8888',
  terminalCode: 'POS-01'
};

// Environment variables override file settings (survives Railway redeploys)
function envOverrides() {
  const overrides = {};
  if (process.env.DUITNOW_APP_CODE) overrides.duitnowAppCode = process.env.DUITNOW_APP_CODE;
  if (process.env.DUITNOW_MERCHANT_CODE) overrides.duitnowMerchantCode = process.env.DUITNOW_MERCHANT_CODE;
  if (process.env.DUITNOW_SECRET_KEY) overrides.duitnowSecretKey = process.env.DUITNOW_SECRET_KEY;
  if (process.env.DUITNOW_API_URL) overrides.duitnowApiUrl = process.env.DUITNOW_API_URL;
  if (process.env.DUITNOW_ENABLED) overrides.duitnowEnabled = process.env.DUITNOW_ENABLED === 'true';
  if (process.env.ADMIN_PIN) overrides.adminPin = process.env.ADMIN_PIN;
  if (process.env.TERMINAL_CODE) overrides.terminalCode = process.env.TERMINAL_CODE;
  return overrides;
}

function load() {
  let fileSettings = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      fileSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[SETTINGS] Failed to load:', e.message);
  }
  // Priority: env vars > file settings > defaults
  return { ...DEFAULTS, ...fileSettings, ...envOverrides() };
}

function save(settings) {
  const merged = { ...load(), ...settings };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    console.error('[SETTINGS] Failed to save file:', e.message);
  }
  return merged;
}

module.exports = { load, save, DEFAULTS };
