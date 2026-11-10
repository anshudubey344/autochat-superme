const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let S = null;            // last /api/state
let forced = false;      // must set own password before using the dashboard
let editSender = null, editSheet = null, testSender = null, preview = null;

let CSRF = null;
async function api(method, url, body) {
  if (!CSRF && method !== 'GET') CSRF = (await api('GET', '/api/me')).csrf;
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = CSRF;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (res.status === 401) { location.replace('/login.html'); throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.mustChange) { openAccount(true); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 3500);
}

const ago = (iso) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

// ---------- render ----------
function ring(done, limit) {
  const r = 50, c = 2 * Math.PI * r, p = Math.min(1, done / Math.max(1, limit));
  return `<div class="ring"><svg viewBox="0 0 118 118" width="118" height="118" aria-hidden="true">
    <circle cx="59" cy="59" r="${r}" fill="none" stroke="var(--leaf-soft)" stroke-width="9"/>
    <circle cx="59" cy="59" r="${r}" fill="none" stroke="${p >= 1 ? 'var(--saffron)' : 'var(--leaf)'}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c * p} ${c}"/>
  </svg><div class="count">${done}<small>of ${limit} today</small></div></div>`;
}

function senderCard(s) {
  let body;
  if (s.status === 'qr' && !s.qr) {
    body = '<span class="chip wait">Waiting to be linked</span><p class="scan">An admin needs to scan this number\'s QR code.</p>';
  } else if (s.status === 'qr' && s.qr) {
    body = `<img class="qr" src="${s.qr}" alt="QR code to link ${esc(s.name)}">
      <p class="scan">On the phone: WhatsApp → Linked devices → Link a device, then scan this.</p>`;
  } else if (s.status === 'ready') {
    const chip = S.paused ? '<span class="chip wait">Paused</span>'
      : !s.inHours ? `<span class="chip wait">Outside ${s.startHour}:00–${s.endHour}:00</span>`
      : s.sentToday >= s.dailyLimit ? '<span class="chip wait">Daily limit reached</span>'
      : '<span class="chip ready">Connected</span>';
    body = `${ring(s.sentToday, s.dailyLimit)}${chip}`;
  } else if (s.status === 'error' || s.status === 'logged_out') {
    body = `<span class="chip bad">${s.status === 'logged_out' ? 'Logged out' : 'Not connected'}</span><p class="err">${esc(s.error || '')}</p>`;
  } else {
    body = `<span class="chip wait">${s.status === 'connecting' ? 'Logging in…' : 'Starting…'}</span><p class="scan">This can take up to a minute.</p>`;
  }
  return `<article class="phone" data-id="${s.id}">
    <div class="notch"></div>
    <div class="screen">
      <div class="who">${esc(s.name)}</div>
      <div class="num">${s.me ? '+' + esc(s.me) : ''}</div>
      ${body}
    </div>
    <div class="tools">
      ${s.status === 'ready' && canEdit() ? '<button class="btn link" data-act="test">Test</button>' : ''}
      ${isAdmin() ? '<button class="btn link" data-act="edit">Settings</button>' : ''}
      ${!isAdmin() ? '' : s.status === 'ready' ? '<button class="btn link" data-act="logout">Log out</button>' : '<button class="btn link" data-act="reconnect">Reconnect</button>'}
    </div>
  </article>`;
}

function sheetCard(h) {
  const sender = S.senders.find((s) => s.id === h.senderId);
  const st = h.stats;
  const services = (h.templates || []).map((t) => `<span>${esc(t.service)}</span>`).join('');
  return `<article class="sheet${h.enabled ? '' : ' off'}" data-id="${h.id}">
    <div>
      <div class="title">${esc(h.name)}</div>
      <div class="meta">From ${esc(sender ? sender.name : '—')} · via ${esc(h.viaLabel)} · checked ${h.lastChecked ? ago(h.lastChecked) : 'not yet'} · ${h.rowCount ?? 0} row${h.rowCount === 1 ? '' : 's'}${h.via && h.cols.status >= 0 ? ' · writes status' : ''}</div>
    </div>
    <div class="acts" data-role="editor">
      <button class="btn link" data-act="check">Check now</button>
      <button class="btn link" data-act="toggle">${h.enabled ? 'Turn off' : 'Turn on'}</button>
      <button class="btn link" data-act="edit">Edit</button>
    </div>
    <div class="nums">
      <span><b>${st.sent}</b>sent</span>
      <span><b>${st.waiting}</b>waiting</span>
      <span class="${st.notOn ? 'warn' : ''}"><b>${st.notOn}</b>not on WhatsApp</span>
      <span class="${st.failed ? 'warn' : ''}"><b>${st.failed}</b>failed</span>
      ${st.skipped ? `<span><b>${st.skipped}</b>old rows skipped</span>` : ''}
    </div>
    <div class="services">${services}</div>
    ${st.error ? `<div class="problem">${esc(st.error)}</div>` : ''}
  </article>`;
}

