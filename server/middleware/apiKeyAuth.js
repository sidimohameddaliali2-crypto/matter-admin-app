// Static API-key auth for third-party / machine-to-machine access — separate
// from `protect` (the JWT login used by the app's own staff). A key is pure
// env config: no DB record, no login flow, so it can be handed to an
// external party without provisioning them a user account, and revoked by
// just changing the env var and restarting.
//
// DELIVERY_API_KEYS accepts one or more "label:key" pairs, comma-separated,
// e.g.:
//   DELIVERY_API_KEYS=logistics_partner:9f2a3c...,acme_kitchen:7c1b90...
// A bare key with no label is accepted too (labelled "default"). Multiple
// labelled keys let you tell clients apart in logs and revoke one without
// affecting the others.
//
// Clients send the key as either header:
//   x-api-key: <key>
//   Authorization: Bearer <key>

function parseKeys() {
  const raw = process.env.DELIVERY_API_KEYS || process.env.DELIVERY_API_KEY || '';
  const map = new Map();
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const idx = entry.indexOf(':');
      if (idx > 0) {
        map.set(entry.slice(idx + 1), entry.slice(0, idx));
      } else {
        map.set(entry, 'default');
      }
    });
  return map;
}

export const apiKeyAuth = (req, res, next) => {
  const keys = parseKeys();
  if (keys.size === 0) {
    return res.status(503).json({ success: false, message: 'External delivery API is not configured' });
  }

  const headerKey = req.headers['x-api-key'];
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const provided = headerKey || (bearer && bearer[1]) || '';

  if (!provided || !keys.has(provided)) {
    return res.status(401).json({ success: false, message: 'Invalid or missing API key' });
  }

  req.apiClient = keys.get(provided);
  next();
};

// Reuse the tooling key, but opt in only the worker's configured label to
// additional reporting evidence. Bare external keys use the default label.
export function isReportingApiClient(req, env = process.env) {
  return typeof req.apiClient === 'string'
    && (env.MATTER_REPORTING_API_CLIENTS || '').split(',').map(label => label.trim()).filter(Boolean).includes(req.apiClient);
}
