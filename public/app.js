'use strict';

// ---------- small helpers ----------
const $app = document.getElementById('app');
const state = { pub: { orgName: 'Delivery Team', sessions: ['FULL', 'AM', 'PM'], maxHelpers: 8 }, me: null, tab: 'today', admin: null, from: null, to: null };
const SESSION_NAMES = { FULL: 'Full day', AM: 'Morning', PM: 'Afternoon' };
const ROLE_NAMES = { helper: 'Helper', installer: 'Installation person', both: 'Helper + Installation' };

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== '/login') { state.me = null; render(); throw new Error(data.error || 'Please log in'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

function dateObj(d) { return new Date(d + 'T00:00:00Z'); }
function fmtDate(d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return dateObj(d).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
}
function addDays(d, n) { const x = dateObj(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function telLink(phone, label) {
  if (!phone) return '';
  return `<a href="tel:${esc(phone.replace(/[^\d+]/g, ''))}">${esc(label || phone)}</a>`;
}
function roleBadge(role) {
  return role === 'installer' ? '<span class="badge w3">Installation</span>' : role === 'both' ? '<span class="badge w4">Helper + Install</span>' : '<span class="badge w2">Helper</span>';
}
function needText(d) {
  const parts = [];
  if (d.installation) parts.push(d.type === 'service' ? 'service person' : 'installation person');
  if (d.helpersNeeded) parts.push(`${d.helpersNeeded} helper${d.helpersNeeded > 1 ? 's' : ''}`);
  return parts.join(' + ');
}
function placeName(t, d) {
  if (t.extra) return 'Emergency';
  if (t.role === 'installer') return d && d.type === 'service' ? 'Service' : 'Installation';
  return `Helper ${t.slot + 1}`;
}
function mapLink(address) {
  return address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : '';
}

const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
function openModal(html, onSubmit) {
  modalBody.innerHTML = html;
  modalBody.onsubmit = async (e) => {
    const btn = e.submitter;
    if (btn && btn.value === 'cancel') return; // let dialog close
    e.preventDefault();
    const err = modalBody.querySelector('.error');
    if (err) err.remove();
    try {
      if (btn) btn.disabled = true;
      await onSubmit(new FormData(modalBody), modalBody);
      modal.close();
    } catch (ex) {
      modalBody.querySelector('.actions').insertAdjacentHTML('beforebegin', `<div class="error">${esc(ex.message)}</div>`);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  modal.showModal();
}

// ---------- boot ----------
async function boot() {
  try { state.pub = await api('/public'); } catch { /* keep defaults */ }
  document.title = state.pub.orgName;
  try { state.me = await api('/me'); } catch { state.me = null; }
  render();
}

function render() {
  if (!state.me || !state.me.role) return renderLogin();
  if (state.me.role === 'admin') return renderAdmin();
  if (state.me.role === 'unit') return renderUnit();
  if (state.me.role === 'staff') return renderStaff();
}

function topbar(subtitle) {
  return `<div class="topbar">
    <div><div class="title">${esc(state.pub.orgName)}</div><div class="who">${esc(subtitle)}</div></div>
    <div class="spacer"></div>
    <button id="logout">Log out</button>
  </div>`;
}
function bindLogout() {
  document.getElementById('logout').onclick = async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    state.admin = null;
    render();
  };
}

// ---------- login ----------
function renderLogin(role = localStorageGet('role') || 'unit') {
  const labels = { unit: 'Unit login ID', staff: 'Your login ID (usually phone no.)', admin: 'Admin username' };
  $app.innerHTML = `<div class="login">
    <div class="brand"><div class="logo">🚚</div><h1>${esc(state.pub.orgName)}</h1><div class="muted">Delivery helpers &amp; installation team</div></div>
    <div class="card">
      <div class="role-switch">
        <button type="button" data-role="unit" class="${role === 'unit' ? 'on' : ''}"><span>🏢</span>Unit</button>
        <button type="button" data-role="staff" class="${role === 'staff' ? 'on' : ''}"><span>🧰</span>Helper</button>
        <button type="button" data-role="admin" class="${role === 'admin' ? 'on' : ''}"><span>🔑</span>Admin</button>
      </div>
      <form id="login-form">
        <label>${labels[role]}</label>
        <input name="username" autocomplete="username" autocapitalize="none" required>
        <label>Password${role === 'staff' ? ' / PIN' : ''}</label>
        <input name="password" type="password" autocomplete="current-password" required>
        <button class="primary" type="submit">Log in</button>
      </form>
    </div>
    <p class="muted small" style="text-align:center">Ask your admin for your login ID and password.</p>
    <p class="muted small" style="text-align:center;opacity:.7">Version ${esc(state.pub.version || '')}</p>
  </div>`;
  $app.querySelectorAll('[data-role]').forEach((b) => (b.onclick = () => { localStorageSet('role', b.dataset.role); renderLogin(b.dataset.role); }));
  const form = document.getElementById('login-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const old = form.querySelector('.error');
    if (old) old.remove();
    try {
      await api('/login', { method: 'POST', body: { role, username: fd.get('username'), password: fd.get('password') } });
      state.me = await api('/me');
      state.tab = 'today';
      render();
    } catch (ex) {
      form.insertAdjacentHTML('beforeend', `<div class="error">${esc(ex.message)}</div>`);
    }
  };
}
function localStorageGet(k) { try { return localStorage.getItem('wd_' + k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem('wd_' + k, v); } catch { /* ignore */ } }

// ---------- delivery card (shared by admin / unit / staff) ----------
function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
}
function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const durBetween = (a, b) => (a && b ? new Date(b) - new Date(a) : null);
const isOpenJob = (d) => d.status === 'planned' || d.status === 'started';
const jobName = (d) => (d.type === 'service' ? 'Service' : 'Delivery');

function statusBadge(d, today) {
  if (d.status === 'cancelled') return '<span class="badge">Cancelled</span>';
  if (d.status === 'done') return '<span class="badge ok">✓ Completed</span>';
  if (d.status === 'started') return '<span class="badge w4">🚚 Started</span>';
  if (d.date < today) return '<span class="badge warn">Not marked completed</span>';
  return d.open ? `<span class="badge bad">${d.open} open</span>` : '<span class="badge ok">Team ready</span>';
}

function timeline(d) {
  const parts = [];
  if (d.createdAt) parts.push(`Requested ${esc(fmtTime(d.createdAt))}${d.createdBy ? ' by ' + esc(d.createdBy) : ''}`);
  if (d.startedAt) parts.push(`Started ${esc(fmtTime(d.startedAt))}`);
  if (d.completedAt) {
    const work = fmtDur(durBetween(d.startedAt, d.completedAt));
    const total = fmtDur(durBetween(d.createdAt, d.completedAt));
    parts.push(`<b>Completed ${esc(fmtTime(d.completedAt))}</b>${work || total ? ` (${[work && 'work ' + work, total && 'total ' + total].filter(Boolean).join(' · ')})` : ''}`);
  }
  return parts.length ? `<div class="small muted" style="margin-top:6px">🕒 ${parts.join(' · ')}</div>` : '';
}

// who: 'admin' | 'unit' | 'staff'
function deliveryCard(d, who, today) {
  const past = d.date < today;
  const boss = who === 'admin' || who === 'unit';
  const open = isOpenJob(d);
  const canTeam = boss && open && !past;
  const team = d.team.map((t) => {
    const p = t.person;
    const tags = [
      t.extra ? '<span class="badge warn">Emergency</span>' : '',
      p && p.backup ? '<span class="badge bad">Backup person</span>' : '',
      t.manual && !t.extra ? '<span class="badge manual">changed</span>' : '',
      t.fromUnit ? `<span class="small muted">moved from ${esc(t.fromUnit)}</span>` : '',
      t.reason ? `<span class="small muted">${esc(t.reason)}</span>` : '',
    ].join(' ');
    const actions = !canTeam ? '' : [
      who === 'admin' && !t.extra ? `<button class="link small" data-change="${esc(d.id)}|${t.role}|${t.slot}">Change</button>` : '',
      p ? `<button class="link small" data-replace="${esc(d.id)}|${esc(p.id)}|${esc(p.name)}">${t.extra ? 'Remove' : 'Absent – replace'}</button>` : '',
    ].join('');
    return `<div class="drv"><div class="row"><span class="small muted" style="width:86px">${esc(placeName(t, d))}</span>
      ${p ? `<b>${esc(p.name)}</b> ${roleBadge(p.role)} ${p.unitName ? `<span class="small muted">(${esc(p.unitName)})</span>` : ''} ${tags}` : open ? `<span class="empty">Nobody free – ${t.role === 'installer' ? (d.type === 'service' ? 'service person' : 'installation person') : 'helper'} needed</span>` : '<span class="muted small">—</span>'}</div>
      ${p || actions ? `<div class="row small" style="margin-left:92px">${p ? telLink(p.phone) : ''} ${actions}</div>` : ''}</div>`;
  }).join('');
  const lost = open && d.lost.length ? `<div class="badge bad" style="margin-top:8px;white-space:normal">⚠ ${d.lost.map((l) => `${esc(l.person)} was taken by ${esc(l.unit)} for an emergency`).join('; ')}</div>` : '';
  const typeTag = d.type === 'service' ? '<span class="badge w3">🔧 Service</span> ' : '';
  const head = `<div class="row"><div><div class="name">${typeTag}${who === 'admin' || who === 'staff' ? esc(d.unitName) + ' · ' : ''}${esc(SESSION_NAMES[d.session])}</div>
      <div class="small muted">${esc(fmtDate(d.date))} · needs ${esc(needText(d))}</div></div><div class="spacer"></div>${statusBadge(d, today)}</div>`;
  const links = [
    d.parent ? `🔗 Follow-up of the ${d.parent.type === 'service' ? 'service' : 'delivery'} on ${esc(fmtDate(d.parent.date))}` : '',
    d.services.length ? `🔧 Service booked: ${d.services.map((s) => `${esc(fmtDate(s.date))}${s.status === 'done' ? ' ✓' : ''}`).join(', ')}` : '',
  ];
  const info = [
    d.customer ? `👤 <b>${esc(d.customer)}</b> ${telLink(d.customerPhone)}` : d.customerPhone ? `📞 ${telLink(d.customerPhone)}` : '',
    d.items && d.items.length ? `⚙️ ${d.items.map((i) => `${esc(i.label)} <b>× ${esc(i.qty)}</b>`).join(', ')}` : d.machine ? `⚙️ ${esc(d.machine)}` : '',
    d.address ? `📍 ${esc(d.address)} · <a target="_blank" rel="noopener" href="${mapLink(d.address)}">Map</a>` : '',
    d.notes ? `📝 ${esc(d.notes)}` : '',
    d.completionNote ? `✅ ${esc(d.completionNote)}` : '',
    ...links,
  ].filter(Boolean).map((x) => `<div class="small">${x}</div>`).join('');
  const btns = [];
  if (boss && open && !(d.date > today)) {
    if (d.status === 'planned') btns.push(`<button class="small" data-start="${esc(d.id)}">▶ Start</button>`);
    btns.push(`<button class="small primary" data-complete="${esc(d.id)}">✓ Completed</button>`);
  }
  if (canTeam) {
    btns.push(`<button class="small" data-extra="${esc(d.id)}">🆘 Emergency person</button>`);
    btns.push(`<button class="small" data-edit-del="${esc(d.id)}">Edit</button>`);
  }
  if (boss && d.status === 'done') btns.push(`<button class="small" data-service="${esc(d.id)}">🔧 Book service</button>`);
  if (boss && d.status !== 'cancelled' && (d.status === 'done' || !(d.date > today))) btns.push(`<button class="small" data-photo="${esc(d.id)}">📷 Add photo</button>`);
  if (who !== 'staff' && d.status !== 'cancelled') btns.push(`<button class="small" data-wa="${esc(d.id)}">📤 WhatsApp</button>`);
  if (canTeam && d.status === 'planned') btns.push(`<div class="spacer"></div><button class="small danger" data-cancel-del="${esc(d.id)}">Cancel</button>`);
  if (boss && (d.status === 'done' || d.status === 'started')) btns.push(`<div class="spacer"></div><button class="link small" data-reopen="${esc(d.id)}">${d.status === 'done' ? 'Reopen' : 'Undo start'}</button>`);
  const buttons = btns.length ? `<div class="row no-print" style="margin-top:10px">${btns.join('')}</div>` : '';
  const photos = d.photos && d.photos.length
    ? `<div class="small" style="margin-top:8px"><b>📒 Service book (${d.photos.length})</b><div class="thumbs">${d.photos.map((p) => `<span class="thumb"><a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(fmtTime(p.at))}"><img src="${esc(p.url)}" alt="service book photo" loading="lazy"></a>${who === 'admin' ? `<button type="button" data-delphoto="${esc(d.id)}|${esc(p.file)}" title="Delete photo">✕</button>` : ''}</span>`).join('')}</div></div>`
    : '';
  return `<div class="card unit-card${d.status === 'cancelled' ? ' muted' : ''}${d.status === 'done' ? ' done' : ''}">${head}${info ? `<div style="margin-top:6px">${info}</div>` : ''}${timeline(d)}${photos}${team}${lost}${buttons}</div>`;
}

function waText(d) {
  const lines = [`*${state.pub.orgName} – ${jobName(d)} ${fmtDate(d.date)} (${SESSION_NAMES[d.session]})*`, `Unit: ${d.unitName}`];
  if (d.customer) lines.push(`Customer: ${d.customer}${d.customerPhone ? ' (' + d.customerPhone + ')' : ''}`);
  if (d.items && d.items.length) { lines.push('Machines:'); d.items.forEach((i) => lines.push(`  - ${i.label} × ${i.qty}`)); } else if (d.machine) lines.push(`Machine: ${d.machine}`);
  if (d.address) lines.push(`Address: ${d.address}`);
  if (d.notes) lines.push(`Note: ${d.notes}`);
  lines.push('Team:');
  for (const t of d.team) {
    const p = t.person;
    lines.push(`• ${placeName(t, d)}: ${p ? p.name + (p.phone ? ' ' + p.phone : '') : '(open)'}`);
  }
  if (d.status === 'done') lines.push(`✅ Completed ${fmtTime(d.completedAt)}`);
  return lines.join('\n');
}

// Hook up the buttons inside delivery cards. `base` is '/unit' or '/admin'; `list` the deliveries shown.
function bindDeliveryButtons(root, base, list, reload) {
  const find = (id) => list.find((d) => d.id === id);
  const post = async (url, msg, body) => {
    try { await api(url, { method: 'POST', body }); toast(msg); reload(); } catch (ex) { toast(ex.message, true); }
  };
  root.querySelectorAll('[data-wa]').forEach((b) => (b.onclick = () => window.open('https://wa.me/?text=' + encodeURIComponent(waText(find(b.dataset.wa))), '_blank')));
  root.querySelectorAll('[data-edit-del]').forEach((b) => (b.onclick = () => deliveryForm(base, find(b.dataset.editDel), reload)));
  root.querySelectorAll('[data-cancel-del]').forEach((b) => (b.onclick = () => {
    if (confirm('Cancel this job? Its team becomes free.')) post(`${base}/deliveries/${b.dataset.cancelDel}/cancel`, 'Cancelled');
  }));
  root.querySelectorAll('[data-start]').forEach((b) => (b.onclick = () => post(`${base}/deliveries/${b.dataset.start}/start`, 'Marked as started – time noted')));
  root.querySelectorAll('[data-reopen]').forEach((b) => (b.onclick = () => {
    if (confirm('Open this job again? Completed / start time is cleared.')) post(`${base}/deliveries/${b.dataset.reopen}/reopen`, 'Opened again');
  }));
  root.querySelectorAll('[data-photo]').forEach((b) => (b.onclick = () => {
    const d = find(b.dataset.photo);
    openModal(`<h2>Add service book photo</h2><div class="muted">${esc(d.unitName)} · ${esc(fmtDate(d.date))}${d.customer ? ' · ' + esc(d.customer) : ''}</div>
      <div id="p-photos"></div>
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Upload</button></div>`,
    async () => {
      const photos = getPhotos();
      if (!photos.length) throw new Error('Choose a photo first');
      await api(`${base}/deliveries/${d.id}/photos`, { method: 'POST', body: { photos } });
      toast('Photo saved');
      reload();
    });
    const getPhotos = photoPicker(document.getElementById('p-photos'));
  }));
  root.querySelectorAll('[data-delphoto]').forEach((b) => (b.onclick = () => {
    const [id, file] = b.dataset.delphoto.split('|');
    if (confirm('Delete this photo?')) post(`${base}/deliveries/${id}/photos/delete`, 'Photo deleted', { file });
  }));
  root.querySelectorAll('[data-complete]').forEach((b) => (b.onclick = () => completeForm(base, find(b.dataset.complete), reload)));
  root.querySelectorAll('[data-service]').forEach((b) => (b.onclick = () => {
    const p = find(b.dataset.service);
    deliveryForm(base, null, reload, addDays(state.today, 30), { ...p, type: 'service', parentId: p.id, helpersNeeded: 0, installation: true, session: 'FULL', notes: '' });
  }));
  root.querySelectorAll('[data-replace]').forEach((b) => (b.onclick = async () => {
    const [id, personId, name] = b.dataset.replace.split('|');
    const d = find(id);
    const t = d.team.find((x) => x.person && x.person.id === personId);
    const msg = t && t.extra ? `Remove ${name} (emergency person) from this job?` : `${name} can't come? They are taken off this job and someone else is picked automatically.`;
    if (!confirm(msg)) return;
    if (t && t.extra) post(`${base}/deliveries/${id}/extra/cancel`, 'Done – team updated', { slot: t.slot });
    else post(`${base}/deliveries/${id}/replace`, 'Done – team updated', { personId });
  }));
  root.querySelectorAll('[data-extra]').forEach((b) => (b.onclick = () => askExtra(base, find(b.dataset.extra), reload)));
  root.querySelectorAll('[data-change]').forEach((b) => (b.onclick = () => { const [id, role, slot] = b.dataset.change.split('|'); changePlace(find(id), role, Number(slot)); }));
}

// Shrink a photo on the phone before upload (max 1600 px, JPEG) so it is quick to send.
function compressImage(file, max = 1600, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} is not a photo`)); };
    img.src = url;
  });
}

// A photo picker (camera or gallery) with previews. Returns a function giving the chosen photos.
function photoPicker(box) {
  const photos = [];
  box.innerHTML = `<label class="btn" style="margin:6px 0;font-weight:500">📷 Take / choose photo<input type="file" accept="image/*" multiple hidden></label>
    <div class="thumbs"></div>`;
  const input = box.querySelector('input');
  const thumbs = box.querySelector('.thumbs');
  const draw = () => {
    thumbs.innerHTML = photos.map((p, i) => `<span class="thumb"><img src="${p}" alt=""><button type="button" data-rm="${i}" title="Remove">✕</button></span>`).join('');
    thumbs.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { photos.splice(Number(b.dataset.rm), 1); draw(); }));
  };
  input.onchange = async () => {
    for (const f of input.files) {
      if (photos.length >= 10) break;
      try { photos.push(await compressImage(f)); } catch (ex) { toast(ex.message, true); }
    }
    input.value = '';
    draw();
  };
  return () => photos.slice();
}

async function loadMachineList() {
  if (state.machineList && Date.now() - state.machineListAt < 5 * 60 * 1000) return state.machineList;
  try {
    state.machineList = (await api('/lookup/machines')).machines;
    state.machineListAt = Date.now();
  } catch { state.machineList = state.machineList || []; }
  return state.machineList;
}

function helperOptions(n) {
  return Array.from({ length: state.pub.maxHelpers + 1 }, (_, i) => `<option value="${i}" ${Number(n) === i ? 'selected' : ''}>${i === 0 ? 'No helper' : i + (i === 1 ? ' helper' : ' helpers')}</option>`).join('');
}

function completeForm(base, d, reload) {
  const after = [['', 'No service needed'], ['7', 'After 1 week'], ['15', 'After 15 days'], ['30', 'After 1 month'], ['60', 'After 2 months'], ['90', 'After 3 months'], ['180', 'After 6 months'], ['365', 'After 1 year'], ['date', 'Choose a date…']];
  openModal(`<h2>${jobName(d)} completed</h2>
    <div class="muted">${esc(d.unitName)} · ${esc(fmtDate(d.date))}${d.customer ? ' · ' + esc(d.customer) : ''}</div>
    <p class="small">The completed time is saved now (${esc(fmtTime(new Date().toISOString()))}) and the team becomes free for other jobs today.</p>
    <label>📒 Service book photo (customer remarks)</label>
    <div class="muted small">Take a photo of the page where the customer wrote remarks / signed. You can add more than one.</div>
    <div id="c-photos"></div>
    <label>Note (optional)</label><input name="note" placeholder="e.g. installed and running, customer signed">
    <label>Service needed later?</label><select name="serviceAfter" id="svc-after">${after.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <div id="svc-more" hidden>
      <div class="form-grid">
        <div id="svc-date-wrap" hidden><label>Service date</label><input type="date" name="serviceDate" min="${esc(state.today)}" value="${esc(addDays(state.today, 30))}"></div>
        <div><label>Time</label><select name="serviceSession">${state.pub.sessions.map((s) => `<option value="${s}">${SESSION_NAMES[s]}</option>`).join('')}</select></div>
        <div><label>Helpers for service</label><select name="serviceHelpers">${helperOptions(0)}</select></div>
      </div>
      <label>What service?</label><input name="serviceNotes" placeholder="e.g. first free service, oil change">
      <p class="muted small">A service person (installation person) is picked automatically, the same fair way.</p>
    </div>
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">✓ Mark completed</button></div>`,
  async (fd) => {
    await api(`${base}/deliveries/${d.id}/complete`, { method: 'POST', body: { ...Object.fromEntries(fd), photos: getPhotos() } });
    toast(fd.get('serviceAfter') ? 'Completed – service booked' : 'Completed – team is free');
    reload();
  });
  const getPhotos = photoPicker(document.getElementById('c-photos'));
  const sel = document.getElementById('svc-after');
  sel.onchange = () => {
    document.getElementById('svc-more').hidden = !sel.value;
    document.getElementById('svc-date-wrap').hidden = sel.value !== 'date';
  };
}

// d = existing job to edit; preset = values for a new job (e.g. a service from a delivery)
function deliveryForm(base, d, reload, presetDate, preset) {
  const isAdmin = base === '/admin';
  const def = state.defaultHelpers ?? 2;
  const v = d || { type: 'delivery', date: presetDate || state.today, session: 'FULL', helpersNeeded: def, installation: false, customer: '', customerPhone: '', address: '', machine: '', notes: '', unitId: '', ...(preset || {}), ...(preset ? { date: presetDate || state.today } : {}) };
  const units = isAdmin ? A().units.filter((u) => u.active) : [];
  const lockUnit = !!d || !!(preset && preset.parentId);
  openModal(`<h2>${d ? 'Edit ' + jobName(v).toLowerCase() : v.parentId ? 'Book service' : 'New job'}</h2>
    ${v.parentId ? `<div class="muted small">Follow-up for ${esc(v.customer || 'this customer')}${v.machine ? ' · ' + esc(v.machine) : ''}</div><input type="hidden" name="parentId" value="${esc(v.parentId)}">` : ''}
    ${isAdmin ? `<label>Unit *</label><select name="unitId" ${lockUnit ? 'disabled' : ''} required>${units.map((u) => `<option value="${esc(u.id)}" ${v.unitId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>${lockUnit ? `<input type="hidden" name="unitId" value="${esc(v.unitId)}">` : ''}` : ''}
    <div class="form-grid">
      <div><label>Type</label><select name="type" id="f-type"><option value="delivery">🚚 Delivery</option><option value="service" ${v.type === 'service' ? 'selected' : ''}>🔧 Service</option></select></div>
      <div><label id="f-date-l">Date *</label><input type="date" name="date" required value="${esc(v.date)}" min="${esc(state.today)}"></div>
      <div><label>Time</label><select name="session">${state.pub.sessions.map((s) => `<option value="${s}" ${v.session === s ? 'selected' : ''}>${SESSION_NAMES[s]}</option>`).join('')}</select></div>
      <div><label>Helpers needed *</label><select name="helpersNeeded">${helperOptions(v.helpersNeeded)}</select></div>
      <div><label id="f-inst-l">Installation person needed?</label><select name="installation"><option value="no">No</option><option value="yes" ${v.installation ? 'selected' : ''}>Yes</option></select></div>
    </div>
    <h3 style="margin:14px 0 0">👤 Customer</h3>
    <div class="form-grid">
      <div class="lookup"><label>Customer / party name</label><input name="customer" id="f-cust" autocomplete="off" value="${esc(v.customer)}" placeholder="type name, phone or city to search">
        <div id="f-cust-list" class="lookup-list" hidden></div></div>
      <div><label>Customer phone</label><input name="customerPhone" type="tel" value="${esc(v.customerPhone)}"></div>
    </div>
    <label>Address</label><textarea name="address">${esc(v.address)}</textarea>
    <h3 style="margin:14px 0 0">⚙️ Machines</h3>
    <div class="muted small">Pick from your machine list or type a model. Add one line per model.</div>
    <div id="f-items"></div>
    <button type="button" class="link" id="f-add-item">+ Add another model</button>
    <datalist id="machine-list"></datalist>
    <label id="f-notes-l">Notes</label><input name="notes" value="${esc(v.notes)}" placeholder="e.g. 2nd floor, no lift">
    <p class="muted small">People are picked fairly from all units. "Morning" and "Afternoon" jobs can share people; a "Full day" job keeps them the whole day.</p>
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">${d ? 'Save' : 'Book'}</button></div>`,
  async (fd) => {
    const body = Object.fromEntries(fd);
    body.items = readItems();
    if (d) await api(`${base}/deliveries/${d.id}`, { method: 'PUT', body });
    else await api(`${base}/deliveries`, { method: 'POST', body });
    toast(d ? 'Saved' : 'Booked – team assigned');
    reload();
  });
  // Machines: one line per model with quantity.
  const itemsEl = document.getElementById('f-items');
  const itemRow = (it) => `<div class="row item-row" style="margin-top:6px;flex-wrap:nowrap">
      <input class="it-label" list="machine-list" placeholder="Machine / model" value="${esc(it.label)}" style="flex:1">
      <input class="it-qty" type="number" min="1" max="999" value="${esc(it.qty || 1)}" style="width:72px" title="Quantity">
      <button type="button" class="link danger it-del" title="Remove">✕</button></div>`;
  const startItems = (v.items && v.items.length ? v.items : v.machine ? [{ label: v.machine, qty: 1 }] : [{ label: '', qty: 1 }]);
  const addItem = (it) => {
    itemsEl.insertAdjacentHTML('beforeend', itemRow(it));
    const r = itemsEl.lastElementChild;
    r.querySelector('.it-del').onclick = () => { r.remove(); if (!itemsEl.children.length) addItem({ label: '', qty: 1 }); };
    r.querySelector('.it-label').onkeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); };
  };
  startItems.forEach(addItem);
  document.getElementById('f-add-item').onclick = () => { if (itemsEl.children.length < 20) { addItem({ label: '', qty: 1 }); itemsEl.lastElementChild.querySelector('.it-label').focus(); } };
  function readItems() {
    return [...itemsEl.querySelectorAll('.item-row')].map((r) => ({ label: r.querySelector('.it-label').value.trim(), qty: Number(r.querySelector('.it-qty').value) || 1 })).filter((i) => i.label);
  }
  loadMachineList().then((list) => {
    document.getElementById('machine-list').innerHTML = list.map((m) => `<option value="${esc(m)}"></option>`).join('');
  });
  // Customer search from the Google Sheet client list.
  const cust = document.getElementById('f-cust');
  const custList = document.getElementById('f-cust-list');
  let timer = null;
  let found = [];
  const pick = (c) => {
    cust.value = c.name;
    const f = (n) => modalBody.querySelector(`[name=${n}]`);
    if (c.phone || c.phone2) f('customerPhone').value = c.phone || c.phone2;
    const addr = [c.address, c.city && !c.address.toUpperCase().includes(c.city.toUpperCase()) ? c.city : ''].filter(Boolean).join(', ');
    if (addr) f('address').value = addr;
    custList.hidden = true;
  };
  cust.oninput = () => {
    clearTimeout(timer);
    const q = cust.value.trim();
    if (q.length < 2) { custList.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        found = (await api('/lookup/clients?q=' + encodeURIComponent(q))).clients;
      } catch { found = []; }
      custList.innerHTML = found.length
        ? found.map((c, i) => `<button type="button" data-i="${i}"><b>${esc(c.name)}</b><span class="small muted">${esc([c.city, c.phone].filter(Boolean).join(' · '))}</span></button>`).join('')
        : '<div class="small muted" style="padding:8px">Not in the client list – just type the details.</div>';
      custList.hidden = false;
      custList.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => pick(found[Number(b.dataset.i)])));
    }, 200);
  };
  cust.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (found[0] && !custList.hidden) pick(found[0]); }
    if (e.key === 'Escape') custList.hidden = true;
  };
  cust.onblur = () => setTimeout(() => (custList.hidden = true), 200);
  const type = document.getElementById('f-type');
  const sync = () => {
    const svc = type.value === 'service';
    document.getElementById('f-inst-l').textContent = svc ? 'Service person (technician) needed?' : 'Installation person needed?';
    document.getElementById('f-date-l').textContent = svc ? 'Service date *' : 'Delivery date *';
    document.getElementById('f-notes-l').textContent = svc ? 'What service?' : 'Notes';
  };
  type.onchange = () => {
    if (!d && type.value === 'service') {
      modalBody.querySelector('[name=installation]').value = 'yes';
      modalBody.querySelector('[name=helpersNeeded]').value = '0';
    }
    sync();
  };
  sync();
}

