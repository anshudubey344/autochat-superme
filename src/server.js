require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const QR = require('qrcode');
const store = require('./store');
const sec = require('./security');
const users = require('./users');
const senders = require('./senders');
const sheets = require('./sheets');
const google = require('./google');
const engine = require('./engine');

const { PORT = 3000, HOST = '0.0.0.0' } = process.env;
users.load();
if (process.getuid && process.getuid() === 0) console.warn('Running as root. For production, run under a normal user (see README).');

const DEFAULT_TEMPLATES = [
  { service: '1:1 Yoga', message: 'Hi {name}! 🙏 Thanks for your interest in our 1:1 Yoga sessions.\n\nYou get a personal teacher, a plan built around your goals, and flexible timings.\nReply YES and we will help you book your first session.' },
  { service: 'Live Group Yoga', message: 'Hi {name}! 🧘 Thanks for your interest in our Live Group Yoga classes.\n\nJoin live classes with an instructor and a small group, from anywhere.\nReply YES to get this week\'s schedule.' },
  { service: 'Streaming', message: 'Hi {name}! 📺 Thanks for your interest in our Streaming classes.\n\nPractice anytime with our on-demand library of sessions.\nReply YES and we will share your access details.' },
  { service: 'Coaches', message: 'Hi {name}! 💪 Thanks for your interest in working with our Coaches.\n\nTell us your goal and we will match you with the right coach.\nReply YES to get started.' },
  { service: 'Therapy', message: 'Hi {name}! 🌿 Thanks for reaching out about Therapy.\n\nOur therapists offer private, confidential sessions at a time that suits you.\nReply YES and we will help you book a slot.' },
  { service: 'Default', message: 'Hi {name}! Thanks for your interest in {service}. Our team will reach out to you shortly.' },
];

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
app.use(sec.securityHeaders);
app.use(express.json({ limit: '200kb', strict: true }));

const PUBLIC = path.join(__dirname, '..', 'public');
const OPEN_FILES = new Set(['/login.html', '/login.js', '/style.css', '/brand.js', '/brand.json', '/favicon.ico', '/icon-default.svg']);
const BRAND_DIR = path.join(PUBLIC, 'brand');
function brandFile(name) {
  try { const f = fs.readdirSync(BRAND_DIR).find((x) => x.startsWith(name + '.') && /\.(png|svg|webp|jpg|ico)$/.test(x)); return f ? '/brand/' + f : null; }
  catch (_) { return null; }
}
const ip = (req) => req.ip || req.socket.remoteAddress;

