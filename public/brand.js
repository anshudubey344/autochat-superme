// Brand theme: logo, name and colours. The accent colour comes from BRAND_COLOR in .env,
// or, if that is empty, from the most common strong colour in the logo itself.
(function () {
  const root = document.documentElement;
  const CACHE = 'brand-theme-v1';

  function hexToRgb(h) {
    const m = String(h || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hsl(h, s, l) { return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`; }
  function hslToRgb(h, s, l) {
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map((x) => x * 255);
  }
  function luminance([r, g, b]) {
    const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // Build the palette from one hue; keeps white text on buttons readable (contrast ≥ 4.5).
  function palette([h, s]) {
    s = Math.min(0.85, Math.max(0.4, s));
    let l = 0.5;
    while (l > 0.15 && (1.05) / (luminance(hslToRgb(h, s, l)) + 0.05) < 4.5) l -= 0.02;
    return {
      '--leaf': hsl(h, s, l),
      '--leaf-hover': hsl(h, s, Math.max(0.1, l - 0.07)),
      '--leaf-soft': hsl(h, s * 0.6, 0.92),
      '--paper': hsl(h, Math.min(s, 0.25), 0.955),
      '--line': hsl(h, Math.min(s, 0.18), 0.86),
      '--ink': hsl(h, Math.min(s, 0.35), 0.12),
      '--muted': hsl(h, Math.min(s, 0.12), 0.40),
      '--phone': hsl(h, Math.min(s, 0.4), 0.16),
      '--notch': hsl(h, Math.min(s, 0.4), 0.09),
    };
  }
  function apply(vars) { for (const k in vars) root.style.setProperty(k, vars[k]); }

  // Most common saturated, mid-light colour in the logo
  function colourFromImage(img) {
    const c = document.createElement('canvas'), w = (c.width = 64), hh = (c.height = Math.max(1, Math.round(64 * img.naturalHeight / img.naturalWidth)));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, hh);
    const d = ctx.getImageData(0, 0, w, hh).data, bins = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      if (s < 0.3 || l < 0.15 || l > 0.85) continue;          // skip white, black, grey
      const k = Math.round(h / 10);
      const b = bins.get(k) || { n: 0, h: 0, s: 0 };
      b.n++; b.h += h; b.s += s; bins.set(k, b);
    }
    let best = null;
    for (const b of bins.values()) if (!best || b.n > best.n) best = b;
    return best && best.n > 8 ? [best.h / best.n, best.s / best.n] : null;
  }

  // 1. cached theme first (no flash of the default colours)
  try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); if (c) apply(c.vars); } catch (_) {}

  const domReady = () => new Promise((r) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r()));
  Promise.all([fetch('/brand.json').then((r) => r.json()), domReady()]).then(([b]) => {
    // name + logo
    if (b.name) {
      document.title = document.title.replace('WhatsApp Sender', `${b.name} · WhatsApp Sender`);
      document.querySelectorAll('[data-brand-name]').forEach((el) => { el.textContent = b.name; });
    }
    document.querySelectorAll('[data-brand-logo]').forEach((el) => {
      if (!b.logo) return;
      el.src = b.logo; el.alt = b.name || 'Logo'; el.hidden = false;
      el.closest('[data-brand]') && el.closest('[data-brand]').classList.add('has-logo');
    });
    // colours
    const fixed = hexToRgb(b.color);
    const save = (vars) => { apply(vars); try { localStorage.setItem(CACHE, JSON.stringify({ vars })); } catch (_) {} };
    if (fixed) return save(palette(rgbToHsl(...fixed)));
    if (!b.logo) return;
    const img = new Image();
    img.onload = () => { try { const hs = colourFromImage(img); if (hs) save(palette(hs)); } catch (_) {} };
    img.src = b.logo;
  }).catch(() => {});
})();
