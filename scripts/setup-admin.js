#!/usr/bin/env node
// Creates the first admin, or resets an admin's password if you are locked out.
// Usage: npm run setup-admin
require('dotenv').config();
const readline = require('readline');
const QR = require('qrcode');
const sec = require('../src/security');
const users = require('../src/users');
const store = require('../src/store');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
rl._writeToOutput = function (s) { if (!muted || /[\r\n]/.test(s)) rl.output.write(muted ? s.replace(/[^\r\n]/g, '') : s); };
const ask = (q, hidden = false) => new Promise((resolve) => {
  rl.question(q, (a) => { muted = false; if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  muted = hidden;
});

(async () => {
  console.log('\nWhatsApp Sender: set up the admin sign-in\n');
  const user = (await ask('Admin username [admin]: ')) || 'admin';

  let password;
  for (;;) {
    password = await ask('Password (min 12, upper + lower + number): ', true);
    const problem = sec.passwordProblem(password);
    if (problem) { console.log('  ' + problem); continue; }
    if ((await ask('Repeat password: ', true)) !== password) { console.log('  Passwords do not match'); continue; }
    break;
  }

  let totpSecret = null;
  if (/^y/i.test((await ask('Turn on 2-step sign-in with an authenticator app (recommended)? [Y/n]: ')) || 'y')) {
    totpSecret = sec.newTotpSecret();
    const url = `otpauth://totp/WhatsApp%20Sender:${encodeURIComponent(user)}?secret=${totpSecret}&issuer=WhatsApp%20Sender`;
    console.log('\nScan this in Google Authenticator / Authy / Microsoft Authenticator:\n');
    console.log(await QR.toString(url, { type: 'terminal', small: true }));
    console.log(`Or enter this key manually: ${totpSecret}\n`);
    for (;;) {
      const code = await ask('Enter the 6-digit code from the app: ');
      if (sec.verifyTotp(totpSecret, code)) break;
      console.log('  Code did not match. Check the phone clock and try the latest code.');
    }
  }

  try {
    users.setAdmin({ user, password, totpSecret });
  } catch (e) { console.error('  ' + e.message); process.exit(1); }
  store.close();
  rl.close();
  console.log(`\nAdmin "${user}" saved (password stored hashed in data/app.db).`);
  console.log('If ADMIN_PASS is in .env, remove it. Then: pm2 restart wa-dashboard\n');
})();
