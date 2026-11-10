// Reads rows from Google Sheets and writes status back.
// Ways in, tried in this order:
//   1. a connected Google account (no sharing needed, can write status)
//   2. the service account in GOOGLE_KEY_FILE (sheet shared with it, can write status)
//   3. a public "Anyone with the link" sheet (read only)
const fs = require('fs');
const path = require('path');
const google = require('./google');

let sa = null, saEmail = null;
const keyFile = process.env.GOOGLE_KEY_FILE ? path.resolve(process.env.GOOGLE_KEY_FILE) : null;
if (keyFile && fs.existsSync(keyFile)) {
  try {
    const { GoogleAuth } = require('google-auth-library');
    saEmail = JSON.parse(fs.readFileSync(keyFile, 'utf8')).client_email;
    sa = new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  } catch (e) {
    console.error('Google key file could not be loaded:', e.message);
  }
}

function parseUrl(url) {
  const m = String(url).match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/);
  if (!m) throw new Error('Paste a Google Sheets link (https://docs.google.com/spreadsheets/d/…)');
  const g = String(url).match(/[#&?]gid=(\d+)/);
  return { spreadsheetId: m[1], gid: g ? g[1] : '0' };
}

// via = connected Google account id, or 'sa' for the service account
async function api(via, method, url, body) {
  if (via === 'sa') { const c = await sa.getClient(); return (await c.request({ method, url, data: body })).data; }
  return google.request(via, { method, url, data: body });
}

const titleCache = new Map();
async function tabTitle(via, spreadsheetId, gid) {
  const key = `${via}:${spreadsheetId}:${gid}`;
  if (titleCache.has(key)) return titleCache.get(key);
  const data = await api(via, 'GET', `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`);
  const tab = data.sheets.find((s) => String(s.properties.sheetId) === String(gid)) || data.sheets[0];
  titleCache.set(key, tab.properties.title);
  return tab.properties.title;
}

async function readVia(via, spreadsheetId, gid) {
  const title = await tabTitle(via, spreadsheetId, gid);
  const data = await api(via, 'GET', `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${title}'`)}`);
  return data.values || [];
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function readPublic(spreadsheetId, gid) {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`, { redirect: 'follow' });
  const text = await res.text();
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) return null;
  return parseCsv(text);
}

const statusOf = (e) => e && e.response && e.response.status;

// Find a way to open a new sheet. `accounts` = connected Google accounts this user may use.
async function open(spreadsheetId, gid, accounts) {
  for (const a of accounts) {
    try { return { rows: await readVia(a.id, spreadsheetId, gid), via: a.id, canWrite: true }; }
    catch (e) { if (![403, 404].includes(statusOf(e))) throw friendly(e); }
  }
  if (sa) {
    try { return { rows: await readVia('sa', spreadsheetId, gid), via: 'sa', canWrite: true }; }
    catch (e) { if (![403, 404].includes(statusOf(e))) throw friendly(e); }
  }
  const rows = await readPublic(spreadsheetId, gid);
  if (rows) return { rows, via: null, canWrite: false };
  const ways = [];
  if (accounts.length) ways.push(`open it with ${accounts.map((a) => a.email).join(' or ')}`);
  else if (google.configured()) ways.push('connect the Google account that owns it (Google accounts button)');
  if (saEmail) ways.push(`share it with ${saEmail}`);
  ways.push('set it to "Anyone with the link → Viewer"');
  throw new Error(`Can't open this sheet. To fix: ${ways.join(', or ')}.`);
}

function friendly(e) {
  const msg = (e.response && e.response.data && e.response.data.error && (e.response.data.error.message || e.response.data.error_description)) || e.message;
  if (/invalid_grant/i.test(msg)) return new Error('Google access was removed or expired. Connect the Google account again.');
  return new Error('Google Sheets: ' + msg);
}

// Rows of a saved sheet (row[0] = header). Row number in the sheet = index + 1.
async function readRows(sheet) {
  if (sheet.via) {
    try { return await readVia(sheet.via, sheet.spreadsheetId, sheet.gid); }
    catch (e) { throw friendly(e); }
  }
  const rows = await readPublic(sheet.spreadsheetId, sheet.gid);
  if (!rows) throw new Error('Can\'t open this sheet any more. Set it to "Anyone with the link → Viewer", or edit the sheet here and connect a Google account.');
  return rows;
}

function colLetter(i) {
  let s = ''; i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

async function writeCell(sheet, colIndex, rowNumber, value) {
  if (!sheet.via) return;
  const title = await tabTitle(sheet.via, sheet.spreadsheetId, sheet.gid);
  const range = `'${title}'!${colLetter(colIndex)}${rowNumber}`;
  try {
    await api(sheet.via, 'PUT', `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values: [[value]] });
  } catch (e) { throw friendly(e); }
}

module.exports = { parseUrl, open, readRows, writeCell, colLetter, serviceAccountEmail: () => saEmail };