const isAdmin = () => S && S.me && S.me.role === 'admin';
const canEdit = () => S && S.me && (S.me.role === 'admin' || S.me.role === 'manager');

function render() {
  document.body.classList.toggle('is-admin', isAdmin());
  document.body.classList.toggle('can-edit', canEdit());
  $('#accountBtn').textContent = S.me.user;
  const ready = S.senders.filter((s) => s.status === 'ready').length;
  const sentToday = S.senders.reduce((a, s) => a + s.sentToday, 0);
  $('#summary').textContent = `${ready} of ${S.senders.length} numbers connected · ${sentToday} sent today${S.paused ? ' · sending paused' : ''}`;
  const pb = $('#pauseBtn');
  pb.textContent = S.paused ? 'Resume sending' : 'Pause sending';
  pb.classList.toggle('on', S.paused);
  const ps = $('#pollSel');
  if (document.activeElement !== ps) {
    if (![...ps.options].some((o) => o.value === String(S.pollSeconds))) ps.add(new Option(S.pollSeconds + ' sec', S.pollSeconds));
    ps.value = String(S.pollSeconds);
  }

  $('#senders').innerHTML = S.senders.map(senderCard).join('') +
    (isAdmin() ? `<button class="phone add" data-act="add">+ Add number</button>` : '') +
    (!S.senders.length && !isAdmin() ? '<div class="empty">No numbers are shared with you yet. Ask an admin for access.</div>' : '');

  $('#sheets').innerHTML = S.sheets.length ? S.sheets.map(sheetCard).join('')
    : `<div class="empty">${!canEdit() ? 'No sheets yet.' : S.senders.length ? 'Add a Google Sheet to start sending.' : 'Add and connect a number first, then add a sheet.'}</div>`;

  $('#log').innerHTML = S.log.length ? S.log.map((l) => `<li class="${esc(l.level)}"><span class="dot"></span><div>${esc(l.text)}<time>${ago(l.at)}</time></div></li>`).join('')
    : '<li><span class="dot"></span><div>Nothing yet.</div></li>';
}

async function refresh() {
  try { S = await api('GET', '/api/state'); render(); }
  catch (e) { $('#summary').textContent = forced ? '' : 'Can\'t reach the server: ' + e.message; }
}

// ---------- senders ----------
function openSender(s) {
  editSender = s || null;
  const f = $('#senderForm'); f.reset();
  $('#senderDlg').returnValue = '';
  $('#senderDlgTitle').textContent = s ? 'Number settings' : 'Add number';
  $('#senderDelete').hidden = !s;
  if (s) for (const k of ['name', 'dailyLimit', 'minDelay', 'maxDelay', 'startHour', 'endHour']) f.elements[k].value = s[k];
  $('#senderDlg').showModal();
}

$('#senderDlg').addEventListener('close', async () => {
  if ($('#senderDlg').returnValue !== 'save') return;
  const f = $('#senderForm');
  const body = Object.fromEntries(['name', 'dailyLimit', 'minDelay', 'maxDelay', 'startHour', 'endHour'].map((k) => [k, f.elements[k].value]));
  try {
    if (editSender) { await api('PATCH', `/api/senders/${editSender.id}`, body); toast('Settings saved'); }
    else { await api('POST', '/api/senders', body); toast('Number added. Scan the QR code on its card.'); }
    refresh();
  } catch (e) { toast(e.message, true); }
});

