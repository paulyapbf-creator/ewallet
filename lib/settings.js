const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');
const PROFILES_FILE = path.join(__dirname, '..', 'profiles.json');

const DEFAULTS = {
  // General
  adminPin: '8888',
  terminalCode: 'POS-01',
  activeGateway: 'duitnow',
  activeProfile: 'sandbox',

  // DuitNow (J&C)
  duitnowEnabled: false,
  duitnowAppCode: '',
  duitnowMerchantCode: '',
  duitnowSecretKey: '',
  duitnowApiUrl: '',

  // AmpersandPay
  ampersandpayEnabled: false,
  ampersandpayMerchantId: '',
  ampersandpaySecretKey: '',
  ampersandpayApiUrl: '',
  ampersandpayChannel: 'EW',
  ampersandpayReturnUrl: '',
  ampersandpayCallbackUrl: '',

  // ECPI (Card Terminal)
  ecpiEnabled: false,
  ecpiHost: '',
  ecpiPort: '5000',
  ecpiTimeout: '60000',
  ecpiChecksumMode: 'bcc'
};

// Environment variables override file settings
function envOverrides() {
  const o = {};
  if (process.env.DUITNOW_APP_CODE) o.duitnowAppCode = process.env.DUITNOW_APP_CODE;
  if (process.env.DUITNOW_MERCHANT_CODE) o.duitnowMerchantCode = process.env.DUITNOW_MERCHANT_CODE;
  if (process.env.DUITNOW_SECRET_KEY) o.duitnowSecretKey = process.env.DUITNOW_SECRET_KEY;
  if (process.env.DUITNOW_API_URL) o.duitnowApiUrl = process.env.DUITNOW_API_URL;
  if (process.env.DUITNOW_ENABLED) o.duitnowEnabled = process.env.DUITNOW_ENABLED === 'true';
  if (process.env.AMPERSANDPAY_MERCHANT_ID) o.ampersandpayMerchantId = process.env.AMPERSANDPAY_MERCHANT_ID;
  if (process.env.AMPERSANDPAY_SECRET_KEY) o.ampersandpaySecretKey = process.env.AMPERSANDPAY_SECRET_KEY;
  if (process.env.AMPERSANDPAY_API_URL) o.ampersandpayApiUrl = process.env.AMPERSANDPAY_API_URL;
  if (process.env.AMPERSANDPAY_ENABLED) o.ampersandpayEnabled = process.env.AMPERSANDPAY_ENABLED === 'true';
  if (process.env.ECPI_HOST) o.ecpiHost = process.env.ECPI_HOST;
  if (process.env.ECPI_PORT) o.ecpiPort = process.env.ECPI_PORT;
  if (process.env.ECPI_ENABLED) o.ecpiEnabled = process.env.ECPI_ENABLED === 'true';
  if (process.env.ACTIVE_GATEWAY) o.activeGateway = process.env.ACTIVE_GATEWAY;
  if (process.env.ADMIN_PIN) o.adminPin = process.env.ADMIN_PIN;
  if (process.env.TERMINAL_CODE) o.terminalCode = process.env.TERMINAL_CODE;
  return o;
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
  return { ...DEFAULTS, ...fileSettings, ...envOverrides() };
}

function save(settings) {
  const merged = { ...load(), ...settings };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  } catch (e) {
    console.error('[SETTINGS] Failed to save:', e.message);
  }
  return merged;
}

// --- Profiles ---
function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[PROFILES] Failed to load:', e.message);
  }
  return {};
}

function saveProfile(name, settings) {
  const profiles = loadProfiles();
  // Only save gateway-related fields, not admin pin
  const { adminPin, activeProfile, ...gatewaySettings } = settings;
  profiles[name] = { ...gatewaySettings, savedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf8');
  } catch (e) {
    console.error('[PROFILES] Failed to save:', e.message);
  }
  return profiles;
}

function loadProfile(name) {
  const profiles = loadProfiles();
  return profiles[name] || null;
}

function deleteProfile(name) {
  const profiles = loadProfiles();
  delete profiles[name];
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf8');
  } catch (e) {
    console.error('[PROFILES] Failed to delete:', e.message);
  }
  return profiles;
}

function listProfiles() {
  const profiles = loadProfiles();
  return Object.keys(profiles).map(name => ({
    name,
    savedAt: profiles[name].savedAt,
    activeGateway: profiles[name].activeGateway,
    hasJC: !!profiles[name].duitnowApiUrl,
    hasAmpersand: !!profiles[name].ampersandpayApiUrl
  }));
}

module.exports = { load, save, DEFAULTS, saveProfile, loadProfile, deleteProfile, listProfiles };
