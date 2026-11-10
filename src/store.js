// SQLite storage (built into Node 22.13+). Everything lives in data/app.db.
// Small config (numbers, sheets, settings) is cached in memory and written through on save();
// growing data (who was messaged, daily counts, activity log, users) is read and written with SQL.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const emitWarning = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...a));
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const FILE = path.join(DATA_DIR, 'app.db');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch (_) {}

const sql = new DatabaseSync(FILE);
sql.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS meta     (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS senders (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, daily_limit INTEGER NOT NULL, min_delay REAL NOT NULL, max_delay REAL NOT NULL,
    start_hour INTEGER NOT NULL, end_hour INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sheets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, spreadsheet_id TEXT NOT NULL, gid TEXT NOT NULL,
    sender_id TEXT NOT NULL, cols TEXT NOT NULL, templates TEXT NOT NULL, country_code TEXT NOT NULL,
    enabled INTEGER NOT NULL, can_write INTEGER NOT NULL DEFAULT 0, last_checked TEXT, row_count INTEGER, position INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sent (
    key TEXT PRIMARY KEY, sender_id TEXT, phone TEXT, service TEXT, status TEXT NOT NULL,
    sheet_id TEXT, row INTEGER, at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sent_sheet ON sent(sheet_id, status);
  CREATE TABLE IF NOT EXISTS daily (sender_id TEXT NOT NULL, date TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (sender_id, date));
  CREATE TABLE IF NOT EXISTS log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL,
    sender_id TEXT, sheet_id TEXT, by_user TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, user TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL CHECK (role IN ('admin','manager','viewer')),
    salt TEXT NOT NULL, hash TEXT NOT NULL, totp_secret TEXT, all_senders INTEGER NOT NULL DEFAULT 0, sender_ids TEXT NOT NULL DEFAULT '[]',
    disabled INTEGER NOT NULL DEFAULT 0, must_change INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, last_login TEXT, password_changed_at TEXT
  );
`);
sql.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')").run();
// v2: how each sheet is opened (connected Google account id, 'sa' = service account, NULL = public link)
if (!sql.prepare('PRAGMA table_info(sheets)').all().some((c) => c.name === 'via')) {
  sql.exec("ALTER TABLE sheets ADD COLUMN via TEXT; UPDATE sheets SET via = CASE WHEN can_write = 1 THEN 'sa' END;");
  sql.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
}
for (const f of [FILE, FILE + '-wal', FILE + '-shm']) { try { fs.chmodSync(f, 0o600); } catch (_) {} }

function tx(fn) {
  sql.exec('BEGIN IMMEDIATE');
  try { const r = fn(); sql.exec('COMMIT'); return r; } catch (e) { sql.exec('ROLLBACK'); throw e; }
}

// ---------- config cache (numbers, sheets, settings) ----------
const toSender = (r) => ({ id: r.id, name: r.name, dailyLimit: r.daily_limit, minDelay: r.min_delay, maxDelay: r.max_delay, startHour: r.start_hour, endHour: r.end_hour });
const toSheet = (r) => ({
  id: r.id, name: r.name, url: r.url, spreadsheetId: r.spreadsheet_id, gid: r.gid, senderId: r.sender_id,
  cols: JSON.parse(r.cols), templates: JSON.parse(r.templates), countryCode: r.country_code,
  enabled: !!r.enabled, canWrite: !!r.can_write, lastChecked: r.last_checked, rowCount: r.row_count, via: r.via || null,
});
const cfg = {
  settings: Object.fromEntries(sql.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)])),
  senders: sql.prepare('SELECT * FROM senders ORDER BY position').all().map(toSender),
  sheets: sql.prepare('SELECT * FROM sheets ORDER BY position').all().map(toSheet),
};
if (cfg.settings.paused === undefined) cfg.settings.paused = false;

let timer = null;
function flush() {
  clearTimeout(timer); timer = null;
  tx(() => {
    sql.exec('DELETE FROM settings; DELETE FROM senders; DELETE FROM sheets;');
    const st = sql.prepare('INSERT INTO settings(key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(cfg.settings)) st.run(k, JSON.stringify(v));
    const ss = sql.prepare('INSERT INTO senders VALUES (?,?,?,?,?,?,?,?)');
    cfg.senders.forEach((s, i) => ss.run(s.id, s.name, s.dailyLimit, s.minDelay, s.maxDelay, s.startHour, s.endHour, i));
    const sh = sql.prepare(`INSERT INTO sheets(id, name, url, spreadsheet_id, gid, sender_id, cols, templates, country_code, enabled, can_write, last_checked, row_count, position, via)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    cfg.sheets.forEach((h, i) => sh.run(h.id, h.name, h.url, h.spreadsheetId, String(h.gid), h.senderId, JSON.stringify(h.cols),
      JSON.stringify(h.templates || []), h.countryCode, h.enabled ? 1 : 0, h.canWrite ? 1 : 0, h.lastChecked || null, h.rowCount ?? null, i, h.via || null));
  });
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => { try { flush(); } catch (e) { console.error('Could not save settings:', e.message); } }, 200);
}

