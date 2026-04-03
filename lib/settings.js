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

function load() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return { ...DEFAULTS, ...data };
    }
  } catch (e) {
    console.error('[SETTINGS] Failed to load:', e.message);
  }
  return { ...DEFAULTS };
}

function save(settings) {
  const merged = { ...load(), ...settings };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = { load, save, DEFAULTS };
