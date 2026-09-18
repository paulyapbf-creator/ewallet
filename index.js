const DuitNowGateway = require('./gateways/DuitNowGateway');
const AmpersandPayGateway = require('./gateways/AmpersandPayGateway');
const ECPIGateway = require('./gateways/ECPIGateway');

// Registry of available gateways
const GATEWAYS = {
  duitnow: DuitNowGateway,
  ampersandpay: AmpersandPayGateway,
  ecpi: ECPIGateway
};

/**
 * Get a payment gateway instance.
 * @param {string} provider - Gateway name (e.g., 'duitnow', 'ampersandpay')
 * @param {object} config - Provider-specific credentials and settings
 * @returns {BaseGateway} Gateway instance
 */
function getGateway(provider, config) {
  const GatewayClass = GATEWAYS[provider];
  if (!GatewayClass) {
    throw new Error(`Unknown payment gateway: "${provider}". Available: ${Object.keys(GATEWAYS).join(', ')}`);
  }
  return new GatewayClass(config);
}

/**
 * List all registered gateway names.
 * @returns {string[]}
 */
function listGateways() {
  return Object.keys(GATEWAYS);
}

module.exports = { getGateway, listGateways };