function askExtra(base, d, reload) {
  openModal(`<h2>Emergency person</h2>
    <div class="muted">${esc(d.unitName)} · ${esc(fmtDate(d.date))} · ${esc(SESSION_NAMES[d.session])}</div>
    <label>Person</label><div id="x-list" class="muted">Loading…</div>
    <div id="x-role-wrap" hidden><label>Use as</label><select name="role"><option value="helper">Helper</option><option value="installer">Installation person</option></select></div>
    <label>Reason (optional)</label><input name="reason" placeholder="e.g. heavy machine, helper absent">
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok" id="x-ok">Add this person</button></div>`,
  async (fd) => {
    const personId = fd.get('personId');
    if (!personId) throw new Error('Choose a person');
    const opt = document.querySelector('#x-person option:checked');
    if (opt && opt.dataset.at && !confirm(`${opt.dataset.name} is on a delivery of ${opt.dataset.at}. Move them to you? ${opt.dataset.at} will be told and get someone else if anyone is free.`)) throw new Error('Not moved');
    await api(`${base}/deliveries/${d.id}/extra`, { method: 'POST', body: { personId, role: fd.get('role'), reason: fd.get('reason') } });
    toast('Emergency person added');
    reload();
  });
  (async () => {
    const box = document.getElementById('x-list');
    try {
      const r = await api(`${base}/deliveries/${d.id}/people`);
      const note = { free: 'free', other: 'on delivery of ', emergency: 'emergency at ', mine: 'already on this delivery' };
      const usable = r.people.filter((p) => p.status === 'free' || p.status === 'other');
      document.getElementById('x-ok').disabled = !usable.length;
      box.innerHTML = r.people.length
        ? `<select name="personId" id="x-person">${r.people.map((p) => {
            const can = p.status === 'free' || p.status === 'other';
            const where = p.status === 'other' || p.status === 'emergency' ? note[p.status] + p.at : note[p.status];
            return `<option value="${esc(p.id)}" ${can ? '' : 'disabled'} data-role="${esc(p.role)}" data-name="${esc(p.name)}" data-at="${p.status === 'other' ? esc(p.at) : ''}">${p.backup ? '🆘 ' : ''}${esc(p.name)} (${esc(ROLE_NAMES[p.role])}${p.unitName ? ', ' + esc(p.unitName) : ''}) – ${esc(where)}</option>`;
          }).join('')}</select>
          <div class="small muted" id="x-hint" style="margin-top:6px"></div>`
        : '<div class="error">Nobody is available that day (all inactive or on leave). Please call the admin.</div>';
      const sel = document.getElementById('x-person');
      if (!sel) return;
      const sync = () => {
        const o = sel.options[sel.selectedIndex];
        document.getElementById('x-role-wrap').hidden = !o || o.dataset.role !== 'both';
        document.getElementById('x-hint').innerHTML = o && o.dataset.at
          ? `<span class="badge warn" style="white-space:normal">${esc(o.dataset.name)} will move from ${esc(o.dataset.at)} to you. ${esc(o.dataset.at)} will see this.</span>`
          : '🆘 = emergency backup person. Free people are at the top of the list.';
      };
      sel.onchange = sync;
      const firstUsable = [...sel.options].find((o) => !o.disabled);
      if (firstUsable) sel.value = firstUsable.value;
      sync();
    } catch (ex) { box.innerHTML = `<div class="error">${esc(ex.message)}</div>`; }
  })();
}

