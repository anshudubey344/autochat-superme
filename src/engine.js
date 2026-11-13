// Finds new rows in every sheet and sends the matching service message from the sheet's sender.
const store = require('./store');
const senders = require('./senders');
const sheets = require('./sheets');

const queues = new Map();       // senderId -> [job]
const queued = new Set();       // dedupe keys currently waiting
const busy = new Set();         // senderIds whose worker is running
const failures = new Map();     // key -> attempts
const sheetErrors = new Map();  // sheetId -> last read error
const rowNotes = new Map();     // sheetId|row -> [service results] for write-back

const TZ = process.env.TZ || 'Asia/Kolkata';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const hourNow = () => Number(new Date().toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false })) % 24;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normPhone(raw, cc) {
  const s = clean(raw);
  if (!s) return null;
  // "p:+447967020639" (Meta lead ads), "+44 7967 020639", "447967020639", "07967 020639" …
  const plus = s.includes('+');
  let d = (plus ? s.slice(s.indexOf('+')) : s).replace(/\D/g, '');
  if (!plus) {
    if (d.startsWith('00')) d = d.slice(2);
    else { d = d.replace(/^0+/, ''); if (d.length <= 10) d = String(cc || '91') + d; }
  }
  return d.length >= 11 && d.length <= 15 ? d : null;
}

// Cell text without invisible characters
function clean(v) { return String(v ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim(); }
// "1:1_private_yoga" and "1:1 Private Yoga" are the same service
const normSvc = (v) => clean(v).replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[,;\s]+|[,;\s]+$/g, '').toLowerCase();
const pretty = (v) => clean(v).replace(/_+/g, ' ').replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();

function exactTemplate(sheet, service) {
  const n = normSvc(service);
  return (sheet.templates || []).find((x) => normSvc(x.service) === n);
}
function findTemplate(sheet, service) {
  return exactTemplate(sheet, service) || (sheet.templates || []).find((x) => normSvc(x.service) === 'default');
}
// One cell can list several services ("Therapy, 1:1 Yoga"). A value that itself contains a comma
// ("not_sure_yet,_help_me_choose") stays one service unless every part is a known message.
function splitServices(sheet, v) {
  const whole = pretty(v);
  if (!whole) return [];
  if (exactTemplate(sheet, whole)) return [whole];
  const parts = whole.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every((x) => exactTemplate(sheet, x))) return parts;
  return [whole];
}
const keyOf = (senderId, phone, service) => `${senderId}|${phone}|${normSvc(service)}`;

function fill(message, name, service) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const label = service === 'Default' ? 'our services' : service;
  return message.replace(/\{name\}/gi, first).replace(/\{service\}/gi, label);
}

// "Ticked" = the cell has something in it, except an explicit no (unticked checkbox = FALSE)
const NOT_TICKED = /^(false|no|n|0|nahi|nahin|na|none|-|❌|✗|☐)$/i;
const ticked = (v) => { const t = clean(v); return t !== '' && !NOT_TICKED.test(t); };
const pendingCounts = new Map();   // sheetId -> rows waiting for your OK (review mode)

// Turn sheet rows into candidate messages.
//   baselineOnly: mark everything as already handled (no sending)
//   dry: no side effects (used for the review list); rows without a matching message get tplMissing
function collect(sheet, rows, { baselineOnly = false, dry = false } = {}) {
  const jobs = [], baseline = [];
  const c = sheet.cols;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (c.send >= 0 && !ticked(r[c.send])) continue;                                      // only ticked / filled rows
    const rowCc = c.cc >= 0 ? String(r[c.cc] || '').replace(/\D/g, '').slice(0, 4) : '';   // per-row country code column
    const phone = normPhone(r[c.phone], rowCc || sheet.countryCode);
    if (!phone) continue;
    let services = c.service >= 0 ? splitServices(sheet, r[c.service]) : [];
    if (!services.length) services = ['Default'];
    for (const service of services) {
      const key = keyOf(sheet.senderId, phone, service);
      if (queued.has(key) || store.sent.has(key)) continue;
      if (baselineOnly) {
        baseline.push([key, { status: 'skipped_existing', sheetId: sheet.id, row: i + 1 }]);
        continue;
      }
      const tpl = findTemplate(sheet, service);
      if (!tpl && !dry) {
        store.sent.put(key, { status: 'no_template', sheetId: sheet.id, row: i + 1 });
        store.log('warn', `${sheet.name}: no message for "${service}" (row ${i + 1}). Add it in the sheet's messages.`, { sheetId: sheet.id });
        continue;
      }
      jobs.push({ key, sheetId: sheet.id, senderId: sheet.senderId, row: i + 1, phone, name: clean(r[c.name]), service,
        tplMissing: !tpl, text: tpl ? fill(tpl.message, r[c.name], service) : null });
    }
  }
  if (baseline.length) store.sent.putMany(baseline);
  return jobs;
}

