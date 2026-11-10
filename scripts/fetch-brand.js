#!/usr/bin/env node
// Downloads the brand logo and icon into public/brand/ (run on the server: npm run fetch-brand).
// URLs come from .env (BRAND_LOGO_URL, BRAND_ICON_URL); defaults are SuperMe's.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'public', 'brand');
const files = [
  ['logo', process.env.BRAND_LOGO_URL || 'https://www.mysuperme.com/logo-1.png'],
  ['icon', process.env.BRAND_ICON_URL || 'https://www.mysuperme.com/symbol.png'],
];
const TYPES = { 'image/png': 'png', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, url] of files) {
    if (!/^https:\/\//.test(url)) { console.error(`${name}: use an https:// URL`); process.exitCode = 1; continue; }
    try {
      const res = await fetch(url, { redirect: 'follow' });
      const type = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!TYPES[type]) throw new Error(`not an image (${type || 'unknown type'})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) throw new Error('bigger than 2 MB');
      for (const f of fs.readdirSync(OUT)) if (f.startsWith(name + '.')) fs.unlinkSync(path.join(OUT, f));
      fs.writeFileSync(path.join(OUT, `${name}.${TYPES[type]}`), buf);
      console.log(`✓ ${name}.${TYPES[type]}  (${Math.round(buf.length / 1024)} KB) from ${url}`);
    } catch (e) {
      console.error(`✗ ${name}: ${e.message} (${url})`);
      process.exitCode = 1;
    }
  }
  console.log('Restart is not needed; reload the dashboard page.');
})();