function groupByDate(list, today, render) {
  const dates = [...new Set(list.map((d) => d.date))];
  return dates.map((date) => `<div class="section"><h2>${date === today ? 'Today · ' : ''}${esc(fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
    <div class="grid">${list.filter((d) => d.date === date).map(render).join('')}</div></div>`).join('');
}

// ---------- unit view ----------
async function renderUnit() {
  if (!document.querySelector('.wrap')) {
    $app.innerHTML = topbar('Unit: ' + state.me.name) + '<div class="wrap"><div class="loading">Loading…</div></div>';
    bindLogout();
  }
  const data = await api('/unit/home');
  const t = data.today;
  state.today = t;
  state.defaultHelpers = data.defaultHelpers;
  const all = data.deliveries;
  const pendingPast = all.filter((d) => d.date < t && isOpenJob(d));
  const upcoming = all.filter((d) => d.date >= t);
  const done = all.filter((d) => d.date < t && d.status === 'done').reverse();
  const todays = upcoming.filter((d) => d.date === t);
  const todayOpen = todays.filter(isOpenJob).length;
  const open = upcoming.filter(isOpenJob).reduce((n, d) => n + d.open, 0);
  const wrap = $app.querySelector('.wrap');
  wrap.innerHTML = `<div class="hero"><div class="label">Today · ${esc(fmtDate(t))}</div>
      <div class="big">${todays.length ? `${todays.length} job${todays.length > 1 ? 's' : ''} today${todayOpen < todays.length ? ` · ${todays.length - todayOpen} completed` : ''}` : 'No job today'}</div>
      <div class="line">${upcoming.filter(isOpenJob).length} open${open ? ` · <b>${open} place(s) still open</b> – use 🆘 Emergency person` : ''}</div>
      <div class="row"><a class="call" href="#" id="book">+ Book delivery / service</a></div></div>
    ${pendingPast.length ? `<div class="section"><h2>⚠ Earlier jobs not marked completed</h2><div class="grid">${pendingPast.map((d) => deliveryCard(d, 'unit', t)).join('')}</div></div>` : ''}
    ${upcoming.length ? groupByDate(upcoming, t, (d) => deliveryCard(d, 'unit', t)) : '<div class="card muted">Nothing booked. Tap "Book delivery / service", choose how many helpers and if an installation / service person is needed – the team is picked automatically.</div>'}
    ${done.length ? `<details class="card"><summary><b>Completed – last 30 days (${done.length})</b></summary><div class="grid" style="margin-top:10px">${done.map((d) => deliveryCard(d, 'unit', t)).join('')}</div></details>` : ''}`;
  document.getElementById('book').onclick = (e) => { e.preventDefault(); deliveryForm('/unit', null, renderUnit); };
  bindDeliveryButtons(wrap, '/unit', all, renderUnit);
}