function enqueue(jobs) {
  for (const j of jobs) {
    queued.add(j.key);
    if (!queues.has(j.senderId)) queues.set(j.senderId, []);
    queues.get(j.senderId).push(j);
  }
  new Set(jobs.map((j) => j.senderId)).forEach((id) => kick(id));
}

async function read(sheet) {
  try {
    const rows = await sheets.readRows(sheet);
    sheetErrors.delete(sheet.id);
    sheet.lastChecked = new Date().toISOString();
    sheet.rowCount = Math.max(0, rows.length - 1);
    store.save();
    return rows;
  } catch (e) {
    sheetErrors.set(sheet.id, e.message);
    throw e;
  }
}

// Automatic sheets: queue new rows. Review sheets: only count what's waiting for your OK.
async function checkSheet(sheet, { baselineOnly = false } = {}) {
  const rows = await read(sheet);
  if (baselineOnly) { collect(sheet, rows, { baselineOnly: true }); return { queued: 0 }; }
  if (sheet.mode !== 'auto') {
    const pending = collect(sheet, rows, { dry: true }).length;
    pendingCounts.set(sheet.id, pending);
    return { pending };
  }
  const jobs = collect(sheet, rows);
  if (jobs.length) store.log('info', `${sheet.name}: ${jobs.length} new message(s) queued`, { sheetId: sheet.id });
  enqueue(jobs);
  return { queued: jobs.length };
}

// ---- review mode: you pick who gets which message ----
async function pending(sheet) {
  const rows = await read(sheet);
  const list = collect(sheet, rows, { dry: true });
  pendingCounts.set(sheet.id, list.length);
  return list;
}

// items: [{ row, phone, from, service }] — `from` is the message type it was listed under, `service` the one you picked
async function approve(sheet, items, by) {
  const list = await pending(sheet);
  const jobs = [], problems = [];
  for (const it of items) {
    const p = list.find((x) => x.row === Number(it.row) && x.phone === String(it.phone) && normSvc(x.service) === normSvc(it.from));
    if (!p) { problems.push(`row ${it.row}: already handled or changed in the sheet`); continue; }
    const service = String(it.service || p.service);
    const tpl = exactTemplate(sheet, service);
    if (!tpl) { problems.push(`row ${it.row}: no message called "${service}"`); continue; }
    const key = keyOf(sheet.senderId, p.phone, p.service);                 // what the sheet asked for → never offered again
    const sendKey = keyOf(sheet.senderId, p.phone, service);
    if (sendKey !== key && (queued.has(sendKey) || store.sent.has(sendKey))) {
      store.sent.put(key, { status: 'skipped_manual', sheetId: sheet.id, row: p.row });
      problems.push(`row ${it.row}: "${service}" was already sent to this number`); continue;
    }
    if (sendKey !== key) store.sent.put(key, { status: 'replaced', sheetId: sheet.id, row: p.row });
    jobs.push({ ...p, key: sendKey, service, text: fill(tpl.message, p.name, service), manual: true });
  }
  if (jobs.length) store.log('info', `${sheet.name}: ${jobs.length} message(s) approved${by ? ` (by ${by})` : ''}`, { sheetId: sheet.id });
  enqueue(jobs);
  pendingCounts.set(sheet.id, Math.max(0, (pendingCounts.get(sheet.id) || 0) - items.length));
  return { queued: jobs.length, problems };
}

async function skip(sheet, items, by) {
  const list = await pending(sheet);
  const marks = [];
  for (const it of items) {
    const p = list.find((x) => x.row === Number(it.row) && x.phone === String(it.phone) && normSvc(x.service) === normSvc(it.from));
    if (p) marks.push([p.key, { status: 'skipped_manual', sheetId: sheet.id, row: p.row }]);
  }
  store.sent.putMany(marks);
  if (marks.length) store.log('info', `${sheet.name}: ${marks.length} row(s) marked "don't send"${by ? ` (by ${by})` : ''}`, { sheetId: sheet.id });
  pendingCounts.set(sheet.id, Math.max(0, (pendingCounts.get(sheet.id) || 0) - marks.length));
  return { skipped: marks.length };
}

async function tick() {
  if (store.db.settings.paused) return;
  for (const sheet of store.db.sheets) {
    if (!sheet.enabled) continue;
    try { await checkSheet(sheet); } catch (_) { /* shown on the sheet card */ }
  }
  for (const id of queues.keys()) kick(id);
}

function sentToday(senderId) {
  return store.daily.get(senderId, today());
}

function inHours(sender) {
  const s = Number(sender.startHour ?? 9), e = Number(sender.endHour ?? 21), h = hourNow();
  return s === e ? true : s < e ? h >= s && h < e : h >= s || h < e;
}

