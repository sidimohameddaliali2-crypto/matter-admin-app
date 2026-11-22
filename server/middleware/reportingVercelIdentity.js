import { createPublicKey, verify } from 'node:crypto';

const issuer = 'https://oidc.vercel.com/populus-ai';
const audience = 'https://matterapp.online/api/external/reporting';
const ownerId = 'team_kVKDtA3C2ZkzLbDfHtCNz225';
const projectId = 'prj_9vDb9dhZlbcF4H4jxwsbY3G4AVqU';
const subject = 'owner:populus-ai:project:matter-private-reporting:environment:';
const jwksUrl = issuer + '/.well-known/jwks';
const maxTokenBytes = 8192;
const maxJwksBytes = 64 * 1024;
const keyTtlSeconds = 600;
const keyRefreshCooldownSeconds = 60;
const maxTokenLifetimeSeconds = 2 * 60 * 60;
const clockSkewSeconds = 30;
const keyIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const reportingReadPath = /^\/(?:changes|readiness|deliveries\/[a-f0-9]{24}|days\/\d{4}-\d{2}-\d{2}\/ids|gps-batches\/[^/]+)\/?$/i;

function jwtJson(segment) {
  const data = Buffer.from(segment, 'base64url');
  if (data.toString('base64url') !== segment) return null;
  const value = JSON.parse(data.toString('utf8'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function readBearer(authorization) {
  if (typeof authorization !== 'string' || authorization.length > maxTokenBytes) return null;
  const parts = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!parts) return null;
  try {
    const [, header, payload, signature] = parts;
    return { header: jwtJson(header), claims: jwtJson(payload), inputs: header + '.' + payload, signature };
  } catch {
    return null;
  }
}

export function isReportingVercelRead(req) {
  return req.method === 'GET' && reportingReadPath.test(req.path)
    && !req.headers['x-api-key'] && readBearer(req.headers.authorization)?.claims?.iss === issuer;
}

function isAllowedToken(token, now, environment) {
  const { header, claims } = token ?? {};
  if (!header || !claims || header.alg !== 'RS256' || header.typ !== 'JWT'
      || typeof header.kid !== 'string' || !keyIdPattern.test(header.kid) || Object.hasOwn(header, 'crit')) return false;
  const tokenEnvironment = claims.environment;
  const environmentAllowed = tokenEnvironment === 'preview'
    || (tokenEnvironment === 'production' && environment.MATTER_REPORTING_VERCEL_OIDC_PRODUCTION_ENABLED === '1');
  if (!environmentAllowed || claims.iss !== issuer || claims.aud !== audience || claims.owner_id !== ownerId
      || claims.project_id !== projectId || claims.sub !== subject + tokenEnvironment) return false;
  const { iat, nbf, exp } = claims;
  return Number.isSafeInteger(iat) && Number.isSafeInteger(nbf) && Number.isSafeInteger(exp)
    && exp > now && exp > iat && exp > nbf && exp - iat <= maxTokenLifetimeSeconds
    && iat <= now + clockSkewSeconds && nbf <= now + clockSkewSeconds;
}

async function fetchSigningKeys(fetchImpl) {
  const response = await fetchImpl(jwksUrl, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok || response.redirected || !response.body) throw new Error('Vercel reporting keys unavailable');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxJwksBytes) throw new Error('Vercel reporting keys exceed the size limit');
    chunks.push(chunk);
  }
  const { keys } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 32) throw new Error('Invalid Vercel reporting key set');

  const signingKeys = new Map();
  for (const jwk of keys) {
    if (!jwk || jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')
        || typeof jwk.kid !== 'string' || !keyIdPattern.test(jwk.kid) || !base64UrlPattern.test(jwk.n ?? '')
        || !base64UrlPattern.test(jwk.e ?? '')) continue;
    if (signingKeys.has(jwk.kid)) throw new Error('Duplicate Vercel reporting signing key');
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048) signingKeys.set(jwk.kid, key);
  }
  if (signingKeys.size === 0) throw new Error('Missing Vercel reporting signing keys');
  return signingKeys;
}

export function createReportingVercelIdentity({
  env = process.env,
  fetchImpl = fetch,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  let keys = new Map();
  let expires = 0;
  let refreshAfter = 0;
  let refresh;

  async function keyFor(kid, time) {
    if (time < expires && keys.has(kid)) return keys.get(kid);
    if (!refresh && time >= refreshAfter) {
      refreshAfter = time + keyRefreshCooldownSeconds;
      refresh = fetchSigningKeys(fetchImpl).then(result => {
        keys = result;
        expires = now() + keyTtlSeconds;
      }).finally(() => { refresh = undefined; });
    }
    if (refresh) await refresh;
    return now() < expires ? keys.get(kid) : undefined;
  }

  return async function hasReportingVercelIdentity(req) {
    if (!isReportingVercelRead(req) || env.MATTER_REPORTING_VERCEL_OIDC_ENABLED !== '1') return false;
    if (req.path.toLowerCase().replace(/\/$/, '') !== '/readiness' && env.MATTER_REPORTING_CAPTURE_ENABLED !== '1') {
      return false;
    }

    const token = readBearer(req.headers.authorization);
    const time = now();
    if (!isAllowedToken(token, time, env)) return false;
    try {
      const key = await keyFor(token.header.kid, time);
      const signature = Buffer.from(token.signature, 'base64url');
      return Boolean(key && signature.toString('base64url') === token.signature
        && isAllowedToken(token, now(), env) && verify('RSA-SHA256', Buffer.from(token.inputs), key, signature));
    } catch {
      return false;
    }
  };
}
