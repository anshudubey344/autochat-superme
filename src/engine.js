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
  const s = String(raw || '').trim();
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  if (!s.startsWith('+')) {
    if (d.startsWith('00')) d = d.slice(2);
    else { d = d.replace(/^0+/, ''); if (d.length <= 10) d = String(cc || '91') + d; }
  }
  return d.length >= 11 && d.length <= 15 ? d : null;
}

const splitServices = (v) => String(v || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
const keyOf = (senderId, phone, service) => `${senderId}|${phone}|${service.toLowerCase()}`;

function findTemplate(sheet, service) {
  const t = sheet.templates || [];
  return t.find((x) => x.service.trim().toLowerCase() === service.toLowerCase())
      || t.find((x) => x.service.trim().toLowerCase() === 'default');
}

function fill(message, name, service) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  const label = service === 'Default' ? 'our services' : service;
  return message.replace(/\{name\}/gi, first).replace(/\{service\}/gi, label);
}

// Turn sheet rows into jobs. baselineOnly = mark everything as already handled (no sending).
function collect(sheet, rows, baselineOnly) {
  const jobs = [], baseline = [];
  const c = sheet.cols;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const phone = normPhone(r[c.phone], sheet.countryCode);
    if (!phone) continue;
    let services = c.service >= 0 ? splitServices(r[c.service]) : [];
    if (!services.length) services = ['Default'];
    for (const service of services) {
      const key = keyOf(sheet.senderId, phone, service);
      if (queued.has(key) || store.sent.has(key)) continue;
      if (baselineOnly) {
        baseline.push([key, { status: 'skipped_existing', sheetId: sheet.id, row: i + 1 }]);
        continue;
      }
      const tpl = findTemplate(sheet, service);
      if (!tpl) {
        store.sent.put(key, { status: 'no_template', sheetId: sheet.id, row: i + 1 });
        store.log('warn', `${sheet.name}: no message for "${service}" (row ${i + 1}). Add it in the sheet's messages.`, { sheetId: sheet.id });
        continue;
      }
      jobs.push({ key, sheetId: sheet.id, senderId: sheet.senderId, row: i + 1, phone, name: r[c.name] || '', service, text: fill(tpl.message, r[c.name], service) });
    }
  }
  if (baseline.length) store.sent.putMany(baseline);
  return jobs;
}

async function checkSheet(sheet, { baselineOnly = false } = {}) {
  try {
    const rows = await sheets.readRows(sheet);
    sheetErrors.delete(sheet.id);
    sheet.lastChecked = new Date().toISOString();
    sheet.rowCount = Math.max(0, rows.length - 1);
    store.save();
    const jobs = collect(sheet, rows, baselineOnly);
    for (const j of jobs) {
      queued.add(j.key);
      if (!queues.has(j.senderId)) queues.set(j.senderId, []);
      queues.get(j.senderId).push(j);
    }
    if (jobs.length) store.log('info', `${sheet.name}: ${jobs.length} new message(s) queued`, { sheetId: sheet.id });
    jobs.length && kick(sheet.senderId);
    return { queued: jobs.length };
  } catch (e) {
    sheetErrors.set(sheet.id, e.message);
    throw e;
  }
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

      const job = q.shift();
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

      if (q.length) {
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
  const sent = c.sent || 0, notOn = c.not_on_whatsapp || 0, failed = (c.failed || 0) + (c.no_template || 0), skipped = c.skipped_existing || 0;
  const waiting = [...queues.values()].flat().filter((j) => j.sheetId === sheetId).length;
  return { sent, notOn, failed, skipped, waiting, error: sheetErrors.get(sheetId) || null };
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

module.exports = { startLoop, checkSheet, stats, sentToday, inHours, forgetSheet, normPhone, kick, tick, _collect: collect };