$('#senderDelete').addEventListener('click', async () => {
  if (!confirm(`Remove "${editSender.name}"? It will be logged out from WhatsApp.`)) return;
  try { await api('DELETE', `/api/senders/${editSender.id}`); $('#senderDlg').close(); toast('Number removed'); refresh(); }
  catch (e) { toast(e.message, true); }
});

$('#senders').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  if (btn.dataset.act === 'add') return openSender();
  const s = S.senders.find((x) => x.id === btn.closest('.phone').dataset.id);
  if (btn.dataset.act === 'edit') return openSender(s);
  if (btn.dataset.act === 'test') { testSender = s; $('#testError').hidden = true; return $('#testDlg').showModal(); }
  if (btn.dataset.act === 'logout' && !confirm(`Log out ${s.name}? You'll need to scan the QR again.`)) return;
  try { await api('POST', `/api/senders/${s.id}/${btn.dataset.act}`); toast(btn.dataset.act === 'logout' ? 'Logged out' : 'Reconnecting…'); refresh(); }
  catch (err) { toast(err.message, true); }
});

$('#testForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const f = e.target;
  try {
    const r = await api('POST', `/api/senders/${testSender.id}/test`, { phone: f.elements.phone.value, message: f.elements.message.value });
    const ok = r.results.filter((x) => x.result === 'sent').length, bad = r.results.filter((x) => x.result !== 'sent');
    $('#testDlg').close();
    toast(bad.length ? `Sent to ${ok}. Not sent: ${bad.map((x) => `${x.phone} (${x.result})`).join(', ')}` : `Test message sent to ${ok} number${ok === 1 ? '' : 's'}`, !!bad.length);
    refresh();
  } catch (err) { $('#testError').textContent = err.message; $('#testError').hidden = false; }
});

// ---------- sheets ----------
function colOptions(sel, headers, value, noneLabel) {
  sel.innerHTML = (noneLabel ? `<option value="-1">${noneLabel}</option>` : '<option value="">Choose…</option>') +
    headers.map((h, i) => `<option value="${i}">${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ''} · ${esc(h || '(empty header)')}</option>`).join('');
  if (value !== undefined && value !== null) sel.value = String(value);
}

function guess(headers, words) {
  const i = headers.findIndex((h) => words.some((w) => String(h).toLowerCase().includes(w)));
  return i;
}

function tplRow(t = { service: '', message: '' }) {
  const d = document.createElement('div');
  d.className = 'tpl';
  d.innerHTML = `<input placeholder="Service, e.g. 1:1 Yoga" value="${esc(t.service)}" aria-label="Service">
    <textarea rows="4" placeholder="Message" aria-label="Message">${esc(t.message)}</textarea>
    <button class="btn link" type="button" aria-label="Remove this service">Remove</button>`;
  d.querySelector('button').onclick = () => d.remove();
  $('#tpls').appendChild(d);
}

function showColumns(p, h) {
  preview = p;
  const f = $('#sheetForm');
  colOptions(f.elements.col_phone, p.headers, h ? h.cols.phone : guess(p.headers, ['phone', 'mobile', 'number', 'whatsapp', 'contact no']));
  colOptions(f.elements.col_name, p.headers, h ? h.cols.name : guess(p.headers, ['name']), 'No name column');
  colOptions(f.elements.col_service, p.headers, h ? h.cols.service : guess(p.headers, ['service', 'interest', 'program']), 'No service column (always "Default")');
  colOptions(f.elements.col_status, p.headers, h ? h.cols.status : (p.canWrite ? guess(p.headers, ['status', 'whatsapp msg']) : -1), 'Don\'t write status');
  f.elements.col_status.disabled = !p.canWrite;
  $('#statusHint').textContent = p.canWrite ? `Opened with ${p.via}.` :
    'Opened through the public link, so status is shown here only. Connect the Google account that owns this sheet (Google accounts button) to also write status into the sheet.';
  $('#sheetMore').hidden = false;
  $('#sheetSave').disabled = false;
}

