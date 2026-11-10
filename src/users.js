// Dashboard users, roles and which sending numbers each user may use.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const sec = require('./security');

const LEGACY_JSON = path.join(store.DATA_DIR, 'users.json');
const LEGACY_ADMIN = path.join(store.DATA_DIR, 'admin.json');
const ROLES = ['admin', 'manager', 'viewer'];
const USERNAME = /^[a-zA-Z0-9._@-]{3,64}$/;

let users = [];

const fromRow = (r) => ({
  id: r.id, user: r.user, role: r.role, salt: r.salt, hash: r.hash, totpSecret: r.totp_secret,
  allSenders: !!r.all_senders, senderIds: JSON.parse(r.sender_ids || '[]'), disabled: !!r.disabled, mustChange: !!r.must_change,
  createdAt: r.created_at, lastLogin: r.last_login, passwordChangedAt: r.password_changed_at,
});

function save() {
  store.tx(() => {
    const keep = users.map((u) => u.id);
    store.sql.prepare(`DELETE FROM users WHERE id NOT IN (${keep.map(() => '?').join(',') || "''"})`).run(...keep);
    const up = store.sql.prepare(`INSERT INTO users(id, user, role, salt, hash, totp_secret, all_senders, sender_ids, disabled, must_change, created_at, last_login, password_changed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET user=excluded.user, role=excluded.role, salt=excluded.salt, hash=excluded.hash, totp_secret=excluded.totp_secret,
        all_senders=excluded.all_senders, sender_ids=excluded.sender_ids, disabled=excluded.disabled, must_change=excluded.must_change,
        last_login=excluded.last_login, password_changed_at=excluded.password_changed_at`);
    for (const u of users) {
      up.run(u.id, u.user, u.role, u.salt, u.hash, u.totpSecret || null, u.allSenders || u.role === 'admin' ? 1 : 0, JSON.stringify(u.senderIds || []),
        u.disabled ? 1 : 0, u.mustChange ? 1 : 0, u.createdAt || new Date().toISOString(), u.lastLogin || null, u.passwordChangedAt || null);
    }
  });
}

function load() {
  users = store.sql.prepare('SELECT * FROM users ORDER BY created_at').all().map(fromRow);
  if (!users.length && fs.existsSync(LEGACY_JSON)) {                // import from the JSON version
    users = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
    save(); fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.imported');
  }
  if (!users.length && fs.existsSync(LEGACY_ADMIN)) {               // import from the single-admin version
    const a = JSON.parse(fs.readFileSync(LEGACY_ADMIN, 'utf8'));
    users = [{ id: newId(), user: a.user, role: 'admin', allSenders: true, salt: a.salt, hash: a.hash, totpSecret: a.totpSecret || null, senderIds: [], createdAt: new Date().toISOString() }];
    save(); fs.renameSync(LEGACY_ADMIN, LEGACY_ADMIN + '.imported');
  }
  if (!users.length && process.env.ADMIN_PASS) {
    const problem = sec.passwordProblem(process.env.ADMIN_PASS);
    if (problem) { console.error(`ADMIN_PASS in .env is too weak: ${problem}. Run "npm run setup-admin" instead.`); process.exit(1); }
    users = [{ id: newId(), user: process.env.ADMIN_USER || 'admin', role: 'admin', allSenders: true, ...sec.hashPassword(process.env.ADMIN_PASS), totpSecret: null, senderIds: [], createdAt: new Date().toISOString() }];
    save();
    console.warn('Admin account created from ADMIN_PASS in .env. Remove ADMIN_PASS from .env now; it is stored hashed in the database.');
  }
  if (!users.some((u) => u.role === 'admin' && !u.disabled)) {
    console.error('No admin account. Run:  npm run setup-admin');
    process.exit(1);
  }
}

function newId() { return 'u' + crypto.randomBytes(6).toString('hex'); }

function tempPassword() {
  for (;;) {
    const p = crypto.randomBytes(12).toString('base64url');
    if (!sec.passwordProblem(p)) return p;
  }
}

const find = (id) => users.find((u) => u.id === id);
const findByName = (name) => users.find((u) => u.user.toLowerCase() === String(name).toLowerCase());
const activeAdmins = () => users.filter((u) => u.role === 'admin' && !u.disabled);

// A password check that takes the same time whether or not the user exists.
const DUMMY = sec.hashPassword('dummy-password-for-timing');
function checkPassword(u, password) {
  const salt = u ? u.salt : DUMMY.salt, hash = u ? u.hash : DUMMY.hash;
  return sec.safeEqual(sec.hashPassword(String(password).slice(0, 256), salt).hash, hash) && !!u;
}

const lastTotp = new Map(); // userId -> last accepted 30s step (stops code reuse)
function checkTotp(u, code) {
  if (!u.totpSecret) return true;
  return sec.verifyTotp(u.totpSecret, code, lastTotp, u.id);
}

