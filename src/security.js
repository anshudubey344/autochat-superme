// App-level security: admin credentials, sessions, login lockout, CSRF, rate limits, headers, TOTP.
const crypto = require('crypto');

const SESSION_HOURS = Number(process.env.SESSION_HOURS) || 12;
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 120;
const COOKIE = 'wa_sid';

// ---------- password hashing (scrypt) ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function passwordProblem(p) {
  p = String(p || '');
  if (p.length < 12) return 'Password must be at least 12 characters';
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/\d/.test(p)) return 'Password needs upper case, lower case and a number';
  if (/^(password|admin|whatsapp|change-this)/i.test(p)) return 'Password is too easy to guess';
  return null;
}

// ---------- TOTP (RFC 6238, works with Google Authenticator / Authy) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function base32Decode(s) {
  let bits = '';
  for (const c of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totpAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// `seen` remembers the last accepted step per key so a code can't be used twice.
function verifyTotp(secret, code, seen = new Map(), key = 'k') {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 30000);
  for (const c of [now - 1, now, now + 1]) {
    if (c > (seen.get(key) || 0) && safeEqual(totpAt(secret, c), code)) { seen.set(key, c); return true; }
  }
  return false;
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

// ---------- sessions ----------
const sessions = new Map(); // id -> {userId, created, seen, csrf, ip}
function createSession(userId, ip) {
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { userId, created: Date.now(), seen: Date.now(), csrf: crypto.randomBytes(24).toString('base64url'), ip });
  return id;
}
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function getSession(req) {
  const id = readCookie(req, COOKIE);
  const s = id && sessions.get(id);
  if (!s) return null;
  const now = Date.now();
  if (now - s.created > SESSION_HOURS * 3600e3 || now - s.seen > IDLE_MINUTES * 60e3) { sessions.delete(id); return null; }
  s.seen = now;
  return { id, ...s, ref: s };
}
function cookieFlags(req) {
  const secure = req.secure || process.env.COOKIE_SECURE === 'true';
  // Lax (not Strict) so the session survives the redirect back from Google's permission screen.
  // Changes are still protected by the CSRF token + same-origin check.
  return `; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
function setSessionCookie(req, res, id) {
  res.append('Set-Cookie', `${COOKIE}=${id}${cookieFlags(req)}; Max-Age=${SESSION_HOURS * 3600}`);
}
function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE}=${cookieFlags(req)}; Max-Age=0`);
}
function destroySession(id) { sessions.delete(id); }
function destroyAllSessions() { sessions.clear(); }
function destroyUserSessions(userId, exceptId) { for (const [id, s] of sessions) if (s.userId === userId && id !== exceptId) sessions.delete(id); }
setInterval(() => { // sweep expired
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.created > SESSION_HOURS * 3600e3 || now - s.seen > IDLE_MINUTES * 60e3) sessions.delete(id);
}, 10 * 60e3).unref();

// ---------- login lockout ----------
const fails = new Map(); // ip -> {count, first, lockedUntil}
const MAX_FAILS = 5, WINDOW = 15 * 60e3, LOCK = 15 * 60e3;
let globalFails = { count: 0, first: Date.now() };
function loginBlocked(ip) {
  const f = fails.get(ip);
  if (f && f.lockedUntil > Date.now()) return Math.ceil((f.lockedUntil - Date.now()) / 60000);
  if (Date.now() - globalFails.first < WINDOW && globalFails.count >= 50) return 15; // distributed guessing
  return 0;
}
function loginFailed(ip) {
  const now = Date.now();
  let f = fails.get(ip);
  if (!f || now - f.first > WINDOW) f = { count: 0, first: now, lockedUntil: 0 };
  f.count++;
  if (f.count >= MAX_FAILS) f.lockedUntil = now + LOCK;
  fails.set(ip, f);
  if (now - globalFails.first > WINDOW) globalFails = { count: 0, first: now };
  globalFails.count++;
}
function loginSucceeded(ip) { fails.delete(ip); }

// ---------- generic rate limiter ----------
function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req), now = Date.now();
    let h = hits.get(k);
    if (!h || now - h.start > windowMs) { h = { start: now, n: 0 }; hits.set(k, h); }
    if (++h.n > max) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    next();
  };
}

// ---------- headers ----------
function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
      "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// ---------- CSRF: same-origin + per-session token on every state change ----------
function csrfCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Blocked: request came from another site' }); }
    catch (_) { return res.status(403).json({ error: 'Blocked: bad origin' }); }
  }
  const s = req.session;
  if (!s || !safeEqual(req.headers['x-csrf-token'] || '', s.csrf)) return res.status(403).json({ error: 'Session expired. Reload the page.' });
  next();
}

module.exports = {
  hashPassword, safeEqual, passwordProblem, verifyTotp, newTotpSecret, totpAt,
  createSession, getSession, setSessionCookie, clearSessionCookie, destroySession, destroyAllSessions, destroyUserSessions,
  loginBlocked, loginFailed, loginSucceeded, rateLimit, securityHeaders, csrfCheck,
};