async function kick(senderId) {
  if (busy.has(senderId)) return;
  busy.add(senderId);
  try {
    const q = queues.get(senderId) || [];
    while (q.length) {
      const sender = store.db.senders.find((s) => s.id === senderId);
      if (!sender) { q.forEach((j) => queued.delete(j.key)); q.length = 0; break; }
      if (store.db.settings.paused || !senders.isReady(senderId) || !inHours(sender)) break;
      if (sentToday(senderId) >= Number(sender.dailyLimit || 30)) break;

      // next job whose sheet is running (approved-by-hand jobs always go)
      const idx = q.findIndex((j) => j.manual || (store.db.sheets.find((s) => s.id === j.sheetId) || {}).enabled);
      if (idx < 0) break;
      const [job] = q.splice(idx, 1);
      const sheet = store.db.sheets.find((s) => s.id === job.sheetId);
      let result;
      try {
        result = await senders.send(senderId, job.phone, job.text);
      } catch (e) {
        if (!senders.isReady(senderId)) { q.unshift(job); break; }   // number dropped; resume when it reconnects
        const n = (failures.get(job.key) || 0) + 1;
        failures.set(job.key, n);
        if (n < 3) { q.push(job); store.log('warn', `+${job.phone} (${job.service}) failed, will retry: ${e.message}`, { sheetId: job.sheetId }); }
        else { result = 'failed'; store.log('error', `+${job.phone} (${job.service}) failed 3 times: ${e.message}`, { sheetId: job.sheetId }); }
        if (!result) { await sleep(10000); continue; }
      }
      queued.delete(job.key);
      failures.delete(job.key);
      store.sent.put(job.key, { status: result, sheetId: job.sheetId, row: job.row });

      if (result === 'sent') {
        store.daily.inc(senderId, today());
        store.log('sent', `${job.service} → ${job.name || '+' + job.phone} (+${job.phone})`, { sheetId: job.sheetId, senderId });
      } else if (result === 'not_on_whatsapp') {
        store.log('warn', `+${job.phone} is not on WhatsApp (${sheet ? sheet.name : ''} row ${job.row})`, { sheetId: job.sheetId });
      }
      store.save();
      if (sheet) writeBack(sheet, job, result).catch((e) => store.log('warn', `${sheet.name}: could not write status to row ${job.row}: ${e.message}`, { sheetId: sheet.id }));

      if (q.some((j) => j.manual || (store.db.sheets.find((s) => s.id === j.sheetId) || {}).enabled)) {
        const min = Number(sender.minDelay || 8), max = Math.max(min, Number(sender.maxDelay || 20));
        await sleep((min + Math.random() * (max - min)) * 1000);
      }
    }
  } finally {
    busy.delete(senderId);
  }
}

async function writeBack(sheet, job, result) {
  if (!(sheet.cols.status >= 0) || !sheet.via) return;
  const k = sheet.id + '|' + job.row;
  const notes = rowNotes.get(k) || [];
  const label = result === 'sent' ? `Sent: ${job.service}` : result === 'not_on_whatsapp' ? 'Not on WhatsApp' : `Failed: ${job.service}`;
  if (!notes.includes(label)) notes.push(label);
  rowNotes.set(k, notes);
  const when = new Date().toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  await sheets.writeCell(sheet, sheet.cols.status, job.row, `${notes.join(', ')} · ${when}`);
}

function stats(sheetId) {
  const c = store.sent.stats(sheetId);
  const sent = c.sent || 0, notOn = c.not_on_whatsapp || 0, failed = (c.failed || 0) + (c.no_template || 0);
  const skipped = (c.skipped_existing || 0) + (c.skipped_manual || 0);
  const waiting = [...queues.values()].flat().filter((j) => j.sheetId === sheetId).length;
  return { sent, notOn, failed, skipped, waiting, review: pendingCounts.get(sheetId) ?? null, error: sheetErrors.get(sheetId) || null };
}

function forgetSheet(sheetId) {
  for (const q of queues.values()) {
    for (let i = q.length - 1; i >= 0; i--) if (q[i].sheetId === sheetId) { queued.delete(q[i].key); q.splice(i, 1); }
  }
}

function startLoop() {
  const loop = async () => {
    try { await tick(); } catch (e) { console.error('tick failed', e); }
    const every = Math.max(10, Number(store.db.settings.pollSeconds) || Number(process.env.POLL_SECONDS) || 15);
    setTimeout(loop, every * 1000);
  };
  setTimeout(loop, 5000);
  setInterval(() => { for (const id of queues.keys()) kick(id); }, 30000); // resume after hours/limits/reconnect
}

module.exports = { normSvc, pretty, startLoop, checkSheet, pending, approve, skip, stats, sentToday, inHours, forgetSheet, normPhone, kick, tick, _collect: collect };
