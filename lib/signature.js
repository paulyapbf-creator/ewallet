const crypto = require('crypto');

/**
 * Generate HMAC SHA256 signature, Base64-encoded.
 * @param {string} secretKey - The secret key for HMAC
 * @param {...string} fields - Fields to concatenate (order matters)
 * @returns {string} Base64-encoded HMAC SHA256 signature
 */
function generateSignature(secretKey, ...fields) {
  const combinationString = fields.join('');
  console.log(`[SIGNATURE] Key: "${secretKey}" | String: "${combinationString}"`);
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(combinationString, 'utf8');
  const sig = hmac.digest('base64');
  console.log(`[SIGNATURE] Result: ${sig}`);
  return sig;
}

module.exports = { generateSignature };
