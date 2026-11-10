// "Connect Google account": OAuth so the dashboard can open any sheet that account can open,
// without sharing each sheet. Refresh tokens are stored encrypted (AES-256-GCM) in the database.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const store = require('./store');

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const REDIRECT = PUBLIC_URL + '/auth/google/callback';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets'];
const configured = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && PUBLIC_URL);

store.sql.exec(`CREATE TABLE IF NOT EXISTS google_accounts (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, token TEXT NOT NULL, connected_by TEXT NOT NULL, created_at TEXT NOT NULL
)`);

// ---------- encryption key (data/secret.key, or APP_SECRET in .env) ----------
function loadKey() {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const f = path.join(store.DATA_DIR, 'secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
}
const KEY = loadKey();
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, data] = blob.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// ---------- accounts ----------
const list = () => store.sql.prepare('SELECT id, email, connected_by AS connectedBy, created_at AS createdAt FROM google_accounts ORDER BY created_at').all().map((r) => ({ ...r }));
const get = (id) => list().find((a) => a.id === id);
const clients = new Map();
function client(id) {
  if (clients.has(id)) return clients.get(id);
  const row = store.sql.prepare('SELECT token FROM google_accounts WHERE id = ?').get(id);
  if (!row) throw new Error('Google account is no longer connected');
  const c = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);
  c.setCredentials({ refresh_token: decrypt(row.token) });
  clients.set(id, c);
  return c;
}

// Admins can use every connected account; others only the ones they connected.
const usableBy = (user) => list().filter((a) => user.role === 'admin' || a.connectedBy === user.id);

// ---------- OAuth flow ----------
function startUrl(session) {
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  session.googleOAuth = { state, verifier, at: Date.now() };
  const c = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);
  return c.generateAuthUrl({
    access_type: 'offline', prompt: 'consent select_account', scope: SCOPES, state, include_granted_scopes: false,
    code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  });
}

async function finish(session, { code, state, error }, userId) {
  const pending = session.googleOAuth;
  delete session.googleOAuth;
  if (error) throw new Error(error === 'access_denied' ? 'You cancelled the Google permission screen' : 'Google returned: ' + error);
  if (!pending || !state || state.length !== pending.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state)) || Date.now() - pending.at > 10 * 60e3) {
    throw new Error('This Google sign-in link expired. Try Connect again.');
  }
  const c = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT);
  const { tokens } = await c.getToken({ code, codeVerifier: pending.verifier });
  if (!String(tokens.scope || '').includes('auth/spreadsheets')) throw new Error('Please tick the Google Sheets permission on the Google screen and try again.');
  if (!tokens.refresh_token) throw new Error('Google did not give long-term access. Remove the app at myaccount.google.com/permissions and connect again.');
  const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
  const email = ticket.getPayload().email;
  const existing = store.sql.prepare('SELECT id FROM google_accounts WHERE lower(email) = lower(?) AND connected_by = ?').get(email, userId);
  const id = existing ? existing.id : 'g' + crypto.randomBytes(6).toString('hex');
  store.sql.prepare(`INSERT INTO google_accounts(id, email, token, connected_by, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET token = excluded.token`).run(id, email, encrypt(tokens.refresh_token), userId, new Date().toISOString());
  clients.delete(id);
  return { id, email };
}

async function disconnect(id) {
  try { await client(id).revokeCredentials(); } catch (_) { /* already revoked */ }
  clients.delete(id);
  store.sql.prepare('DELETE FROM google_accounts WHERE id = ?').run(id);
}

async function request(id, opts) {
  const res = await client(id).request(opts);
  return res.data;
}

module.exports = { configured, REDIRECT, list, get, usableBy, startUrl, finish, disconnect, request };