function openSheet(h) {
  editSheet = h || null; preview = null;
  const f = $('#sheetForm'); f.reset();
  $('#sheetDlgTitle').textContent = h ? 'Edit sheet' : 'Add sheet';
  $('#sheetDelete').hidden = !h;
  $('#existingBox').hidden = !!h;
  $('#sheetError').hidden = true;
  $('#sheetMore').hidden = true;
  $('#sheetSave').disabled = true;
  $('#accessHint').textContent = 'Open the right tab in Google Sheets, then copy the link from the address bar.';
  api('GET', '/api/google').then((g) => {
    $('#accessHint').textContent = g.accounts.length
      ? `Any sheet from ${g.accounts.map((a) => a.email).join(', ')} works without sharing. Open the right tab, then copy the link.`
      : 'Tip: connect your Google account (Google accounts button) and you won\'t need to share sheets. Otherwise set the sheet to "Anyone with the link → Viewer". Open the right tab, then copy the link.';
  }).catch(() => {});
  f.elements.senderId.innerHTML = S.senders.map((s) => `<option value="${s.id}">${esc(s.name)}${s.me ? ' (+' + esc(s.me) + ')' : ''}</option>`).join('');
  $('#tpls').innerHTML = '';
  (h ? h.templates : S.defaultTemplates).forEach(tplRow);
  if (h) {
    f.elements.url.value = h.url; f.elements.name.value = h.name;
    f.elements.senderId.value = h.senderId; f.elements.countryCode.value = h.countryCode;
    loadColumns(h);
  }
  $('#sheetDlg').showModal();
}

async function loadColumns(h) {
  const f = $('#sheetForm'), btn = $('#loadCols');
  $('#sheetError').hidden = true;
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const p = await api('POST', '/api/sheets/preview', { url: f.elements.url.value });
    showColumns(p, h);
    if (!f.elements.name.value) f.elements.name.value = 'Sheet ' + (S.sheets.length + 1);
  } catch (e) {
    $('#sheetError').textContent = e.message; $('#sheetError').hidden = false;
  } finally { btn.disabled = false; btn.textContent = 'Load columns'; }
}

$('#loadCols').addEventListener('click', () => loadColumns(editSheet && $('#sheetForm').elements.url.value === editSheet.url ? editSheet : null));
$('#addTpl').addEventListener('click', () => { tplRow(); $('#tpls').lastChild.querySelector('input').focus(); });

$('#sheetForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const f = e.target;
  if (!f.elements.senderId.value) { $('#sheetError').textContent = 'Add a sending number first.'; $('#sheetError').hidden = false; return; }
  const templates = [...document.querySelectorAll('#tpls .tpl')].map((d) => ({ service: d.querySelector('input').value, message: d.querySelector('textarea').value }));
  const body = {
    url: f.elements.url.value, name: f.elements.name.value, senderId: f.elements.senderId.value,
    countryCode: f.elements.countryCode.value, templates,
    cols: { phone: f.elements.col_phone.value, name: f.elements.col_name.value, service: f.elements.col_service.value, status: f.elements.col_status.disabled ? -1 : f.elements.col_status.value },
    sendExisting: f.elements.sendExisting.value === 'yes',
  };
  if (body.sendExisting && preview && !confirm(`This will message all ${preview.rowCount} rows already in the sheet. Continue?`)) return;
  const btn = $('#sheetSave'); btn.disabled = true;
  try {
    if (editSheet) { await api('PATCH', `/api/sheets/${editSheet.id}`, body); toast('Sheet saved'); }
    else { await api('POST', '/api/sheets', body); toast('Sheet added'); }
    $('#sheetDlg').close(); refresh();
  } catch (err) { $('#sheetError').textContent = err.message; $('#sheetError').hidden = false; }
  finally { btn.disabled = false; }
});

$('#sheetDelete').addEventListener('click', async () => {
  if (!confirm(`Remove "${editSheet.name}" from the dashboard? The Google Sheet itself is not changed.`)) return;
  try { await api('DELETE', `/api/sheets/${editSheet.id}`); $('#sheetDlg').close(); toast('Sheet removed'); refresh(); }
  catch (e) { toast(e.message, true); }
});