// ---------- who was messaged (never send twice) ----------
const qSentGet = sql.prepare('SELECT status FROM sent WHERE key = ?');
const qSentPut = sql.prepare(`INSERT INTO sent(key, sender_id, phone, service, status, sheet_id, row, at) VALUES (?,?,?,?,?,?,?,?)
  ON CONFLICT(key) DO UPDATE SET status = excluded.status, sheet_id = excluded.sheet_id, row = excluded.row, at = excluded.at`);
const qSentStats = sql.prepare('SELECT status, COUNT(*) n FROM sent WHERE sheet_id = ? GROUP BY status');
const sent = {
  has: (key) => !!qSentGet.get(key),
  put(key, { status, sheetId, row }) {
    const [senderId, phone, ...svc] = key.split('|');
    qSentPut.run(key, senderId, phone, svc.join('|'), status, sheetId || null, row ?? null, new Date().toISOString());
  },
  putMany(items) { tx(() => items.forEach(([k, v]) => sent.put(k, v))); },
  stats: (sheetId) => Object.fromEntries(qSentStats.all(sheetId).map((r) => [r.status, r.n])),
};

// ---------- per-number daily count ----------
const qDailyGet = sql.prepare('SELECT count FROM daily WHERE sender_id = ? AND date = ?');
const qDailyInc = sql.prepare('INSERT INTO daily(sender_id, date, count) VALUES (?, ?, 1) ON CONFLICT(sender_id, date) DO UPDATE SET count = count + 1');
const daily = {
  get: (senderId, date) => (qDailyGet.get(senderId, date) || { count: 0 }).count,
  inc: (senderId, date) => qDailyInc.run(senderId, date),
};

// ---------- activity log ----------
// Phone numbers are personal data: keep them out of the server's console output.
const mask = (t) => String(t).replace(/\+?\d[\d ]{8,16}\d/g, (m) => { const d = m.replace(/\D/g, ''); return '+' + d.slice(0, 2) + '•••••' + d.slice(-3); });
const qLogPut = sql.prepare('INSERT INTO log(at, level, text, sender_id, sheet_id, by_user) VALUES (?,?,?,?,?,?)');
const qLogRecent = sql.prepare('SELECT at, level, text, sender_id AS senderId, sheet_id AS sheetId, by_user AS byUser FROM log ORDER BY id DESC LIMIT ?');
let logWrites = 0;
function log(level, text, extra = {}) {
  qLogPut.run(new Date().toISOString(), level, String(text), extra.senderId || null, extra.sheetId || null, extra.by || null);
  console.log(`[${level}] ${mask(text)}`);
  if (++logWrites % 500 === 0) {   // keep ~90 days of activity
    sql.prepare('DELETE FROM log WHERE at < ?').run(new Date(Date.now() - 90 * 864e5).toISOString());
  }
}
const recentLog = (limit = 500) => qLogRecent.all(limit);

// ---------- daily backups (data/backups, last 14 kept) ----------
function backup() {
  const out = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = path.join(out, `app-${new Date().toISOString().slice(0, 10)}.db`);
  try { fs.unlinkSync(file); } catch (_) {}
  sql.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600);
  const old = fs.readdirSync(out).filter((f) => /^app-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14);
  for (const f of old) fs.unlinkSync(path.join(out, f));
}
const runBackup = () => { try { backup(); } catch (e) { console.error('Backup failed:', e.message); } };
setTimeout(runBackup, 60e3).unref();
setInterval(runBackup, 24 * 3600e3).unref();

// ---------- one-time import from the old JSON file ----------
(function migrateJson() {
  const old = path.join(DATA_DIR, 'db.json');
  if (!fs.existsSync(old) || cfg.senders.length || cfg.sheets.length) return;
  let d;
  try { d = JSON.parse(fs.readFileSync(old, 'utf8')); } catch (e) { console.error('Old db.json could not be read for import:', e.message); return; }
  Object.assign(cfg.settings, d.settings || {});
  cfg.senders = d.senders || []; cfg.sheets = (d.sheets || []).map((h) => ({ ...h, via: h.canWrite ? 'sa' : null }));
  flush();
  sent.putMany(Object.entries(d.sent || {}));
  tx(() => {
    for (const [sid, v] of Object.entries(d.daily || {})) sql.prepare('INSERT OR REPLACE INTO daily VALUES (?,?,?)').run(sid, v.date, v.count);
    for (const l of (d.log || []).slice().reverse()) qLogPut.run(l.at, l.level, l.text, l.senderId || null, l.sheetId || null, null);
  });
  fs.renameSync(old, old + '.imported');
  console.log('Imported old db.json into data/app.db');
})();

const id = (p) => p + crypto.randomBytes(6).toString('hex');
function close() { try { flush(); sql.close(); } catch (_) {} }

module.exports = { get db() { return cfg; }, sql, tx, save, flush, close, sent, daily, log, recentLog, backup, id, DATA_DIR };
