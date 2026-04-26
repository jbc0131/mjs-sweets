// GET /api/config
// Returns the public Square credentials the browser needs to initialize the
// Web Payments SDK. Application ID and Location ID are NOT secrets — they
// identify which Square account the storefront belongs to. The Access Token
// is the secret and is only ever read server-side in /api/checkout.

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const env = process.env.SQUARE_ENVIRONMENT || 'sandbox';
  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const locationId = process.env.SQUARE_LOCATION_ID;

  if (!applicationId || !locationId) {
    return res.status(500).json({
      error: 'Server not configured',
      detail: 'SQUARE_APPLICATION_ID and SQUARE_LOCATION_ID must be set in environment variables.',
    });
  }

  // Cache briefly at the edge — these values rarely change.
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  return res.status(200).json({
    environment: env,
    applicationId,
    locationId,
  });
};