$('#sheets').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const h = S.sheets.find((x) => x.id === btn.closest('.sheet').dataset.id);
  try {
    if (btn.dataset.act === 'edit') return openSheet(h);
    if (btn.dataset.act === 'toggle') { await api('PATCH', `/api/sheets/${h.id}`, { enabled: !h.enabled }); toast(h.enabled ? 'Sheet turned off' : 'Sheet turned on'); }
    if (btn.dataset.act === 'check') { const r = await api('POST', `/api/sheets/${h.id}/check`); toast(r.queued ? `${r.queued} new message(s) queued` : 'No new rows'); }
    refresh();
  } catch (err) { toast(err.message, true); refresh(); }
});

$('#addSheetBtn').addEventListener('click', () => S.senders.length ? openSheet() : toast('Add a sending number first', true));
$('#pauseBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/pause', { paused: !S.paused }); toast(S.paused ? 'Sending resumed' : 'Sending paused'); refresh(); }
  catch (e) { toast(e.message, true); }
});

$('#pollSel').addEventListener('change', async (e) => {
  try { await api('POST', '/api/settings', { pollSeconds: e.target.value }); toast(`Sheets will be checked every ${e.target.selectedOptions[0].text}`); refresh(); }
  catch (err) { toast(err.message, true); }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/auth/logout'); } catch (_) {}
  location.replace('/login.html');
});

// ---------- team (admins) ----------
let editUser = null;
const roleName = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer' };

async function loadTeam() {
  const list = await api('GET', '/api/users');
  const names = Object.fromEntries(S.senders.map((s) => [s.id, s.name]));
  $('#userRows').innerHTML = list.map((u) => `<tr class="${u.disabled ? 'off' : ''}" data-id="${u.id}">
    <td><b>${esc(u.user)}</b>${u.id === S.me.id ? '<small>You</small>' : ''}${u.disabled ? '<small>Turned off</small>' : u.mustChange ? '<small>Hasn\'t set a password yet</small>' : ''}${u.totp ? '<small>2-step on</small>' : ''}</td>
    <td><span class="role-tag ${u.role}">${roleName[u.role]}</span></td>
    <td>${u.allSenders ? 'All' : u.senderIds.length ? u.senderIds.map((id) => esc(names[id] || '?')).join(', ') : '<span class="muted">None</span>'}</td>
    <td>${u.lastLogin ? ago(u.lastLogin) : '<span class="muted">Never</span>'}</td>
    <td><div class="row-acts">
      <button class="btn link" data-act="edit">Edit</button>
      ${u.id === S.me.id ? '' : `<button class="btn link" data-act="reset">Reset password</button>
      ${u.totp ? '<button class="btn link" data-act="reset2fa">Reset 2-step</button>' : ''}
      <button class="btn link" data-act="toggle">${u.disabled ? 'Turn on' : 'Turn off'}</button>
      <button class="btn link" data-act="remove">Remove</button>`}
    </div></td></tr>`).join('');
  loadTeam.list = list;
}