function publicUser(u) {
  return { id: u.id, user: u.user, role: u.role, allSenders: u.role === 'admin' || !!u.allSenders, senderIds: u.senderIds || [], disabled: !!u.disabled,
    totp: !!u.totpSecret, mustChange: !!u.mustChange, createdAt: u.createdAt, lastLogin: u.lastLogin || null };
}

function cleanSenderIds(ids) {
  if (!Array.isArray(ids)) return [];
  const known = new Set(store.db.senders.map((s) => s.id));
  return [...new Set(ids.map(String))].filter((id) => known.has(id)).slice(0, 100);
}

function create({ user, role, senderIds, allSenders }) {
  user = String(user || '').trim();
  if (!USERNAME.test(user)) throw new Error('Username: 3–64 letters, numbers or . _ @ -');
  if (findByName(user)) throw new Error('That username already exists');
  if (!ROLES.includes(role)) throw new Error('Choose a role');
  const password = tempPassword();
  const u = { id: newId(), user, role, ...sec.hashPassword(password), totpSecret: null, allSenders: role === 'admin' || !!allSenders, senderIds: role === 'admin' ? [] : cleanSenderIds(senderIds),
    mustChange: true, createdAt: new Date().toISOString() };
  users.push(u); save();
  return { user: publicUser(u), password };
}

function update(id, { role, senderIds, allSenders, disabled }) {
  const u = find(id);
  if (!u) throw new Error('User not found');
  const next = { role: role ?? u.role, disabled: typeof disabled === 'boolean' ? disabled : !!u.disabled };
  if (!ROLES.includes(next.role)) throw new Error('Choose a role');
  if (u.role === 'admin' && (next.role !== 'admin' || next.disabled) && activeAdmins().length <= 1) throw new Error('Keep at least one active admin');
  u.role = next.role; u.disabled = next.disabled;
  if (typeof allSenders === 'boolean') u.allSenders = allSenders;
  if (u.role === 'admin') u.allSenders = true;
  if (senderIds !== undefined || u.role === 'admin') u.senderIds = u.role === 'admin' ? [] : cleanSenderIds(senderIds ?? u.senderIds);
  save();
  return publicUser(u);
}

function resetPassword(id) {
  const u = find(id);
  if (!u) throw new Error('User not found');
  const password = tempPassword();
  Object.assign(u, sec.hashPassword(password), { mustChange: true });
  save();
  return password;
}

function setPassword(u, password) {
  const problem = sec.passwordProblem(password);
  if (problem) throw new Error(problem);
  if (checkPassword(u, password)) throw new Error('Choose a password different from the current one');
  Object.assign(u, sec.hashPassword(password), { mustChange: false, passwordChangedAt: new Date().toISOString() });
  save();
}

function setTotp(u, secret) { u.totpSecret = secret; save(); }

function remove(id) {
  const u = find(id);
  if (!u) throw new Error('User not found');
  if (u.role === 'admin' && !u.disabled && activeAdmins().length <= 1) throw new Error('Keep at least one active admin');
  users = users.filter((x) => x.id !== id); save();
  return u;
}

// Used by `npm run setup-admin`: create the admin, or reset an existing user to admin with a new password.
function setAdmin({ user, password, totpSecret }) {
  users = store.sql.prepare('SELECT * FROM users ORDER BY created_at').all().map(fromRow);
  if (!USERNAME.test(user)) throw new Error('Username: 3–64 letters, numbers or . _ @ -');
  const problem = sec.passwordProblem(password);
  if (problem) throw new Error(problem);
  let u = findByName(user);
  if (!u) { u = { id: newId(), user, createdAt: new Date().toISOString(), senderIds: [] }; users.push(u); }
  Object.assign(u, { role: 'admin', allSenders: true, disabled: false, mustChange: false, totpSecret: totpSecret || null, ...sec.hashPassword(password) });
  save();
  return u;
}

function touchLogin(u) { u.lastLogin = new Date().toISOString(); save(); }

// ---- what a user may see / do ----
const isAdmin = (u) => u.role === 'admin';
const canEdit = (u) => u.role === 'admin' || u.role === 'manager';
function canUseSender(u, senderId) {
  if (isAdmin(u) || u.allSenders) return true;
  return (u.senderIds || []).includes(senderId);   // empty list = no numbers
}
function dropSender(senderId) {           // a number was removed: take it off everyone's list
  let changed = false;
  for (const u of users) if (u.senderIds && u.senderIds.includes(senderId)) { u.senderIds = u.senderIds.filter((x) => x !== senderId); changed = true; }
  if (changed) save();
}

module.exports = {
  load, ROLES, find, findByName, list: () => users.map(publicUser), publicUser,
  checkPassword, checkTotp, setAdmin, create, update, resetPassword, setPassword, setTotp, remove, touchLogin,
  isAdmin, canEdit, canUseSender, dropSender, save, _all: () => users,
};