// ---------- staff view ----------
async function renderStaff() {
  $app.innerHTML = topbar(state.me.name) + '<div class="wrap"><div class="loading">Loading…</div></div>';
  bindLogout();
  const data = await api('/staff/home');
  const todays = data.jobs.filter((j) => j.date === data.today);
  const hero = todays.length
    ? todays.map((j) => `<div class="hero${j.status === 'done' ? ' off' : ''}"><div class="label">Today · ${esc(SESSION_NAMES[j.session])} · ${j.type === 'service' ? '🔧 service' : 'delivery'} · you are ${j.myRole === 'installer' ? (j.type === 'service' ? 'service person' : 'installation person') : 'helper'}${j.extra ? ' (emergency)' : ''}${j.status === 'done' ? ' · ✓ completed' : j.status === 'started' ? ' · started' : ''}</div>
        <div class="big">${esc(j.unitName)}</div>
        ${j.customer ? `<div class="line">👤 ${esc(j.customer)}${j.machine ? ' · ' + esc(j.machine) : ''}</div>` : ''}
        ${j.address ? `<div class="line">📍 ${esc(j.address)}</div>` : ''}
        ${j.notes ? `<div class="line">📝 ${esc(j.notes)}</div>` : ''}
        <div class="line small">Team: ${j.team.filter((x) => x.person).map((x) => esc(x.person.name)).join(', ')}</div>
        <div class="row">${j.unit && j.unit.phone ? `<a class="call" href="tel:${esc(j.unit.phone.replace(/[^\d+]/g, ''))}">📞 Call unit</a>` : ''}
        ${j.address ? `<a class="call" target="_blank" rel="noopener" href="${mapLink(j.address)}">🗺️ Map</a>` : ''}</div></div>`).join('')
    : `<div class="hero off"><div class="label">Today · ${esc(fmtDate(data.today))}</div><div class="big">${data.leaves.some((l) => l.from <= data.today) ? 'You are on leave' : 'No job today'}</div></div>`;
  const later = data.jobs.filter((j) => j.date > data.today);
  $app.querySelector('.wrap').innerHTML = `${hero}
    <div class="row section"><h2 style="margin:0">Next jobs</h2><div class="spacer"></div><span class="badge ok">${data.monthDuties} job${data.monthDuties === 1 ? '' : 's'} this month</span></div>
    ${later.length ? `<div class="grid">${later.map((d) => deliveryCard(d, 'staff', data.today)).join('')}</div>` : '<div class="card muted">Nothing planned yet.</div>'}`;
}