function openUser(u) {
  editUser = u || null;
  const f = $('#userForm'); f.reset();
  $('#userDlg').returnValue = '';
  $('#userDlgTitle').textContent = u ? `Edit ${u.user}` : 'Add person';
  $('#userSave').textContent = u ? 'Save' : 'Add person';
  $('#userSave').hidden = false; $('#userCancel').textContent = 'Cancel';
  f.elements.user.value = u ? u.user : ''; f.elements.user.readOnly = !!u;
  f.elements.role.value = u ? u.role : 'manager';
  f.elements.allSenders.checked = u ? u.allSenders : false;
  $('#numberChecks').innerHTML = S.senders.map((s) => `<label class="radio"><input type="checkbox" value="${s.id}" ${u && u.senderIds.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('')
    || '<span class="hint">No numbers added yet.</span>';
  $('#tempPassBox').hidden = true; $('#userError').hidden = true;
  syncNumbers();
  $('#userDlg').showModal();
}
function syncNumbers() {
  const f = $('#userForm'), admin = f.elements.role.value === 'admin';
  $('#numbersBox').hidden = admin;
  $('#numberChecks').querySelectorAll('input').forEach((i) => { i.disabled = f.elements.allSenders.checked; });
}
$('#userForm').elements.role.addEventListener('change', syncNumbers);
$('#userForm').elements.allSenders.addEventListener('change', syncNumbers);

function showTempPassword(pw, who) {
  $('#userDlgTitle').textContent = who;
  $('#tempPass').value = pw; $('#tempPassBox').hidden = false;
  $('#userSave').hidden = true; $('#userCancel').textContent = 'Done';
  if (!$('#userDlg').open) $('#userDlg').showModal();
}
$('#copyPass').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#tempPass').value); toast('Password copied'); }
  catch (_) { $('#tempPass').select(); }
});

$('#userForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const f = e.target;
  const body = { role: f.elements.role.value, allSenders: f.elements.allSenders.checked,
    senderIds: [...$('#numberChecks').querySelectorAll('input:checked')].map((i) => i.value) };
  try {
    if (editUser) {
      await api('PATCH', `/api/users/${editUser.id}`, body);
      $('#userDlg').close(); toast('Access updated. They need to sign in again.');
    } else {
      const r = await api('POST', '/api/users', { ...body, user: f.elements.user.value });
      showTempPassword(r.password, `${r.user.user} added`);
    }
    loadTeam();
  } catch (err) { $('#userError').textContent = err.message; $('#userError').hidden = false; }
});

$('#userRows').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const u = loadTeam.list.find((x) => x.id === btn.closest('tr').dataset.id);
  try {
    if (btn.dataset.act === 'edit') return openUser(u);
    if (btn.dataset.act === 'reset') {
      if (!confirm(`Reset ${u.user}'s password? They will be signed out.`)) return;
      const r = await api('POST', `/api/users/${u.id}/reset-password`);
      openUser(u); showTempPassword(r.password, `New password for ${u.user}`);
    }
    if (btn.dataset.act === 'reset2fa') {
      if (!confirm(`Turn off 2-step sign-in for ${u.user}? Do this only if they lost their phone.`)) return;
      await api('POST', `/api/users/${u.id}/reset-2fa`); toast('2-step sign-in reset');
    }
    if (btn.dataset.act === 'toggle') { await api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled }); toast(u.disabled ? `${u.user} can sign in again` : `${u.user} turned off and signed out`); }
    if (btn.dataset.act === 'remove') {
      if (!confirm(`Remove ${u.user}? They lose access immediately.`)) return;
      await api('DELETE', `/api/users/${u.id}`); toast(`${u.user} removed`);
    }
    loadTeam();
  } catch (err) { toast(err.message, true); }
});

$('#teamBtn').addEventListener('click', async () => {
  try { await loadTeam(); $('#teamDlg').showModal(); } catch (e) { toast(e.message, true); }
});
$('#teamClose').addEventListener('click', () => { $('#teamDlg').close(); refresh(); });
$('#addUserBtn').addEventListener('click', () => openUser());

// ---------- my account ----------
async function openAccount(force = false) {
  forced = force;
  const me = await api('GET', '/api/me');
  $('#accountTitle').textContent = force ? 'Set your own password' : 'My account';
  $('#accountWho').textContent = force
    ? `Welcome, ${me.user}. Replace the temporary password before you continue.`
    : `Signed in as ${me.user} · ${roleName[me.role]}`;
  $('#accountClose').hidden = force;
  $('#tfaBox').hidden = force;
  $('#pwForm').reset(); $('#pwError').hidden = true;
  renderTfa(me);
  if (!$('#accountDlg').open) $('#accountDlg').showModal();
}
function renderTfa(me) {
  $('#tfaState').textContent = me.totp ? 'On. You enter a code from your phone when you sign in.' : 'Off. Turn it on so a stolen password is not enough to sign in.';
  $('#tfaStart').hidden = me.totp; $('#tfaOffBox').hidden = !me.totp; $('#tfaSetup').hidden = true; $('#tfaError').hidden = true;
}
$('#accountDlg').addEventListener('cancel', (e) => { if (forced) e.preventDefault(); });
$('#accountClose').addEventListener('click', () => $('#accountDlg').close());
$('#accountBtn').addEventListener('click', () => openAccount(false).catch((e) => toast(e.message, true)));

