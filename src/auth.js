import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const COOKIE_NAME = 'xe_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export const authEnabled = Boolean(config.auth.password);

/** Constant-time string comparison so the password cannot be probed by timing. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) {
    // Compare something of equal length anyway to keep the timing flat.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function sessionSecret() {
  if (config.auth.secret) return config.auth.secret;
  // Derive a stable secret from the password when no explicit one is given.
  return createHmac('sha256', config.auth.password).update('cross-engine-session').digest('hex');
}

function sign(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

/**
 * Issues a signed session cookie.
 *
 * HTTP Basic is what the human deals with - the browser prompts for it
 * natively. But browsers are not consistent about replaying cached Basic
 * credentials on a WebSocket handshake, so a successful Basic login also
 * mints a cookie. Cookies are always sent on a same-origin socket request,
 * which makes the live connection reliable in every browser.
 */
export function issueSession(req, res) {
  if (!authEnabled) return;

  const expires = Date.now() + SESSION_TTL_MS;
  const payload = String(expires);
  const token = `${payload}.${sign(payload)}`;

  const forwarded = req.headers['x-forwarded-proto'];
  const isHttps = req.secure || forwarded === 'https';

  const attributes = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps) attributes.push('Secure');

  res.setHeader('Set-Cookie', attributes.join('; '));
}

function verifySession(cookieHeader) {
  if (!cookieHeader) return false;

  const entry = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!entry) return false;

  const token = entry.slice(COOKIE_NAME.length + 1);
  const separator = token.lastIndexOf('.');
  if (separator === -1) return false;

  const payload = token.slice(0, separator);
  const mac = token.slice(separator + 1);
  if (!safeEqual(mac, sign(payload))) return false;

  const expires = Number(payload);
  return Number.isFinite(expires) && Date.now() < expires;
}

function checkBasicAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }

  const separator = decoded.indexOf(':');
  if (separator === -1) return false;

  const user = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return safeEqual(user, config.auth.user) && safeEqual(password, config.auth.password);
}

/**
 * True when the request carries valid credentials, either as Basic auth or
 * as the session cookie minted by an earlier Basic login.
 */
export function isAuthorized(req) {
  if (!authEnabled) return true;
  if (verifySession(req.headers.cookie)) return true;
  return checkBasicAuth(req);
}

/** Express middleware guarding every route except the health check. */
export function requireAuth(req, res, next) {
  if (!authEnabled) return next();
  if (req.path === '/health') return next();

  if (verifySession(req.headers.cookie)) return next();

  if (checkBasicAuth(req)) {
    // Exchange the credentials for a session so the socket can use it.
    issueSession(req, res);
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Cross Engine", charset="UTF-8"');
  res.status(401).send('Authentication required');
  return undefined;
}