// ---------- admin ----------
const TABS = [
  ['today', 'Today'],
  ['deliveries', 'Deliveries'],
  ['units', 'Units'],
  ['people', 'Helpers & installers'],
  ['leaves', 'Leave'],
  ['report', 'Report'],
  ['sheet', 'Clients & machines'],
  ['settings', 'Settings'],
];

async function loadAdmin() {
  const q = state.from ? `?from=${state.from}&to=${state.to}` : '';
  state.admin = await api('/admin/data' + q);
  state.today = state.admin.today;
  state.defaultHelpers = state.admin.settings.defaultHelpers;
  if (!state.from) { state.from = state.admin.from; state.to = state.admin.to; }
}

async function renderAdmin() {
  if (!document.querySelector('.tabs')) {
    $app.innerHTML = topbar('Admin: ' + state.me.name) +
      `<nav class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</nav><div class="wrap" id="main"><div class="loading">Loading…</div></div>`;
    bindLogout();
    $app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderAdmin(); }));
  }
  $app.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  try {
    await loadAdmin();
  } catch (ex) {
    if (state.me) document.getElementById('main').innerHTML = `<div class="error">${esc(ex.message)}</div>`;
    return;
  }
  const main = document.getElementById('main');
  const views = { today: adminToday, deliveries: adminDeliveries, units: adminUnits, people: adminPeople, leaves: adminLeaves, report: adminReport, sheet: adminSheet, settings: adminSettings };
  await views[state.tab](main);
}

const A = () => state.admin;
const personOf = (id) => A().people.find((p) => p.id === id) || A().allPeople.find((p) => p.id === id);
const onLeaveOn = (personId, date) => A().leaves.some((l) => l.personId === personId && l.from <= date && date <= l.to);
const canDo = (p, role) => p.role === role || p.role === 'both';

// --- Today ---
async function adminToday(main) {
  const t = A().today;
  if (!A().units.length || !A().people.length) {
    main.innerHTML = `<div class="card"><h2>Welcome! Let's set things up</h2>
      <ol><li>Go to <b>Units</b> and add your units (each gets its own login).</li>
      <li>Go to <b>Helpers &amp; installers</b> and add each unit's helpers and installation persons. Tick <b>Emergency backup</b> for people who should only be used when the others are short.</li>
      <li>Each unit logs in and books a delivery or service: date, how many helpers, installation yes/no.</li>
      <li>The team is picked automatically and fairly from all units. Units can ask for an 🆘 emergency person any time, and mark the job ✓ Completed when done.</li></ol></div>`;
    return;
  }
  // Today's jobs may be outside the chosen range; fetch today explicitly, plus older open jobs.
  const day = await api(`/admin/data?from=${t}&to=${t}`);
  const older = await api(`/admin/data?from=${addDays(t, -30)}&to=${addDays(t, -1)}`);
  const todays = day.deliveries.filter((d) => d.status !== 'cancelled').sort((a, b) => (isOpenJob(b) ? 1 : 0) - (isOpenJob(a) ? 1 : 0));
  const pendingPast = older.deliveries.filter(isOpenJob);
  const openToday = todays.filter(isOpenJob);
  const busy = new Set(openToday.flatMap((d) => d.team.filter((x) => x.person).map((x) => x.person.id)));
  const free = A().people.filter((p) => p.active && !busy.has(p.id));
  const tag = (p) => `${esc(p.name)} ${onLeaveOn(p.id, t) ? '<span class="badge warn">leave</span>' : p.backup ? '<span class="badge bad">backup</span>' : ''}`;
  const doneCount = todays.length - openToday.length;
  main.innerHTML = `<div class="row section"><div><h1>Today · ${esc(fmtDate(t, { weekday: 'long', day: 'numeric', month: 'long' }))}</h1>
      <div class="muted">${todays.length} job${todays.length === 1 ? '' : 's'}${doneCount ? ` · ${doneCount} completed` : ''} · ${busy.size} people out now${openToday.some((d) => d.open) ? ` · <b class="empty">${openToday.reduce((n, d) => n + d.open, 0)} place(s) open</b>` : ''}</div></div>
      <div class="spacer"></div><button class="primary" id="add">+ New job</button></div>
    ${pendingPast.length ? `<div class="section"><h2>⚠ Earlier jobs not marked completed</h2><div class="grid">${pendingPast.map((d) => deliveryCard(d, 'admin', t)).join('')}</div></div>` : ''}
    ${todays.length ? `<div class="grid">${todays.map((d) => deliveryCard(d, 'admin', t)).join('')}</div>` : '<div class="card muted">No job today.</div>'}
    <div class="card" style="margin-top:12px"><h3>Free now (not on an open job)</h3>
      <div class="small"><b>Helpers:</b> ${free.filter((p) => canDo(p, 'helper')).map(tag).join(' &nbsp; ') || '<span class="muted">none</span>'}</div>
      <div class="small" style="margin-top:4px"><b>Installation / service:</b> ${free.filter((p) => canDo(p, 'installer')).map(tag).join(' &nbsp; ') || '<span class="muted">none</span>'}</div></div>`;
  document.getElementById('add').onclick = () => deliveryForm('/admin', null, renderAdmin, t);
  bindDeliveryButtons(main, '/admin', [...todays, ...pendingPast], renderAdmin);
}

