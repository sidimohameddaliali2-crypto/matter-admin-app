export function deliveryStagingConfig(env = process.env) {
  if (env.APP_ENV !== 'staging') throw new Error('Delivery staging requires APP_ENV=staging.');
  const uri = env.MONGODB_URI || '';
  if (!/^mongodb(?:\+srv)?:\/\/[^/]+\/matter_staging(?:\?|$)/.test(uri)) {
    throw new Error('Delivery staging requires an explicit matter_staging MongoDB database.');
  }
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error('Set a separate staging JWT_SECRET of at least 32 characters.');
  let origin;
  try { origin = new URL(env.CLIENT_URL); } catch { throw new Error('Set CLIENT_URL to the staging HTTPS origin.'); }
  if (origin.protocol !== 'https:' || origin.hostname.replace(/\.+$/, '') === 'matterapp.online' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('CLIENT_URL must be a staging HTTPS origin, not production.');
  const forbidden = Object.keys(env).filter(key => env[key] && /^(?:SPACES_|SLACK_|GALLABOX_|MATTER_API_|SUPY_|XERO_|TRUCKOOM_|BREVO_|SMTP_|GOOGLE_|FILEMAKER_|ATHLEAT_|SHOPIFY_|CUSTOMER_SERVICE_|REDIS_URL$)/.test(key));
  if (forbidden.length) throw new Error(`Remove integration settings from delivery staging: ${forbidden.join(', ')}`);
  const port = Number(env.PORT || 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid staging PORT.');
  return { origin: origin.origin, port, uri };
}

export function stagingRequestAllowed(path) {
  const normalized = path.replace(/\/+$/, '');
  return !/^\/api\/(?:customers\/send-whatsapp-reminder|(?:users\/)?drivers\/returns|(?:users\/)?drivers\/[^/]+\/route-directions|deliveries\/(?:geocode-google|route-eta))$/i.test(normalized)
    && !/^\/api\/deliveries\/optimize-routes(?:\/|$)/i.test(normalized);
}
