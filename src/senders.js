// Manages one logged-in WhatsApp Web session per sender number.
const path = require('path');
const fs = require('fs');
const QR = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const store = require('./store');

const AUTH_DIR = path.join(store.DATA_DIR, 'wa-auth');
fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
const live = new Map();   // senderId -> {client, status, qr, me, error, retryTimer}

function state(id) {
  const s = live.get(id);
  if (!s) return { status: 'stopped' };
  return { status: s.status, qr: s.qr, me: s.me, error: s.error };
}

function start(sender) {
  if (live.has(sender.id)) return;
  const s = { status: 'starting', qr: null, me: null, error: null, client: null };
  live.set(sender.id, s);

  const puppeteer = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.CHROME_PATH) puppeteer.executablePath = process.env.CHROME_PATH;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sender.id, dataPath: AUTH_DIR }),
    puppeteer,
  });
  s.client = client;

  client.on('qr', async (qr) => {
    s.status = 'qr';
    s.qr = await QR.toDataURL(qr, { margin: 1, width: 260 });
  });
  client.on('authenticated', () => { s.status = 'connecting'; s.qr = null; });
  client.on('ready', () => {
    s.status = 'ready'; s.qr = null; s.error = null;
    s.me = client.info && client.info.wid ? client.info.wid.user : null;
    store.log('info', `${sender.name} connected${s.me ? ' as +' + s.me : ''}`, { senderId: sender.id });
  });
  client.on('auth_failure', (m) => { s.status = 'error'; s.error = 'Login failed: ' + m; });
  client.on('disconnected', async (reason) => {
    store.log('warn', `${sender.name} disconnected (${reason})`, { senderId: sender.id });
    await stop(sender.id);
    if (reason === 'LOGOUT') {
      wipeAuth(sender.id);
      live.set(sender.id, { status: 'logged_out', error: 'Logged out from phone. Click Reconnect and scan the QR again.' });
    } else {
      live.set(sender.id, { status: 'error', error: 'Disconnected, retrying in 30s' });
      setTimeout(() => { if (live.get(sender.id)?.status === 'error') { live.delete(sender.id); start(sender); } }, 30000);
    }
  });

  client.initialize().catch((err) => {
    s.status = 'error';
    s.error = 'Could not open WhatsApp Web: ' + err.message;
    store.log('error', `${sender.name}: ${s.error}`, { senderId: sender.id });
  });
}

async function stop(id) {
  const s = live.get(id);
  live.delete(id);
  if (s && s.client) { try { await s.client.destroy(); } catch (_) {} }
}

function wipeAuth(id) {
  fs.rmSync(path.join(AUTH_DIR, 'session-' + id), { recursive: true, force: true });
}

async function logout(id) {
  const s = live.get(id);
  if (s && s.client && s.status === 'ready') { try { await s.client.logout(); } catch (_) {} }
  await stop(id);
  wipeAuth(id);
}

async function restart(sender) {
  await stop(sender.id);
  start(sender);
}

// Returns 'sent' | 'not_on_whatsapp'. Throws on other failures.
async function send(id, phone, text) {
  const s = live.get(id);
  if (!s || s.status !== 'ready') throw new Error('Sender not connected');
  const numberId = await s.client.getNumberId(phone);
  if (!numberId) return 'not_on_whatsapp';
  await s.client.sendMessage(numberId._serialized, text);
  return 'sent';
}

const isReady = (id) => live.get(id)?.status === 'ready';

module.exports = { start, stop, logout, restart, send, state, isReady };