$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.elements.password.value !== f.elements.repeat.value) { $('#pwError').textContent = 'New passwords do not match'; $('#pwError').hidden = false; return; }
  try {
    await api('POST', '/api/account/password', { current: f.elements.current.value, password: f.elements.password.value });
    toast('Password changed. Other devices were signed out.');
    f.reset();
    if (forced) { forced = false; $('#accountDlg').close(); refresh(); }
  } catch (err) { $('#pwError').textContent = err.message; $('#pwError').hidden = false; }
});
$('#tfaStart').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/account/2fa/start');
    $('#tfaQr').src = r.qr; $('#tfaKey').textContent = r.secret;
    $('#tfaSetup').hidden = false; $('#tfaStart').hidden = true; $('#tfaCode').focus();
  } catch (e) { toast(e.message, true); }
});
$('#tfaConfirm').addEventListener('click', async () => {
  try { await api('POST', '/api/account/2fa/confirm', { code: $('#tfaCode').value }); toast('2-step sign-in is on'); renderTfa(await api('GET', '/api/me')); }
  catch (e) { $('#tfaError').textContent = e.message; $('#tfaError').hidden = false; }
});
$('#tfaOff').addEventListener('click', async () => {
  try { await api('POST', '/api/account/2fa/disable', { password: $('#tfaPass').value }); $('#tfaPass').value = ''; toast('2-step sign-in is off'); renderTfa(await api('GET', '/api/me')); }
  catch (e) { $('#tfaError').textContent = e.message; $('#tfaError').hidden = false; }
});

// ---------- Google accounts ----------
async function openGoogle() {
  const g = await api('GET', '/api/google');
  $('#googleList').innerHTML = g.accounts.length ? g.accounts.map((a) => `<div class="g-item" data-id="${a.id}">
      <b>${esc(a.email)}</b>
      <small>Connected by ${esc(a.connectedBy)} ${ago(a.createdAt)}${a.sheets.length ? ` · used by ${a.sheets.map(esc).join(', ')}` : ''}</small>
      <button class="btn link" type="button" data-act="disconnect">Disconnect</button>
    </div>`).join('') : '<p class="hint">No Google account connected yet.</p>';
  $('#googleConnect').hidden = !g.configured;
  const setup = $('#googleSetup');
  setup.hidden = g.configured;
  if (!g.configured) {
    setup.innerHTML = g.redirectUri !== null
      ? `<p><b>One-time server setup needed.</b> Follow "Connect Google account" in the README: create an OAuth client in Google Cloud, add this redirect address, then put the client id and secret in .env.</p><p>Redirect address: <code>${esc(g.redirectUri.startsWith('/') ? '(set PUBLIC_URL in .env first)' : g.redirectUri)}</code></p>`
      : '<p>Google sign-in isn\'t set up on the server yet. Ask an admin.</p>';
  }
  if (!$('#googleDlg').open) $('#googleDlg').showModal();
}
$('#googleBtn').addEventListener('click', () => openGoogle().catch((e) => toast(e.message, true)));
$('#googleClose').addEventListener('click', () => { $('#googleDlg').close(); refresh(); });
$('#googleList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="disconnect"]'); if (!btn) return;
  const email = btn.parentElement.querySelector('b').textContent;
  if (!confirm(`Disconnect ${email}? Sheets opened with it will stop until you fix them.`)) return;
  try {
    const r = await api('DELETE', `/api/google/${btn.parentElement.dataset.id}`);
    toast(r.affected.length ? `Disconnected. Fix these sheets: ${r.affected.join(', ')}` : 'Disconnected', !!r.affected.length);
    openGoogle();
  } catch (err) { toast(err.message, true); }
});

// Coming back from Google's permission screen
(() => {
  const q = new URLSearchParams(location.search);
  if (q.has('google')) toast(`Connected ${q.get('google')}. Its sheets now work without sharing.`);
  if (q.has('google_error')) toast(q.get('google_error'), true);
  if (q.has('google') || q.has('google_error')) history.replaceState(null, '', '/');
})();

api('GET', '/api/me').then((m) => { CSRF = m.csrf; if (m.mustChange) openAccount(true); }).catch(() => {});
refresh();
setInterval(() => { if (!document.querySelector('dialog[open]')) refresh(); }, 3000);
