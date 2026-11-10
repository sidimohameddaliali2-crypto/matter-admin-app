import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import Limit from '../models/MenuAuthLimit.js';
import matter from './matterApiService.js';

export const normalizeMenuEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const signingKey = () => {
  const key = process.env.MENU_CUSTOMER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!key || key.length < 32 || /^(your[-_ ]|change[-_ ]|secret$)/i.test(key)) {
    throw fail(503, 'Menu sign-in is not configured. Please contact customer service.');
  }
  return key;
};
const audience = 'matter-menu-customer';
const issuer = 'matter-menu-auth';

export function issueMenuSession(email, menuId, key = signingKey()) {
  return jwt.sign({ purpose: 'menu-selection', accessMethod: 'shared-link-email', email: normalizeMenuEmail(email), menuId: String(menuId) }, key,
    { algorithm: 'HS256', audience, issuer, expiresIn: '1h' });
}

export function verifyMenuSession(token) {
  try {
    const claims = jwt.verify(token, signingKey(), { algorithms: ['HS256'], audience, issuer });
    if (claims.purpose !== 'menu-selection' || claims.accessMethod !== 'shared-link-email' || !claims.email || !claims.menuId || claims.id || claims.memberId || claims.partnerId) throw new Error();
    return claims;
  } catch (error) {
    if (error.statusCode === 503) throw error;
    throw fail(401, 'Please enter your email again to continue.');
  }
}

// Owner (2026-11-02): keep the shared weekly link and email-only access,
// accepting the weaker identity protection. Matching a subscription email
// is NOT proof of ownership. These scoped tokens prevent accidental account
// mixing/tampering, but someone knowing another email can request a session.
export function createMenuSessionService({ limits = Limit, lookup = email => matter.getKitchenNutrition({ email }), now = () => Date.now() } = {}) {
  async function takeLimit(scope, maximum) {
    const stamp = now();
    const windowMs = 15 * 60 * 1000;
    const id = crypto.createHmac('sha256', signingKey()).update(`${scope}:${Math.floor(stamp / windowMs)}`).digest('hex');
    let counter;
    const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(stamp + windowMs * 2) } };
    try { counter = await limits.findOneAndUpdate({ _id: id }, update, { upsert: true, new: true }).lean(); }
    catch (error) {
      if (error.code !== 11000) throw error;
      counter = await limits.findOneAndUpdate({ _id: id }, { $inc: { count: 1 } }, { new: true }).lean();
    }
    if (!counter || counter.count > maximum) throw fail(429, 'Too many menu sign-in requests. Please try again later.');
  }
  return {
    async start(emailValue, menuId) {
      const email = normalizeMenuEmail(emailValue);
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address.');
      signingKey();
      await takeLimit(`menu-recipient:${email}`, 30);
      await takeLimit('all-menu-sessions', 2000);
      let nutrition;
      try { nutrition = await lookup(email); }
      catch { throw fail(502, 'Could not load your subscription. Please try again shortly.'); }
      if (!nutrition) throw fail(404, 'We could not find an account under this email. Kindly contact customer service.');
      if (!nutrition.customer_id || normalizeMenuEmail(nutrition.customer_email) !== email) throw fail(409, 'Could not match this email to a subscription. Please contact customer service.');
      return { token: issueMenuSession(email, menuId), email, menuId: String(menuId) };
    },
  };
}

export const menuSessions = createMenuSessionService();