function changePlace(d, role, slot) {
  const current = d.team.find((t) => t.role === role && t.slot === slot && !t.extra);
  const opts = A().people.filter((p) => p.active && canDo(p, role)).map((p) => {
    const leave = onLeaveOn(p.id, d.date);
    const there = A().deliveries.find((x) => x.date === d.date && isOpenJob(x) && x.team.some((t) => t.person && t.person.id === p.id) && (x.id === d.id || x.session === 'FULL' || d.session === 'FULL' || x.session === d.session));
    const note = leave ? ' — on leave' : there && !(current && current.person && current.person.id === p.id) ? ` — on ${there.id === d.id ? 'this delivery' : there.unitName + ' delivery'} (will swap)` : '';
    return `<option value="${esc(p.id)}" ${current && current.person && current.person.id === p.id ? 'selected' : ''} ${leave ? 'disabled' : ''}>${p.backup ? '🆘 ' : ''}${esc(p.name)} (${esc(p.unitName || 'no unit')})${esc(note)}</option>`;
  }).join('');
  openModal(`<h2>Change ${role === 'installer' ? 'installation person' : 'helper'}</h2>
    <div class="muted">${esc(d.unitName)} · ${esc(fmtDate(d.date))} · ${esc(SESSION_NAMES[d.session])} · ${esc(placeName({ role, slot }, d))}</div>
    <label>Person</label><select name="personId" required><option value="">— choose —</option>${opts}</select>
    <p class="muted small">Only people of the matching kind are listed. If you only want someone else (anyone), close this and use "Absent – replace".</p>
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
  async (fd) => {
    if (!fd.get('personId')) throw new Error('Choose a person');
    await api(`/admin/deliveries/${d.id}/assign`, { method: 'POST', body: { role, slot, personId: fd.get('personId') } });
    toast('Saved');
    renderAdmin();
  });
}

// --- Deliveries ---
function adminDeliveries(main) {
  const t = A().today;
  const f = state.filter || { type: '', status: 'active' };
  const list = A().deliveries.filter((d) => (!f.type || d.type === f.type) &&
    (f.status === 'all' || (f.status === 'active' && d.status !== 'cancelled') || (f.status === 'open' && isOpenJob(d)) || (f.status === 'done' && d.status === 'done') || (f.status === 'cancelled' && d.status === 'cancelled')));
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`;
  main.innerHTML = `<div class="row section no-print">
      <button id="prev">◀ Prev</button><button id="this">Next 2 weeks</button><button id="next">Next ▶</button>
      <input type="date" id="from" value="${esc(A().from)}" style="width:auto"> to <input type="date" id="to" value="${esc(A().to)}" style="width:auto">
      <button id="go">Show</button>
      <select id="ft" style="width:auto">${opt('', 'Deliveries + services', f.type)}${opt('delivery', '🚚 Deliveries only', f.type)}${opt('service', '🔧 Services only', f.type)}</select>
      <select id="fs" style="width:auto">${opt('active', 'All except cancelled', f.status)}${opt('open', 'Open only', f.status)}${opt('done', 'Completed only', f.status)}${opt('cancelled', 'Cancelled', f.status)}${opt('all', 'Everything', f.status)}</select>
      <div class="spacer"></div>
      <button id="print">🖨️ Print</button><button id="rebal">↻ Re-balance</button><button class="primary" id="add">+ New job</button></div>
    <h2 class="print-only">${esc(state.pub.orgName)} – ${esc(fmtDate(A().from))} to ${esc(fmtDate(A().to))}</h2>
    <p class="muted small no-print">${list.length} job(s) · ${list.filter((d) => d.status === 'done').length} completed · ${list.filter((d) => d.type === 'service').length} service(s)</p>
    ${list.length ? groupByDate(list, t, (d) => deliveryCard(d, 'admin', t)) : '<div class="card muted">No jobs match.</div>'}`;
  const go = (from, to) => { state.from = from; state.to = to; renderAdmin(); };
  document.getElementById('prev').onclick = () => go(addDays(state.from, -14), addDays(state.to, -14));
  document.getElementById('next').onclick = () => go(addDays(state.from, 14), addDays(state.to, 14));
  document.getElementById('this').onclick = () => go(t, addDays(t, 13));
  document.getElementById('go').onclick = () => go(document.getElementById('from').value, document.getElementById('to').value);
  document.getElementById('ft').onchange = (e) => { state.filter = { ...f, type: e.target.value }; adminDeliveries(main); };
  document.getElementById('fs').onchange = (e) => { state.filter = { ...f, status: e.target.value }; adminDeliveries(main); };
  document.getElementById('print').onclick = () => window.print();
  document.getElementById('add').onclick = () => deliveryForm('/admin', null, renderAdmin);
  document.getElementById('rebal').onclick = () => openModal(`<h2>Re-balance teams</h2>
      <p>Teams normally stay as they are once made. Re-balance makes all open teams again from the chosen day, using the fairness rules. Past and completed jobs never change.</p>
      <label>Starting from</label><input type="date" name="from" value="${esc(addDays(t, 1))}" min="${esc(t)}">
      <label class="check"><input type="checkbox" name="keepManual" checked> Keep my manual changes</label>
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Re-balance</button></div>`,
    async (fd) => {
      await api('/admin/rebalance', { method: 'POST', body: { from: fd.get('from'), keepManual: fd.get('keepManual') === 'on' } });
      toast('Teams re-balanced');
      renderAdmin();
    });
  bindDeliveryButtons(main, '/admin', list, renderAdmin);
}

// --- Units ---
function adminUnits(main) {
  const rows = A().units.map((u) => {
    const mine = A().people.filter((p) => p.unitId === u.id);
    const list = (role) => mine.filter((p) => canDo(p, role)).map((p) => `${esc(p.name)}${p.backup ? ' 🆘' : ''}${p.active ? '' : ' <span class="badge">inactive</span>'}`).join(', ') || '<span class="muted">—</span>';
    return `<tr>
      <td><b>${esc(u.name)}</b>${u.address ? `<div class="muted small">${esc(u.address)}</div>` : ''}</td>
      <td>${esc(u.contactName)}<div class="small">${telLink(u.phone)}</div></td>
      <td class="small">${list('helper')}</td>
      <td class="small">${list('installer')}</td>
      <td><code>${esc(u.username)}</code></td>
      <td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
      <td><button class="link" data-edit="${esc(u.id)}">Edit</button><button class="link" data-addp="${esc(u.id)}">+ Person</button></td></tr>`;
  }).join('');
  main.innerHTML = `<div class="row section"><h1>Units</h1><div class="spacer"></div><button class="primary" id="add">+ Add unit</button></div>
    ${A().units.length ? `<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Contact</th><th>Helpers</th><th>Installation</th><th>Login ID</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="card muted">No units yet. Add your first unit.</div>'}
    <p class="muted small">🆘 = emergency backup person. Everyone is shared across all units for deliveries.</p>`;
  document.getElementById('add').onclick = () => unitForm();
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => unitForm(A().units.find((u) => u.id === b.dataset.edit))));
  main.querySelectorAll('[data-addp]').forEach((b) => (b.onclick = () => personForm(null, b.dataset.addp)));
}

function unitForm(u) {
  const v = u || { name: '', contactName: '', phone: '', address: '', username: '', active: true };
  openModal(`<h2>${u ? 'Edit unit' : 'Add unit'}</h2>
    <div class="form-grid">
      <div><label>Unit name *</label><input name="name" required value="${esc(v.name)}"></div>
      <div><label>Contact person</label><input name="contactName" value="${esc(v.contactName)}"></div>
      <div><label>Phone</label><input name="phone" type="tel" value="${esc(v.phone)}"></div>
    </div>
    <label>Address</label><textarea name="address">${esc(v.address)}</textarea>
    <div class="form-grid">
      <div><label>Login ID *</label><input name="username" autocapitalize="none" value="${esc(v.username)}" placeholder="e.g. unit1"></div>
      <div><label>Password ${u ? '(leave blank to keep)' : '*'}</label><input name="password" type="text" autocomplete="new-password" ${u ? '' : 'required'}></div>
    </div>
    <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active (can book deliveries)</label>
    <div class="actions">${u ? '<button type="button" class="danger" id="del">Remove</button><div class="spacer"></div>' : ''}<button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
  async (fd) => {
    const body = { name: fd.get('name'), contactName: fd.get('contactName'), phone: fd.get('phone'), address: fd.get('address'), username: fd.get('username'), password: fd.get('password'), active: fd.get('active') === 'on' };
    await api(u ? `/admin/units/${u.id}` : '/admin/units', { method: u ? 'PUT' : 'POST', body });
    toast(u ? 'Unit updated' : 'Unit added – now add its helpers');
    renderAdmin();
  });
  const del = document.getElementById('del');
  if (del) del.onclick = async () => {
    if (!confirm(`Remove ${u.name}? Its future deliveries are cancelled. Past history is kept.`)) return;
    try { await api(`/admin/units/${u.id}`, { method: 'DELETE' }); modal.close(); toast('Unit removed'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  };
}

// --- People ---
function adminPeople(main) {
  const units = A().units;
  const t = A().today;
  const row = (p) => `<tr>
    <td><b>${esc(p.name)}</b></td><td>${roleBadge(p.role)} ${p.backup ? '<span class="badge bad">🆘 Backup</span>' : ''}</td>
    <td>${esc(p.unitName || '—')}</td><td>${telLink(p.phone)}</td>
    <td>${p.canLogin ? `<code>${esc(p.username)}</code>` : '<span class="muted small">no login</span>'}</td>
    <td>${!p.active ? '<span class="badge">Inactive</span>' : onLeaveOn(p.id, t) ? '<span class="badge warn">On leave</span>' : '<span class="badge ok">Active</span>'}</td>
    <td><button class="link" data-edit="${esc(p.id)}">Edit</button></td></tr>`;
  const sorted = A().people.slice().sort((a, b) => (a.unitName || '').localeCompare(b.unitName || '') || a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  const count = (role) => A().people.filter((p) => p.active && canDo(p, role) && !p.backup).length;
  main.innerHTML = `<div class="row section"><div><h1>Helpers &amp; installation persons</h1>
      <div class="muted small">${count('helper')} regular helpers · ${count('installer')} regular installation persons · ${A().people.filter((p) => p.active && p.backup).length} emergency backup</div></div>
      <div class="spacer"></div><button class="primary" id="add">+ Add person</button></div>
    ${A().people.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Work</th><th>Unit</th><th>Phone</th><th>Login</th><th>Status</th><th></th></tr></thead><tbody>${sorted.map(row).join('')}</tbody></table></div>` : `<div class="card muted">${units.length ? 'No people yet. Add your helpers and installation persons.' : 'Add a unit first.'}</div>`}
    <p class="muted small">Everyone is shared across all units, and work is shared equally. <b>Emergency backup</b> people are only used when regular people are not enough, or when a unit picks them for an emergency. A new person starts level with the others.</p>`;
  document.getElementById('add').onclick = () => personForm();
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => personForm(A().people.find((p) => p.id === b.dataset.edit))));
}

function personForm(p, unitId) {
  const v = p || { name: '', phone: '', role: 'helper', unitId: unitId || (A().units[0] || {}).id || '', backup: false, username: '', canLogin: false, active: true };
  openModal(`<h2>${p ? 'Edit person' : 'Add helper / installation person'}</h2>
    <div class="form-grid">
      <div><label>Name *</label><input name="name" required value="${esc(v.name)}"></div>
      <div><label>Phone</label><input name="phone" type="tel" value="${esc(v.phone)}"></div>
      <div><label>Unit</label><select name="unitId"><option value="">— no unit / common —</option>${A().units.map((u) => `<option value="${esc(u.id)}" ${v.unitId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
      <div><label>Work *</label><select name="role">${Object.entries(ROLE_NAMES).map(([k, l]) => `<option value="${k}" ${v.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <label class="check"><input type="checkbox" name="backup" ${v.backup ? 'checked' : ''}> 🆘 Emergency backup (only used when others are short or picked for an emergency)</label>
    <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active</label>
    <h3 style="margin-top:14px">Login (optional)</h3>
    <div class="muted small">Give a PIN if this person should log in and see their deliveries.</div>
    <div class="form-grid">
      <div><label>Login ID</label><input name="username" autocapitalize="none" value="${esc(v.username)}" placeholder="defaults to phone number"></div>
      <div><label>Password / PIN ${v.canLogin ? '(leave blank to keep)' : ''}</label><input name="password" type="text" autocomplete="new-password"></div>
    </div>
    ${v.canLogin ? '<label class="check"><input type="checkbox" name="removeLogin"> Remove login</label>' : ''}
    <div class="actions">${p ? '<button type="button" class="danger" id="del">Remove</button><div class="spacer"></div>' : ''}<button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
  async (fd) => {
    const body = {
      name: fd.get('name'), phone: fd.get('phone'), unitId: fd.get('unitId'), role: fd.get('role'), backup: fd.get('backup') === 'on',
      username: fd.get('username'), password: fd.get('password'), active: fd.get('active') === 'on', removeLogin: fd.get('removeLogin') === 'on',
    };
    await api(p ? `/admin/people/${p.id}` : '/admin/people', { method: p ? 'PUT' : 'POST', body });
    toast(p ? 'Saved' : 'Person added');
    renderAdmin();
  });
  const del = document.getElementById('del');
  if (del) del.onclick = async () => {
    if (!confirm(`Remove ${p.name}? They are taken off future deliveries (and replaced). Past history is kept.`)) return;
    try { await api(`/admin/people/${p.id}`, { method: 'DELETE' }); modal.close(); toast('Person removed'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  };
}

// --- Leave ---
function adminLeaves(main) {
  const t = A().today;
  const opts = A().people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(ROLE_NAMES[p.role])}${p.unitName ? ', ' + esc(p.unitName) : ''})</option>`).join('');
  const rows = A().leaves.map((l) => {
    const p = personOf(l.personId);
    const status = l.to < t ? '<span class="badge">Past</span>' : l.from <= t ? '<span class="badge warn">Now</span>' : '<span class="badge ok">Upcoming</span>';
    return `<tr><td><b>${esc(p ? p.name : '(removed)')}</b></td><td>${esc(fmtDate(l.from))}${l.to !== l.from ? ' → ' + esc(fmtDate(l.to)) : ''}</td><td>${esc(l.reason)}</td><td>${status}</td>
      <td>${l.to >= t ? `<button class="link" data-del="${esc(l.id)}">Cancel leave</button>` : ''}</td></tr>`;
  }).join('');
  main.innerHTML = `<h1>Leave / absence</h1>
    <form class="card section" id="leave-form"><div class="form-grid">
      <div><label>Person</label><select name="personId" required>${opts}</select></div>
      <div><label>From</label><input type="date" name="from" value="${esc(t)}" required></div>
      <div><label>To</label><input type="date" name="to" value="${esc(t)}" required></div>
      <div><label>Reason</label><input name="reason" placeholder="optional"></div></div>
      <div style="margin-top:12px"><button class="primary">Add leave</button></div>
      <p class="muted small">If the person was on a delivery in these days, only their place is filled by someone free; the rest of the team stays.</p></form>
    ${A().leaves.length ? `<div class="table-wrap"><table><thead><tr><th>Person</th><th>Dates</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
  const form = document.getElementById('leave-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/admin/leaves', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      toast('Leave added – teams updated');
      renderAdmin();
    } catch (ex) { toast(ex.message, true); }
  };
  main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    try { await api(`/admin/leaves/${b.dataset.del}`, { method: 'DELETE' }); toast('Leave cancelled'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  }));
}

// --- Fairness report ---
async function adminReport(main) {
  const t = A().today;
  const from = state.repFrom || addDays(t, -29);
  const to = state.repTo || addDays(t, 30);
  const s = await api(`/admin/stats?from=${from}&to=${to}`);
  const max = Math.max(1, ...s.rows.flatMap((r) => Object.values(r.perUnit)));
  const heat = (n) => `<span class="heat" style="background:rgba(46,117,182,${(0.08 + 0.5 * n / max).toFixed(2)})">${n}</span>`;
  const spreadOf = (role) => {
    const v = s.rows.filter((r) => r.active && !r.backup && (r.role === role)).map((r) => r.total);
    return v.length ? Math.max(...v) - Math.min(...v) : 0;
  };
  const sh = spreadOf('helper');
  const si = spreadOf('installer');
  const ok = (n) => (n <= 1 ? '<span class="badge ok">Balanced</span>' : '<span class="badge warn">Check leave / new people</span>');
  // Time taken
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const work = (c) => durBetween(c.startedAt, c.completedAt);
  const total = (c) => durBetween(c.createdAt, c.completedAt);
  const timeRow = (label, list) => {
    const w = list.map(work).filter((x) => x != null && x >= 0);
    const tt = list.map(total).filter((x) => x != null && x >= 0);
    return `<tr><td><b>${esc(label)}</b></td><td class="num">${list.length}</td><td class="num">${esc(fmtDur(avg(w)) || '—')}</td><td class="num">${esc(fmtDur(avg(tt)) || '—')}</td></tr>`;
  };
  const byUnit = s.units.map((u) => [u.name, s.completed.filter((c) => c.unitId === u.id)]).filter(([, l]) => l.length);
  const timeCard = `<div class="card section"><h2>Time taken</h2>
    <div class="muted small">Work time = Start → Completed. Total time = request added → Completed (includes waiting for the booked day).${s.pending ? ` <span class="badge warn">${s.pending} earlier job(s) not marked completed</span>` : ''}</div>
    ${s.completed.length ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th></th><th class="num">Completed</th><th class="num">Avg work time</th><th class="num">Avg total time</th></tr></thead><tbody>
      ${timeRow('All jobs', s.completed)}${timeRow('🚚 Deliveries', s.completed.filter((c) => c.type !== 'service'))}${timeRow('🔧 Services', s.completed.filter((c) => c.type === 'service'))}
      ${byUnit.map(([n, l]) => timeRow(n, l)).join('')}</tbody></table></div>
    <details style="margin-top:8px"><summary class="small"><b>Each completed job</b></summary><div class="table-wrap" style="margin-top:6px"><table><thead><tr><th>Date</th><th>Unit</th><th>Customer</th><th>Requested</th><th>Started</th><th>Completed</th><th class="num">Work</th><th class="num">Total</th></tr></thead><tbody>
      ${s.completed.map((c) => `<tr><td>${esc(fmtDate(c.date))}${c.type === 'service' ? ' 🔧' : ''}</td><td>${esc(c.unitName)}</td><td>${esc(c.customer)}</td><td class="small">${esc(fmtTime(c.createdAt))}</td><td class="small">${esc(fmtTime(c.startedAt) || '—')}</td><td class="small">${esc(fmtTime(c.completedAt))}</td><td class="num">${esc(fmtDur(work(c)) || '—')}</td><td class="num">${esc(fmtDur(total(c)) || '—')}</td></tr>`).join('')}
    </tbody></table></div></details>` : '<p class="muted">No completed jobs in these dates yet.</p>'}</div>`;
  main.innerHTML = `<div class="row section"><h1>Report</h1><div class="spacer"></div>
      <input type="date" id="rf" value="${esc(from)}" style="width:auto"> to <input type="date" id="rt" value="${esc(to)}" style="width:auto"><button id="rgo">Show</button></div>
    ${timeCard}
    <div class="card section"><h2>Fairness</h2>${s.deliveries} jobs.
      <div class="small">Helpers – difference between most and least: <b>${sh}</b> ${ok(sh)}</div>
      <div class="small">Installation persons – difference: <b>${si}</b> ${ok(si)}</div>
      ${s.unfilled ? `<div class="small" style="margin-top:6px"><span class="badge bad">${s.unfilled} open places</span> – not enough people on some days.</div>` : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Person</th><th class="num">Total</th><th class="num">As helper</th><th class="num">As installer</th><th class="num">Emergency</th><th class="num">Leave days</th>${s.units.map((u) => `<th class="num">${esc(u.name)}</th>`).join('')}</tr></thead>
    <tbody>${s.rows.map((r) => `<tr><td><b>${esc(r.name)}</b> ${roleBadge(r.role)}${r.backup ? ' <span class="badge bad">backup</span>' : ''}${r.active ? '' : ' <span class="badge">inactive</span>'}<div class="small muted">${esc(r.unitName)}</div></td>
      <td class="num"><b>${r.total}</b></td><td class="num">${r.helper}</td><td class="num">${r.installer}</td><td class="num">${r.emergency}</td><td class="num">${r.leaveDays}</td>${s.units.map((u) => `<td class="num">${heat(r.perUnit[u.id] || 0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="muted small">Counts include planned future jobs up to the end date. The unit columns show how often each person went on that unit's jobs — an even spread means people are shuffled well across units.</p>`;
  document.getElementById('rgo').onclick = () => { state.repFrom = document.getElementById('rf').value; state.repTo = document.getElementById('rt').value; renderAdmin(); };
}

// --- Clients & machines (Google Sheet) ---
const APPS_SCRIPT = `const KEY = 'CHANGE-THIS-TO-A-SECRET';

function doGet(e) {
  const out = (obj) => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  if (!e || !e.parameter || e.parameter.key !== KEY) return out({ error: 'wrong key' });
  const tabs = String(e.parameter.tabs || 'Party,Machines').split(',').slice(0, 5);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = {};
  tabs.forEach((name) => {
    const sh = ss.getSheetByName(name.trim());
    data[name] = sh ? sh.getDataRange().getDisplayValues() : null;
  });
  return out(data);
}`;

async function adminSheet(main) {
  const s = await api('/admin/sheet');
  const connected = s.scriptUrl || s.sheetLink;
  main.innerHTML = `<div class="row section"><div><h1>Clients &amp; machines</h1>
      <div class="muted small">Copied from your Google Sheet, so units can pick the customer and machines when booking.</div></div>
      <div class="spacer"></div>${connected ? '<button class="primary" id="sync">↻ Sync now</button>' : ''}</div>
    <div class="card section">
      <div class="row"><span class="badge ok">${s.clients} clients</span><span class="badge w4">${s.machines} machine models</span>
      ${s.lastSync ? `<span class="small muted">Last sync ${esc(fmtTime(s.lastSync))} · syncs again every 3 hours</span>` : '<span class="small muted">Not synced yet</span>'}</div>
      ${s.lastError ? `<div class="error">${esc(s.lastError)}</div>` : ''}
      <div class="lookup" style="max-width:480px;margin-top:10px"><label>Test search</label><input id="tq" placeholder="type a party name, phone or city" autocomplete="off"><div id="tres" class="small" style="margin-top:6px"></div></div>
      ${s.machineList.length ? `<details style="margin-top:10px"><summary class="small"><b>Machine list (${s.machineList.length})</b></summary><div class="small" style="margin-top:6px;columns:2">${s.machineList.map((m) => `<div>${esc(m)}</div>`).join('')}</div></details>` : ''}
    </div>
    <form class="card section" id="sheet-form"><h2>Connect your Google Sheet</h2>
      <p class="small"><b>Recommended (sheet stays private):</b></p>
      <ol class="small">
        <li>Open your sheet → <b>Extensions → Apps Script</b>.</li>
        <li>Delete what is there and paste the code below. Change <code>CHANGE-THIS-TO-A-SECRET</code> to your own secret word (e.g. <code>ww-9x7k2</code>).</li>
        <li>Click <b>Deploy → New deployment</b> → type <b>Web app</b> → Execute as <b>Me</b>, Who has access <b>Anyone</b> → <b>Deploy</b> → allow access.</li>
        <li>Copy the <b>Web app URL</b> and paste it below with the same secret word, then Save.</li>
      </ol>
      <details><summary class="small"><b>Show Apps Script code</b></summary><textarea readonly id="code" style="min-height:260px;font-family:monospace;font-size:12px">${esc(APPS_SCRIPT)}</textarea><button type="button" id="copy">📋 Copy code</button></details>
      <div class="form-grid">
        <div><label>Apps Script web app URL</label><input name="scriptUrl" value="${esc(s.scriptUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div><label>Secret word ${s.key ? '(saved – leave blank to keep)' : ''}</label><input name="key" autocomplete="off" placeholder="${s.key ? '••••••' : 'same as in the script'}"></div>
        <div><label>Client tab name</label><input name="partyTab" value="${esc(s.partyTab)}"></div>
        <div><label>Machine tab name</label><input name="machineTab" value="${esc(s.machineTab)}"></div>
      </div>
      <p class="small muted" style="margin-top:12px"><b>Other way:</b> share the sheet as "Anyone with the link can view" and paste the sheet link here (leave the Apps Script URL empty). Anyone with the link could then see the whole sheet.</p>
      <label>Google Sheet link</label><input name="sheetLink" value="${esc(s.sheetLink)}" placeholder="https://docs.google.com/spreadsheets/d/…">
      <p class="small muted">Client tab: uses columns PARTY, PARTY ADD, PARTY ADD2, CITY, CELL NO, CELLNO2. Machine tab: uses columns MACHINE and/or MODEL. Other columns are ignored.</p>
      <div class="actions" style="justify-content:flex-start"><button class="primary">Save &amp; sync</button></div>
    </form>`;
  const form = document.getElementById('sheet-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try {
      const r = await api('/admin/sheet', { method: 'PUT', body: Object.fromEntries(new FormData(form)) });
      state.machineList = null;
      toast(`Synced: ${r.clients} clients, ${r.machines} machines`);
      adminSheet(main);
    } catch (ex) { toast(ex.message, true); btn.disabled = false; }
  };
  const sync = document.getElementById('sync');
  if (sync) sync.onclick = async () => {
    sync.disabled = true;
    try { const r = await api('/admin/sheet/sync', { method: 'POST' }); state.machineList = null; toast(`Synced: ${r.clients} clients, ${r.machines} machines`); adminSheet(main); } catch (ex) { toast(ex.message, true); sync.disabled = false; }
  };
  document.getElementById('copy').onclick = () => {
    const c = document.getElementById('code');
    c.select();
    (navigator.clipboard ? navigator.clipboard.writeText(c.value) : Promise.reject()).then(() => toast('Code copied'), () => { document.execCommand('copy'); toast('Code copied'); });
  };
  let t = null;
  document.getElementById('tq').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const r = await api('/lookup/clients?q=' + encodeURIComponent(e.target.value));
      document.getElementById('tres').innerHTML = r.clients.map((c) => `<div><b>${esc(c.name)}</b> · ${esc(c.phone)} · ${esc([c.address, c.city].filter(Boolean).join(', '))}</div>`).join('') || '<span class="muted">No match</span>';
    }, 200);
  };
}

// --- Settings ---
function adminSettings(main) {
  const s = A().settings;
  main.innerHTML = `<h1>Settings</h1>
    <p class="muted small">Running version <b>${esc(state.pub.version || '')}</b></p>
    <form class="card section" id="set-form">
      <div class="form-grid">
        <div><label>Company / app name</label><input name="orgName" value="${esc(s.orgName)}"></div>
        <div><label>Default helpers per delivery</label><input name="defaultHelpers" type="number" min="0" max="${state.pub.maxHelpers}" value="${esc(s.defaultHelpers)}"></div>
        <div><label>Time zone</label><input name="timezone" value="${esc(s.timezone)}"></div>
      </div>
      <div style="margin-top:12px"><button class="primary">Save settings</button></div>
    </form>
    <form class="card section" id="pw-form"><h2>Admin login</h2>
      <div class="form-grid">
        <div><label>Username</label><input name="username" value="${esc(state.me.name)}" autocapitalize="none"></div>
        <div><label>Current password</label><input name="current" type="password" required autocomplete="current-password"></div>
        <div><label>New password</label><input name="next" type="password" required minlength="6" autocomplete="new-password"></div>
      </div><div style="margin-top:12px"><button class="primary">Change password</button></div></form>
    <div class="card"><h2>Backup</h2><p class="muted">Download all data (units, people, deliveries, history). Keep a copy safe; you can restore it any time.</p>
      <div class="row"><a class="btn" href="/api/admin/backup">⬇️ Download backup</a>
      <label class="btn" style="margin:0;font-weight:500">⬆️ Restore from file<input type="file" id="restore" accept=".json,application/json" hidden></label></div></div>`;
  const sf = document.getElementById('set-form');
  sf.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(sf);
    try {
      await api('/admin/settings', { method: 'PUT', body: Object.fromEntries(fd) });
      state.pub.orgName = fd.get('orgName') || state.pub.orgName;
      toast('Settings saved');
      $app.innerHTML = '';
      renderAdmin();
    } catch (ex) { toast(ex.message, true); }
  };
  const pf = document.getElementById('pw-form');
  pf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/admin/password', { method: 'POST', body: Object.fromEntries(new FormData(pf)) });
      state.me = await api('/me');
      toast('Password changed');
      pf.reset();
    } catch (ex) { toast(ex.message, true); }
  };
  document.getElementById('restore').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Replace ALL current data with this backup?')) return;
    try {
      await api('/admin/restore', { method: 'POST', body: JSON.parse(await file.text()) });
      toast('Backup restored');
      renderAdmin();
    } catch (ex) { toast(ex.message, true); }
  };
}

boot();