// ---------- helpers ----------
class UserError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  if (!(e instanceof UserError)) console.error(e.message);
  res.status(e.status || 400).json({ error: e.message || 'Something went wrong' });
});
const str = (v, max, label) => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new UserError(`${label} is too long (max ${max} characters)`);
  return s;
};
const num = (v, d, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const forbidden = () => new UserError('You don\'t have access to do this', 403);

// Activity log entry that records who did it
const audit = (req, level, text, extra = {}) => store.log(level, `${text} (by ${req.user.user})`, { ...extra, by: req.user.id });

// Permission checks
const needAdmin = (req) => { if (!users.isAdmin(req.user)) throw forbidden(); };
const needEditor = (req) => { if (!users.canEdit(req.user)) throw forbidden(); };
function senderFor(req, id) {
  const s = store.db.senders.find((x) => x.id === id);
  if (!s || !users.canUseSender(req.user, s.id)) throw new UserError('Number not found', 404);  // don't reveal numbers outside your access
  return s;
}
function sheetFor(req, id) {
  const s = store.db.sheets.find((x) => x.id === id);
  if (!s || !users.canUseSender(req.user, s.senderId)) throw new UserError('Sheet not found', 404);
  return s;
}

// ---------- brand (open: the sign-in page uses it too) ----------
app.get('/brand.json', (req, res) => res.json({
  name: String(process.env.BRAND_NAME || '').slice(0, 40),
  color: /^#[0-9a-f]{6}$/i.test(process.env.BRAND_COLOR || '') ? process.env.BRAND_COLOR : '',
  logo: brandFile('logo'), icon: brandFile('icon'),
}));
app.get('/favicon.ico', (req, res) => res.redirect(302, brandFile('icon') || '/icon-default.svg'));
app.use('/brand', express.static(BRAND_DIR, { dotfiles: 'deny', index: false, fallthrough: false }));

// ---------- sign in (open) ----------
app.post('/auth/login', sec.rateLimit({ windowMs: 15 * 60e3, max: 30 }), (req, res) => {
  const who = ip(req);
  const wait = sec.loginBlocked(who);
  if (wait) {
    store.log('security', `Blocked sign-in attempt from ${who} (too many failures)`);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${wait} min.` });
  }
  const { user = '', password = '', code = '' } = req.body || {};
  const u = users.findByName(String(user).slice(0, 64));
  const ok = users.checkPassword(u, password) && !u.disabled;
  if (!ok) {
    sec.loginFailed(who);
    store.log('security', `Failed sign-in for "${String(user).slice(0, 64)}" from ${who}`);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  if (u.totpSecret && !code) return res.status(401).json({ error: 'Enter the code from your authenticator app', needCode: true });
  if (!users.checkTotp(u, code)) {
    sec.loginFailed(who);
    store.log('security', `Wrong 2-step code for "${u.user}" from ${who}`);
    return res.status(401).json({ error: 'Wrong code. Use the latest code from the app.', needCode: true });
  }
  sec.loginSucceeded(who);
  const old = sec.getSession(req);
  if (old) sec.destroySession(old.id);                      // no session fixation
  sec.setSessionCookie(req, res, sec.createSession(u.id, who));
  users.touchLogin(u);
  store.log('security', `${u.user} signed in from ${who}`);
  res.json({ ok: true, mustChange: !!u.mustChange });
});

// ---------- everything below needs a signed-in, active user ----------
app.use((req, res, next) => {
  if (req.method === 'GET' && OPEN_FILES.has(req.path)) return next();
  const s = sec.getSession(req);
  const u = s && users.find(s.userId);
  if (!s || !u || u.disabled) {
    if (s) sec.destroySession(s.id);
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return res.status(401).json({ error: 'Signed out. Reload the page to sign in.' });
    return res.redirect(302, '/login.html');
  }
  req.session = s; req.user = u;
  next();
});
app.use(express.static(PUBLIC, { index: 'index.html', dotfiles: 'deny' }));
app.use(['/api', '/auth'], sec.rateLimit({ windowMs: 60e3, max: 300 }), sec.csrfCheck);

// A user with a temporary password must change it before anything else.
app.use('/api', (req, res, next) => {
  if (req.user.mustChange && !['/me', '/account/password'].includes(req.path)) return res.status(403).json({ error: 'Set a new password first', mustChange: true });
  next();
});

app.get('/api/me', (req, res) => res.json({ ...users.publicUser(req.user), csrf: req.session.csrf }));
app.post('/auth/logout', (req, res) => {
  sec.destroySession(req.session.id);
  sec.clearSessionCookie(req, res);
  store.log('security', `${req.user.user} signed out`);
  res.json({ ok: true });
});

// ---------- my account ----------
app.post('/api/account/password', sec.rateLimit({ windowMs: 15 * 60e3, max: 10 }), wrap((req, res) => {
  if (!users.checkPassword(req.user, req.body.current || '')) throw new UserError('Current password is wrong');
  users.setPassword(req.user, String(req.body.password || ''));
  sec.destroyUserSessions(req.user.id, req.session.id);      // sign out other devices
  store.log('security', `${req.user.user} changed their password`);
  res.json({ ok: true });
}));
app.post('/api/account/2fa/start', wrap(async (req, res) => {
  const secret = sec.newTotpSecret();
  req.session.ref.pendingTotp = secret;
  const url = `otpauth://totp/WhatsApp%20Sender:${encodeURIComponent(req.user.user)}?secret=${secret}&issuer=WhatsApp%20Sender`;
  res.json({ secret, qr: await QR.toDataURL(url, { margin: 1, width: 220 }) });
}));
app.post('/api/account/2fa/confirm', wrap((req, res) => {
  const secret = req.session.ref.pendingTotp;
  if (!secret) throw new UserError('Start 2-step setup again');
  if (!sec.verifyTotp(secret, req.body.code)) throw new UserError('Code did not match. Check the phone\'s clock and try the latest code.');
  users.setTotp(req.user, secret);
  delete req.session.ref.pendingTotp;
  store.log('security', `${req.user.user} turned on 2-step sign-in`);
  res.json({ ok: true });
}));
app.post('/api/account/2fa/disable', sec.rateLimit({ windowMs: 15 * 60e3, max: 10 }), wrap((req, res) => {
  if (!users.checkPassword(req.user, req.body.password || '')) throw new UserError('Password is wrong');
  users.setTotp(req.user, null);
  store.log('security', `${req.user.user} turned off 2-step sign-in`);
  res.json({ ok: true });
}));

// ---------- team (admin only) ----------
app.get('/api/users', wrap((req, res) => { needAdmin(req); res.json(users.list()); }));
app.post('/api/users', wrap((req, res) => {
  needAdmin(req);
  const r = users.create({ user: req.body.user, role: req.body.role, senderIds: req.body.senderIds, allSenders: !!req.body.allSenders });
  audit(req, 'security', `User "${r.user.user}" added as ${r.user.role}`);
  res.json(r);   // temporary password is shown once
}));
app.patch('/api/users/:id', wrap((req, res) => {
  needAdmin(req);
  const b = req.body;
  if (req.params.id === req.user.id && (b.disabled === true || (b.role && b.role !== 'admin'))) throw new UserError('You can\'t remove your own admin access');
  const u = users.update(req.params.id, { role: b.role, senderIds: b.senderIds, allSenders: typeof b.allSenders === 'boolean' ? b.allSenders : undefined, disabled: b.disabled });
  sec.destroyUserSessions(u.id);                              // apply new access immediately
  audit(req, 'security', `User "${u.user}" updated: ${u.disabled ? 'disabled' : u.role}`);
  res.json(u);
}));
app.post('/api/users/:id/reset-password', wrap((req, res) => {
  needAdmin(req);
  const password = users.resetPassword(req.params.id);
  sec.destroyUserSessions(req.params.id);
  audit(req, 'security', `Password reset for "${users.find(req.params.id).user}"`);
  res.json({ password });
}));
app.post('/api/users/:id/reset-2fa', wrap((req, res) => {
  needAdmin(req);
  const u = users.find(req.params.id);
  if (!u) throw new UserError('User not found', 404);
  users.setTotp(u, null);
  audit(req, 'security', `2-step sign-in reset for "${u.user}"`);
  res.json({ ok: true });
}));
app.delete('/api/users/:id', wrap((req, res) => {
  needAdmin(req);
  if (req.params.id === req.user.id) throw new UserError('You can\'t remove yourself');
  const u = users.remove(req.params.id);
  sec.destroyUserSessions(u.id);
  audit(req, 'security', `User "${u.user}" removed`);
  res.json({ ok: true });
}));

// ---------- dashboard state (filtered to what this user may see) ----------
app.get('/api/state', (req, res) => {
  const db = store.db, me = req.user;
  const mySenders = db.senders.filter((s) => users.canUseSender(me, s.id));
  const senderIds = new Set(mySenders.map((s) => s.id));
  const mySheets = db.sheets.filter((h) => senderIds.has(h.senderId));
  const sheetIds = new Set(mySheets.map((h) => h.id));
  const log = store.recentLog(1000).filter((l) => users.isAdmin(me) || (l.level !== 'security' && ((l.senderId && senderIds.has(l.senderId)) || (l.sheetId && sheetIds.has(l.sheetId)))));
  res.json({
    me: users.publicUser(me),
    paused: db.settings.paused,
    pollSeconds: Number(db.settings.pollSeconds) || Number(process.env.POLL_SECONDS) || 15,
    serviceAccountEmail: users.canEdit(me) ? sheets.serviceAccountEmail() : null,
    defaultTemplates: DEFAULT_TEMPLATES,
    senders: mySenders.map((s) => {
      const st = senders.state(s.id);
      return { ...s, ...st, qr: users.isAdmin(me) ? st.qr : null, sentToday: engine.sentToday(s.id), inHours: engine.inHours(s) };  // only admins can link a phone
    }),
    sheets: mySheets.map((s) => ({ ...s, viaLabel: viaLabel(s.via), stats: engine.stats(s.id) })),
    log: log.slice(0, 150),
  });
});

app.post('/api/pause', wrap((req, res) => {
  needAdmin(req);
  store.db.settings.paused = !!req.body.paused;
  store.save();
  audit(req, 'info', store.db.settings.paused ? 'Sending paused' : 'Sending resumed');
  if (!store.db.settings.paused) engine.tick();
  res.json({ ok: true });
}));
app.post('/api/settings', wrap((req, res) => {
  needAdmin(req);
  if (req.body.pollSeconds !== undefined) store.db.settings.pollSeconds = num(req.body.pollSeconds, 15, 10, 600);
  store.save();
  res.json({ ok: true });
}));

// ---------- sending numbers ----------
function senderFields(b, prev = {}) {
  return {
    name: str(b.name ?? prev.name, 60, 'Name') || 'Sender',
    dailyLimit: num(b.dailyLimit, prev.dailyLimit ?? 30, 1, 500),
    minDelay: num(b.minDelay, prev.minDelay ?? 8, 2, 3600),
    maxDelay: num(b.maxDelay, prev.maxDelay ?? 20, 2, 3600),
    startHour: num(b.startHour, prev.startHour ?? 9, 0, 23),
    endHour: num(b.endHour, prev.endHour ?? 21, 0, 24),
  };
}
app.post('/api/senders', wrap((req, res) => {
  needAdmin(req);
  const s = { id: store.id('s'), ...senderFields(req.body) };
  store.db.senders.push(s); store.save();
  senders.start(s);
  audit(req, 'info', `Number "${s.name}" added. Scan its QR code to connect.`, { senderId: s.id });
  res.json(s);
}));
app.patch('/api/senders/:id', wrap((req, res) => {
  needAdmin(req);
  const s = senderFor(req, req.params.id);
  Object.assign(s, senderFields(req.body, s)); store.save();
  audit(req, 'info', `Settings changed for "${s.name}"`, { senderId: s.id });
  engine.kick(s.id);
  res.json(s);
}));
app.post('/api/senders/:id/reconnect', wrap(async (req, res) => {
  needAdmin(req);
  await senders.restart(senderFor(req, req.params.id));
  res.json({ ok: true });
}));
app.post('/api/senders/:id/logout', wrap(async (req, res) => {
  needAdmin(req);
  const s = senderFor(req, req.params.id);
  await senders.logout(s.id);
  audit(req, 'info', `${s.name} logged out of WhatsApp`, { senderId: s.id });
  senders.start(s);   // shows a fresh QR
  res.json({ ok: true });
}));
app.delete('/api/senders/:id', wrap(async (req, res) => {
  needAdmin(req);
  const s = senderFor(req, req.params.id);
  if (store.db.sheets.some((x) => x.senderId === s.id)) throw new UserError('Move or remove the sheets that use this number first');
  await senders.logout(s.id);
  store.db.senders = store.db.senders.filter((x) => x.id !== s.id); store.save();
  users.dropSender(s.id);
  audit(req, 'info', `Number "${s.name}" removed`);
  res.json({ ok: true });
}));
app.post('/api/senders/:id/test', sec.rateLimit({ windowMs: 60e3, max: 10 }), wrap(async (req, res) => {
  needEditor(req);
  const s = senderFor(req, req.params.id);
  const raw = str(req.body.phone, 200, 'Phone numbers').split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
  if (!raw.length) throw new UserError('Enter a phone number');
  if (raw.length > 5) throw new UserError('Test up to 5 numbers at a time');
  const phones = raw.map((p) => engine.normPhone(p, '91'));
  const bad = raw.filter((p, i) => !phones[i]);
  if (bad.length) throw new UserError(`Not a valid phone number: ${bad.join(', ')}`);
  const text = str(req.body.message, 4000, 'Message') || 'Test message ✅';
  const results = [];
  for (const [i, phone] of [...new Set(phones)].entries()) {
    if (i) await new Promise((r) => setTimeout(r, 3000));     // small gap between test messages
    let r;
    try { r = await senders.send(s.id, phone, text); } catch (e) { r = 'failed: ' + e.message; }
    if (r === 'sent') audit(req, 'sent', `Test message → +${phone}`, { senderId: s.id });
    results.push({ phone: '+' + phone, result: r === 'sent' ? 'sent' : r === 'not_on_whatsapp' ? 'not on WhatsApp' : r });
  }
  const failed = results.filter((x) => x.result !== 'sent');
  if (failed.length === results.length) throw new UserError(failed.map((x) => `${x.phone}: ${x.result}`).join(' · '));
  res.json({ ok: true, results });
}));

// ---------- connected Google accounts ----------
app.get('/api/google', wrap((req, res) => {
  needEditor(req);
  const names = Object.fromEntries(users.list().map((u) => [u.id, u.user]));
  const used = (id) => store.db.sheets.filter((h) => h.via === id).map((h) => h.name);
  res.json({
    configured: google.configured(),
    redirectUri: users.isAdmin(req.user) ? google.REDIRECT : null,
    accounts: google.usableBy(req.user).map((a) => ({ id: a.id, email: a.email, connectedBy: names[a.connectedBy] || 'removed user', createdAt: a.createdAt, sheets: used(a.id) })),
    serviceAccountEmail: sheets.serviceAccountEmail(),
  });
}));
app.delete('/api/google/:id', wrap(async (req, res) => {
  needEditor(req);
  const a = google.usableBy(req.user).find((x) => x.id === req.params.id);
  if (!a) throw new UserError('Google account not found', 404);
  await google.disconnect(a.id);
  const affected = store.db.sheets.filter((h) => h.via === a.id);
  for (const h of affected) { h.via = null; h.canWrite = false; }
  store.save();
  audit(req, 'security', `Google account ${a.email} disconnected${affected.length ? `; ${affected.length} sheet(s) need a new way in` : ''}`);
  res.json({ ok: true, affected: affected.map((h) => h.name) });
}));
// Browser navigations (not fetch), so answer with redirects back to the dashboard
app.get('/auth/google/start', (req, res) => {
  if (!users.canEdit(req.user)) return res.redirect('/?google_error=' + encodeURIComponent('You don\'t have access to do this'));
  if (!google.configured()) return res.redirect('/?google_error=' + encodeURIComponent('Google sign-in is not set up on the server yet (see README)'));
  res.redirect(google.startUrl(req.session.ref));
});
app.get('/auth/google/callback', sec.rateLimit({ windowMs: 60e3, max: 20 }), async (req, res) => {
  try {
    if (!users.canEdit(req.user)) throw new Error('You don\'t have access to do this');
    const q = req.query;
    const a = await google.finish(req.session.ref, { code: String(q.code || ''), state: String(q.state || ''), error: q.error && String(q.error) }, req.user.id);
    audit(req, 'security', `Google account ${a.email} connected`);
    res.redirect('/?google=' + encodeURIComponent(a.email));
  } catch (e) {
    res.redirect('/?google_error=' + encodeURIComponent(String(e.message || 'Google sign-in failed').slice(0, 200)));
  }
});

// ---------- sheets ----------
const canonicalUrl = (id, gid) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`;

function sheetFields(req, b, prev = {}) {
  const c = b.cols || prev.cols || {};
  const cols = { name: num(c.name, -1, -1, 200), phone: num(c.phone, -1, -1, 200), service: num(c.service, -1, -1, 200), status: num(c.status, -1, -1, 200) };
  if (cols.phone < 0) throw new UserError('Choose the phone number column');
  const senderId = b.senderId ?? prev.senderId;
  senderFor(req, senderId);                                      // must be a number this user may use
  const list = b.templates ?? prev.templates ?? DEFAULT_TEMPLATES;
  if (!Array.isArray(list) || list.length > 50) throw new UserError('Up to 50 services per sheet');
  const templates = list
    .map((t) => ({ service: str(t && t.service, 80, 'Service name'), message: str(t && t.message, 4000, 'Message') }))
    .filter((t) => t.service && t.message);
  return {
    name: str(b.name ?? prev.name, 80, 'Sheet name') || 'Sheet',
    senderId, cols, templates,
    countryCode: String(b.countryCode ?? prev.countryCode ?? '91').replace(/\D/g, '').slice(0, 4) || '91',
    enabled: typeof b.enabled === 'boolean' ? b.enabled : (prev.enabled ?? true),
  };
}

// How a sheet is opened, for display
function viaLabel(via) {
  if (!via) return 'public link';
  if (via === 'sa') return 'service account';
  const a = google.get(via);
  return a ? a.email : 'disconnected Google account';
}

app.post('/api/sheets/preview', wrap(async (req, res) => {
  needEditor(req);
  const { spreadsheetId, gid } = sheets.parseUrl(str(req.body.url, 500, 'Link'));
  const r = await sheets.open(spreadsheetId, gid, google.usableBy(req.user));
  if (!r.rows.length) throw new UserError('The sheet is empty. Add a header row first.');
  res.json({ headers: r.rows[0].map((h) => String(h).slice(0, 100)), rowCount: r.rows.length - 1, canWrite: r.canWrite, via: viaLabel(r.via) });
}));
app.post('/api/sheets', wrap(async (req, res) => {
  needEditor(req);
  const { spreadsheetId, gid } = sheets.parseUrl(str(req.body.url, 500, 'Link'));
  const fields = sheetFields(req, req.body);
  const opened = await sheets.open(spreadsheetId, gid, google.usableBy(req.user));
  const sheet = { id: store.id('h'), url: canonicalUrl(spreadsheetId, gid), spreadsheetId, gid, ...fields, via: opened.via, canWrite: opened.canWrite };
  if (!sheet.canWrite) sheet.cols.status = -1;
  store.db.sheets.push(sheet); store.save();
  if (!req.body.sendExisting) {
    await engine.checkSheet(sheet, { baselineOnly: true });
    audit(req, 'info', `Sheet "${sheet.name}" added (via ${viaLabel(sheet.via)}). ${sheet.rowCount} existing row(s) skipped; only new rows get messages.`, { sheetId: sheet.id });
  } else {
    audit(req, 'info', `Sheet "${sheet.name}" added (via ${viaLabel(sheet.via)}). Existing rows will get messages too.`, { sheetId: sheet.id });
    engine.checkSheet(sheet).catch(() => {});
  }
  res.json(sheet);
}));
app.patch('/api/sheets/:id', wrap(async (req, res) => {
  needEditor(req);
  const s = sheetFor(req, req.params.id);
  const oldSender = s.senderId;
  const next = sheetFields(req, req.body, s);                    // validate before changing anything
  let target = { spreadsheetId: s.spreadsheetId, gid: s.gid };
  if (req.body.url) target = sheets.parseUrl(str(req.body.url, 500, 'Link'));
  const moved = target.spreadsheetId !== s.spreadsheetId || String(target.gid) !== String(s.gid);
  const lostAccess = !s.via || (s.via !== 'sa' && !google.get(s.via));
  if (moved || lostAccess) {                                     // find a way in again with this user's own access
    const opened = await sheets.open(target.spreadsheetId, target.gid, google.usableBy(req.user));
    Object.assign(s, target, { url: canonicalUrl(target.spreadsheetId, target.gid), via: opened.via, canWrite: opened.canWrite });
  }
  Object.assign(s, next);
  if (!s.canWrite) s.cols.status = -1;
  if (oldSender !== s.senderId) engine.forgetSheet(s.id);
  store.save();
  audit(req, 'info', `Sheet "${s.name}" ${typeof req.body.enabled === 'boolean' && Object.keys(req.body).length === 1 ? (s.enabled ? 'turned on' : 'turned off') : 'updated'}`, { sheetId: s.id });
  res.json(s);
}));
app.post('/api/sheets/:id/check', wrap(async (req, res) => {
  needEditor(req);
  res.json(await engine.checkSheet(sheetFor(req, req.params.id)));
}));
app.delete('/api/sheets/:id', wrap((req, res) => {
  needEditor(req);
  const s = sheetFor(req, req.params.id);
  engine.forgetSheet(s.id);
  store.db.sheets = store.db.sheets.filter((x) => x.id !== s.id); store.save();
  audit(req, 'info', `Sheet "${s.name}" removed`);
  res.json({ ok: true });
}));

// ---------- errors ----------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {        // bad JSON, body too large, etc. — never leak stack traces
  if (err.status === 404 || err.statusCode === 404) return res.status(404).json({ error: 'Not found' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Dashboard running on http://${HOST}:${PORT}`);
  for (const s of store.db.senders) senders.start(s);
  engine.startLoop();
});
server.headersTimeout = 30000;
server.requestTimeout = 60000;

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));
let stopping = false;
async function shutdown(sig) {
  if (stopping) return; stopping = true;
  console.log(`${sig} received, closing WhatsApp sessions…`);
  server.close();
  await Promise.race([Promise.all(store.db.senders.map((s) => senders.stop(s.id))), new Promise((r) => setTimeout(r, 8000))]);
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
