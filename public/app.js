'use strict';

// ---------- small helpers ----------
const $app = document.getElementById('app');
const state = { pub: { orgName: 'Delivery Team', sessions: ['FULL', 'AM', 'PM'], maxHelpers: 8 }, me: null, tab: 'today', admin: null, from: null, to: null };
const SESSION_NAMES = { FULL: 'Full day', AM: 'Morning', PM: 'Afternoon', EVE: 'Evening' };
const ROLE_NAMES = { helper: 'Helper', installer: 'Installation person', both: 'Helper + Installation', leader: 'Team leader (assembly)' };

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
  if (role === 'leader') return '<span class="badge warn">👷 Team leader</span>';
  return role === 'installer' ? '<span class="badge w3">Installation</span>' : role === 'both' ? '<span class="badge w4">Helper + Install</span>' : '<span class="badge w2">Helper</span>';
}
function needText(d) {
  if (d.type === 'loading') return `${d.helpersNeeded} person${d.helpersNeeded > 1 ? 's' : ''} for loading / unloading`;
  const parts = [];
  if (d.installation) parts.push(d.type === 'service' ? 'service person' : 'installation person');
  if (d.helpersNeeded) parts.push(`${d.helpersNeeded} helper${d.helpersNeeded > 1 ? 's' : ''}`);
  return parts.join(' + ');
}
function placeName(t, d) {
  if (t.extra) return 'Emergency';
  if (t.role === 'loader') return `Person ${t.slot + 1}`;
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
  if (state.me.role === 'dispatch') return renderDispatch();
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
  const labels = { dispatch: 'Dispatch login ID', unit: 'Unit login ID', staff: 'Your login ID (helpers, installation persons, team leaders – as given by admin)', admin: 'Admin username' };
  $app.innerHTML = `<div class="login">
    <div class="brand"><div class="logo">🚚</div><h1>${esc(state.pub.orgName)}</h1><div class="muted">Delivery helpers &amp; installation team</div></div>
    <div class="card">
      <div class="role-switch">
        <button type="button" data-role="unit" class="${role === 'unit' ? 'on' : ''}"><span>🏢</span>Unit</button>
        <button type="button" data-role="staff" class="${role === 'staff' ? 'on' : ''}"><span>🧰</span>Helper / Team leader</button>
        <button type="button" data-role="dispatch" class="${role === 'dispatch' ? 'on' : ''}"><span>🚚</span>Dispatch</button>
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
const jobName = (d) => (d.type === 'service' ? 'Service' : d.type === 'loading' ? 'Loading / Unloading' : 'Delivery');

function statusBadge(d, today) {
  if (d.status === 'cancelled') return '<span class="badge">Cancelled</span>';
  if (d.status === 'done') return '<span class="badge ok">✓ Completed</span>';
  if (d.status === 'started') return '<span class="badge w4">🚚 Started</span>';
  if (d.date < today) return '<span class="badge warn">Not marked completed</span>';
  return d.open ? `<span class="badge bad">${d.open} open</span>` : '<span class="badge ok">Team ready</span>';
}

function timeline(d) {
  const parts = [];
  if (d.createdAt) parts.push(`Requested ${esc(fmtTime(d.createdAt))}${d.entryBy ? ` by <b>${esc(d.entryBy)}</b>` : d.createdBy ? ' by ' + esc(d.createdBy) : ''}`);
  if (d.startedAt) parts.push(`Started ${esc(fmtTime(d.startedAt))}`);
  if (d.completedAt) {
    const work = fmtDur(durBetween(d.startedAt, d.completedAt));
    const total = fmtDur(durBetween(d.createdAt, d.completedAt));
    parts.push(`<b>Completed ${esc(fmtTime(d.completedAt))}</b>${work || total ? ` (${[work && 'work ' + work, total && 'total ' + total].filter(Boolean).join(' · ')})` : ''}`);
    if (d.timesEditedBy) parts.push(`<span class="badge manual">✎ times entered by ${esc(d.timesEditedBy)}</span>`);
  }
  return parts.length ? `<div class="small muted" style="margin-top:6px">🕒 ${parts.join(' · ')}</div>` : '';
}

// who: 'admin' | 'unit' | 'staff'
function deliveryCard(d, who, today) {
  const past = d.date < today;
  const boss = who === 'admin' || who === 'unit';
  const open = isOpenJob(d);
  const canTeam = boss && open && !past;
  const lockTeam = d.type === 'loading' && who !== 'admin'; // loading: units only get "Absent"; Change / Emergency are admin only
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
      lockTeam ? '' : who === 'admin' && !t.extra ? `<button class="link small" data-change="${esc(d.id)}|${t.role}|${t.slot}">Change</button>` : '',
      p && !(lockTeam && t.extra) ? `<button class="link small" data-replace="${esc(d.id)}|${esc(p.id)}|${esc(p.name)}">${t.extra ? 'Remove' : 'Absent'}</button>` : '',
    ].join('');
    return `<div class="drv"><div class="place">${esc(placeName(t, d))}</div>
      <div class="who-line">${p ? `<b>${esc(p.name)}</b> ${roleBadge(p.role)} ${tags}` : open ? `<span class="empty">Nobody free – ${t.role === 'installer' ? (d.type === 'service' ? 'service person' : 'installation person') : 'helper'} needed</span>` : '<span class="muted small">—</span>'}</div>
      ${p || actions ? `<div class="sub-line small">${p && p.unitName ? `<span class="muted">${esc(p.unitName)}</span>` : ''}${p && p.phone ? telLink(p.phone) : ''}${actions}</div>` : ''}</div>`;
  }).join('');
  const absents = d.absents && d.absents.length
    ? `<div class="small absent-log">🚫 ${d.absents.map((x) => `<b>${esc(x.name)}</b> absent – marked by ${esc(x.by)} ${esc(fmtTime(x.at))}${x.reason ? ` (${esc(x.reason)})` : ''}`).join('<br>🚫 ')}</div>`
    : '';
  const lost = open && d.lost.length ? `<div class="badge bad" style="margin-top:8px;white-space:normal">⚠ ${d.lost.map((l) => `${esc(l.person)} was taken by ${esc(l.unit)} for an emergency`).join('; ')}</div>` : '';
  const typeTag = d.type === 'service' ? '<span class="badge w3">🔧 Service</span> ' : d.type === 'loading' ? '<span class="badge warn">📦 Loading / Unloading</span> ' : '';
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
    if (!lockTeam) btns.push(`<button class="small" data-extra="${esc(d.id)}">🆘 Emergency person</button>`);
    btns.push(`<button class="small" data-edit-del="${esc(d.id)}">Edit</button>`);
  }
  if (boss && d.status === 'done' && d.type !== 'loading') btns.push(`<button class="small" data-service="${esc(d.id)}">🔧 Book service</button>`);
  if (who === 'admin' && d.status === 'done') btns.push(`<button class="small" data-times="${esc(d.id)}">🕒 Edit times</button>`);
  if (who === 'unit' && d.status === 'done' && !d.startedAt) btns.push(`<button class="small primary" data-times="${esc(d.id)}">🕒 Add times</button>`);
  if (boss && d.type !== 'loading' && d.status !== 'cancelled' && (d.status === 'done' || !(d.date > today))) btns.push(`<button class="small" data-photo="${esc(d.id)}">📷 Add photo</button>`);
  if (who !== 'staff' && d.status !== 'cancelled') btns.push(`<button class="small" data-wa="${esc(d.id)}">📤 WhatsApp</button>`);
  if (canTeam && d.status === 'planned') btns.push(`<div class="spacer"></div><button class="small danger" data-cancel-del="${esc(d.id)}">Cancel</button>`);
  if (boss && (d.status === 'done' || d.status === 'started')) btns.push(`<div class="spacer"></div><button class="link small" data-reopen="${esc(d.id)}">${d.status === 'done' ? 'Reopen' : 'Undo start'}</button>`);
  const buttons = btns.length ? `<div class="row no-print" style="margin-top:10px">${btns.join('')}</div>` : '';
  const al = d.allowance;
  const expense = al
    ? `<div class="small expense">💰 <b>Expense:</b> ${al.minutes == null
        ? `<span class="badge warn">Start time not recorded</span>${who === 'admin' ? ' – use "Edit times"' : ' – admin can fix the times'}`
        : al.perPerson
          ? `₹${al.perPerson} per person × ${al.people.length} = <b>₹${al.total}</b> <span class="muted">(${esc(fmtDur(al.minutes * 60000))} work)</span><div class="muted">${al.names.map(esc).join(', ')}</div>`
          : `nil <span class="muted">(${esc(fmtDur(al.minutes * 60000))} work – under ${esc(firstHours(d.type))} h)</span>`}</div>`
    : '';
  const photos = d.photos && d.photos.length
    ? `<div class="small" style="margin-top:8px"><b>📒 Service book (${d.photos.length})</b><div class="thumbs">${d.photos.map((p) => `<span class="thumb"><a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(fmtTime(p.at))}"><img src="${esc(p.url)}" alt="service book photo" loading="lazy"></a>${who === 'admin' ? `<button type="button" data-delphoto="${esc(d.id)}|${esc(p.file)}" title="Delete photo">✕</button>` : ''}</span>`).join('')}</div></div>`
    : '';
  return `<div class="card unit-card${d.status === 'cancelled' ? ' muted' : ''}${d.status === 'done' ? ' done' : ''}">${head}${info ? `<div style="margin-top:6px">${info}</div>` : ''}${timeline(d)}${expense}${photos}${team}${absents}${lost}${buttons}</div>`;
}

function waText(d) {
  const lines = [`*${state.pub.orgName} – ${jobName(d)} ${fmtDate(d.date)} (${SESSION_NAMES[d.session]})*`, `Unit: ${d.unitName}`];
  if (d.entryBy) lines.push(`Entry by: ${d.entryBy}`);
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
  root.querySelectorAll('[data-times]').forEach((b) => (b.onclick = () => {
    const d = find(b.dataset.times);
    openModal(`<h2>${d.startedAt ? 'Edit' : 'Add'} start / completed time</h2><div class="muted">${esc(d.unitName)} · ${esc(fmtDate(d.date))}${d.customer ? ' · ' + esc(d.customer) : ''}</div>
      <p class="small">Team forgot to press Start / Completed? Enter when the team left and when the job finished.</p>
      ${timesFields(d, d.startedAt, d.completedAt)}
      <p class="muted small">The expense is worked out again from the work time.${base === '/unit' ? ' After saving, only the admin can change these times.' : ''}</p>
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
    async (fd) => {
      const v = timesValues();
      if (!v.start || !v.end) throw new Error('Enter the date, start time and end time');
      await api(`${base}/deliveries/${d.id}/times`, { method: 'POST', body: { startedAt: toIso(v.start), completedAt: toIso(v.end) } });
      toast('Times saved – expense updated');
      reload();
    });
    bindTimes();
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
    if (t && t.extra) {
      if (confirm(`Remove ${name} (emergency person) from this job?`)) post(`${base}/deliveries/${id}/extra/cancel`, 'Done – team updated', { slot: t.slot });
      return;
    }
    const reason = prompt(`Mark ${name} ABSENT for this job?\nA new name is picked automatically. This is recorded and the admin can see it.\n\nReason (optional):`, '');
    if (reason === null) return; // cancelled
    post(`${base}/deliveries/${id}/replace`, `${name} marked absent – new name picked`, { personId, reason });
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

const A0 = () => state.allowance || (state.admin && state.admin.settings.allowance) || { slabs: [{ fromHours: 3, amount: 40 }, { fromHours: 5, amount: 55 }, { fromHours: 6, amount: 65 }] };
const slabsOf = (type) => (type === 'loading' ? [] : type === 'service' ? A0().slabs : A0().deliverySlabs || A0().slabs) || [];
const firstHours = (type) => String((slabsOf(type)[0] || {}).fromHours || 1);
const amountFor = (minutes, type) => { let a = 0; for (const x of slabsOf(type)) if (minutes >= x.fromHours * 60) a = x.amount; return a; };
// 'YYYY-MM-DDTHH:MM' in the phone's own time, for <input type="datetime-local">
const localInput = (iso) => { if (!iso) return ''; const x = new Date(iso); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const toIso = (v) => (v ? new Date(v).toISOString() : '');

// Start / completed time inputs with a live work-time + expense preview.
// Date + start time + end time (same day; an end time earlier than the start means it ended next day).
function timesFields(d, startIso, endIso) {
  const people = d.team.filter((t) => t.person).length;
  const ref = localInput(endIso || startIso || new Date().toISOString());
  const st = localInput(startIso);
  const en = localInput(endIso);
  return `<div class="form-grid times-grid">
      <div><label>Date</label><input type="date" id="t-date" value="${esc(ref.slice(0, 10))}" max="${esc(localInput(new Date().toISOString()).slice(0, 10))}"></div>
      <div><label>Start time ${startIso ? '' : '<span class="badge warn">Start not pressed</span>'}</label><input type="time" id="t-start" value="${esc(st ? st.slice(11) : '')}"></div>
      <div><label>End time</label><input type="time" id="t-end" value="${esc(en ? en.slice(11) : '')}"></div>
    </div>
    <div class="small expense" id="t-prev" data-type="${esc(d.type || 'delivery')}" data-people="${people}" data-start="${esc(st)}" data-end="${esc(en)}"></div>`;
}
// The typed times as local 'YYYY-MM-DDTHH:MM' strings (end moved to next day if before start).
function timesValues() {
  const date = document.getElementById('t-date').value;
  const a = document.getElementById('t-start').value;
  const b = document.getElementById('t-end').value;
  const start = date && a ? `${date}T${a}` : '';
  let end = date && b ? `${date}T${b}` : '';
  let nextDay = false;
  if (start && end && end <= start) { end = localInput(new Date(new Date(end).getTime() + 86400000).toISOString()); nextDay = true; }
  return { start, end, nextDay };
}
function bindTimes() {
  const box = document.getElementById('t-prev');
  const draw = () => {
    const v = timesValues();
    if (!v.start) { box.innerHTML = box.dataset.type === 'loading' ? '🕒 Enter the <b>start time</b> – compulsory for loading / unloading.' : '💰 Enter the <b>start time</b> (when the team left) to work out the expense.'; return; }
    if (!v.end) { box.innerHTML = '💰 Enter the <b>end time</b>.'; return; }
    const m = Math.round((new Date(v.end) - new Date(v.start)) / 60000);
    if (m > 24 * 60) { box.innerHTML = '<span class="empty">Work time cannot be more than 24 hours</span>'; return; }
    const amt = amountFor(m, box.dataset.type);
    const n = Number(box.dataset.people) || 0;
    if (box.dataset.type === 'loading') { box.innerHTML = `Work time <b>${esc(fmtDur(m * 60000))}</b>${v.nextDay ? ' <span class="badge warn">ends next day</span>' : ''} · no expense (internal work)`; return; }
    box.innerHTML = `Work time <b>${esc(fmtDur(m * 60000))}</b>${v.nextDay ? ' <span class="badge warn">ends next day</span>' : ''} → 💰 ${amt ? `₹${amt} per person × ${n} = <b>₹${amt * n}</b>` : 'no expense (under ' + esc(firstHours(box.dataset.type)) + ' h)'}`;
  };
  ['t-date', 't-start', 't-end'].forEach((id) => (document.getElementById(id).oninput = draw));
  draw();
}
// Times to send: only the ones that differ from what was already saved / pressed (to the minute).
function timesToSend() {
  const v = timesValues();
  const box = document.getElementById('t-prev');
  if (document.getElementById('t-start').value && !v.end) throw new Error('Enter the end time');
  return {
    startedAt: v.start && v.start !== box.dataset.start ? toIso(v.start) : '',
    completedAt: v.end && v.end !== box.dataset.end ? toIso(v.end) : '',
  };
}

async function loadMakers() {
  if (state.makers && Date.now() - state.makersAt < 5 * 60 * 1000) return state.makers;
  try { state.makers = (await api('/lookup/makers')).makers; state.makersAt = Date.now(); } catch { state.makers = state.makers || []; }
  return state.makers;
}

// ----- model no. search (all logins) -----
// Every model box (inputs using a model <datalist>) gets this search instead of the browser's own
// list: "FT24BK" finds "FT~24BK (DUAL SUCTION POINT)" because ~, spaces, brackets and case are ignored.
const mKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const mBase = (v) => mKey(String(v || '').split('(')[0]);
const isModelList = (id) => id === 'machine-list' || /^(asm-models|r-models|os-models)/.test(id || '');
const modelPop = { el: null, input: null, items: [], active: -1 };
function modelOptions(input) {
  const dl = document.getElementById(input.dataset.models);
  return dl ? [...dl.options].map((o) => o.value).filter(Boolean) : [];
}
function modelExact(input) {
  const opts = modelOptions(input);
  const v = input.value;
  if (!mKey(v)) return null;
  const exact = opts.find((o) => mKey(o) === mKey(v));
  if (exact) return exact;
  const hits = opts.filter((o) => mBase(o) === mBase(v));
  return hits.length === 1 ? hits[0] : null;
}
function hideModelPop() { if (modelPop.el) modelPop.el.hidden = true; modelPop.active = -1; }
function pickModel(value) {
  const input = modelPop.input;
  hideModelPop();
  if (!input) return;
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
function showModelPop(input) {
  const k = mKey(input.value);
  const opts = modelOptions(input);
  const list = (k ? opts.filter((o) => mKey(o).includes(k)) : opts)
    .sort((a, b) => (k ? Number(!mKey(a).startsWith(k)) - Number(!mKey(b).startsWith(k)) : 0))
    .slice(0, 40);
  if (!modelPop.el) {
    modelPop.el = document.createElement('div');
    modelPop.el.className = 'lookup-list model-pop';
    modelPop.el.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-pick]'); if (b) { e.preventDefault(); pickModel(modelPop.items[Number(b.dataset.pick)]); } });
  }
  // inside a pop-up (<dialog>) the list must live in the dialog, or it shows behind it
  const host = input.closest('dialog') || document.body;
  if (modelPop.el.parentNode !== host) host.appendChild(modelPop.el);
  modelPop.input = input;
  modelPop.items = list;
  modelPop.active = -1;
  if (!list.length || (list.length === 1 && list[0] === input.value)) return hideModelPop();
  const r = input.getBoundingClientRect();
  Object.assign(modelPop.el.style, { position: 'fixed', left: r.left + 'px', top: r.bottom + 2 + 'px', width: Math.max(r.width, 260) + 'px', maxHeight: Math.max(120, Math.min(280, window.innerHeight - r.bottom - 10)) + 'px', overflowY: 'auto', zIndex: 2000 });
  modelPop.el.innerHTML = list.map((o, i) => `<div class="lookup-item" data-pick="${i}">${esc(o)}</div>`).join('');
  modelPop.el.hidden = false;
}
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (el.tagName !== 'INPUT') return;
  if (el.getAttribute('list') && isModelList(el.getAttribute('list'))) {
    el.dataset.models = el.getAttribute('list');
    el.removeAttribute('list');
    el.setAttribute('autocomplete', 'off');
  }
  if (el.dataset.models) showModelPop(el);
});
document.addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.models) showModelPop(e.target); });
document.addEventListener('focusout', (e) => {
  const el = e.target;
  if (!el.dataset || !el.dataset.models) return;
  const hit = modelExact(el);
  if (hit && hit !== el.value) { el.value = hit; el.dispatchEvent(new Event('change', { bubbles: true })); }
  setTimeout(() => { if (modelPop.input === el && document.activeElement !== el) hideModelPop(); }, 150);
});
document.addEventListener('keydown', (e) => {
  if (!modelPop.el || modelPop.el.hidden || e.target !== modelPop.input) return;
  const n = modelPop.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    modelPop.active = (modelPop.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    modelPop.el.querySelectorAll('[data-pick]').forEach((d, i) => d.classList.toggle('active', i === modelPop.active));
  } else if (e.key === 'Enter' && modelPop.active >= 0) {
    e.preventDefault();
    pickModel(modelPop.items[modelPop.active]);
  } else if (e.key === 'Escape') hideModelPop();
});
window.addEventListener('scroll', () => { if (modelPop.input && modelPop.el && !modelPop.el.hidden) showModelPop(modelPop.input); }, true);

async function loadMachineList() {
  if (state.machineList && Date.now() - state.machineListAt < 5 * 60 * 1000) return state.machineList;
  try {
    const r = await api('/lookup/machines');
    state.machineList = r.details || r.machines.map((label) => ({ label, desc: '' }));
    state.machineListAt = Date.now();
  } catch { state.machineList = state.machineList || []; }
  return state.machineList;
}

function helperOptions(n) {
  return Array.from({ length: state.pub.maxHelpers + 1 }, (_, i) => `<option value="${i}" ${Number(n) === i ? 'selected' : ''}>${i === 0 ? 'No helper' : i + (i === 1 ? ' helper' : ' helpers')}</option>`).join('');
}

function completeForm(base, d, reload) {
  const after = [['', 'No service needed'], ['7', 'After 1 week'], ['15', 'After 15 days'], ['30', 'After 1 month'], ['60', 'After 2 months'], ['90', 'After 3 months'], ['180', 'After 6 months'], ['365', 'After 1 year'], ['date', 'Choose a date…']];
  const isLoad = d.type === 'loading';
  openModal(`<h2>${jobName(d)} completed</h2>
    <div class="muted">${esc(d.unitName)} · ${esc(fmtDate(d.date))}${d.customer ? ' · ' + esc(d.customer) : ''}</div>
    <p class="small">${isLoad ? '<b>Start time and end time are compulsory.</b> The next loading / unloading can be booked only after this one has its end time. No expense is paid for this internal work.' : 'The team becomes free for other jobs today. Check the times – change them if Start / Completed was not pressed on time.'}</p>
    ${timesFields(d, d.startedAt, new Date().toISOString())}
    <div ${isLoad ? 'hidden' : ''}>
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
    </div>
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">✓ Mark completed</button></div>`,
  async (fd) => {
    const body = { ...Object.fromEntries(fd), photos: getPhotos() };
    if (isLoad) {
      const v = timesValues();
      if (!v.start) throw new Error('Enter the start time – it is compulsory for loading / unloading');
      if (!v.end) throw new Error('Enter the end time – it is compulsory for loading / unloading');
      body.serviceAfter = '';
    }
    Object.assign(body, timesToSend());
    await api(`${base}/deliveries/${d.id}/complete`, { method: 'POST', body });
    toast(fd.get('serviceAfter') ? 'Completed – service booked' : 'Completed – team is free');
    reload();
  });
  const getPhotos = photoPicker(document.getElementById('c-photos'));
  bindTimes();
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
      <div><label>Type</label><select name="type" id="f-type"><option value="delivery">🚚 Delivery</option><option value="service" ${v.type === 'service' ? 'selected' : ''}>🔧 Service</option><option value="loading" ${v.type === 'loading' ? 'selected' : ''}>📦 Loading / Unloading</option></select></div>
      <div><label id="f-date-l">Date *</label><input type="date" name="date" required value="${esc(v.date)}" min="${esc(state.today)}"></div>
      <div><label>Time</label><select name="session" id="f-session">${state.pub.sessions.map((s) => `<option value="${s}" ${v.session === s ? 'selected' : ''}>${SESSION_NAMES[s]}</option>`).join('')}</select></div>
      <div><label id="f-help-l">Helpers needed *</label><select name="helpersNeeded" id="f-help">${helperOptions(v.helpersNeeded)}</select></div>
      <div id="f-inst-wrap"><label id="f-inst-l">Installation person needed?</label><select name="installation"><option value="no">No</option><option value="yes" ${v.installation ? 'selected' : ''}>Yes</option></select></div>
    </div>
    <div id="f-entry-wrap"><label>✍️ Entry by * <span class="muted small" style="font-weight:400">– who is raising this request</span></label><select name="entryBy" id="f-entry"><option value="">Loading names…</option></select></div>
    <div id="f-cust-block">
    <div class="lookup" style="margin-top:6px"><label>👤 Party name</label><input name="customer" id="f-cust" autocomplete="off" value="${esc(v.customer)}" placeholder="type party name to search">
      <div id="f-cust-list" class="lookup-list" hidden></div></div>
    <label style="margin-bottom:0">⚙️ Model no. <span class="muted small" style="font-weight:400">– one line per model, with quantity</span></label>
    <div id="f-items"></div>
    <button type="button" class="link" id="f-add-item">+ Add another model</button>
    <datalist id="machine-list"></datalist>
    </div>
    <p class="small" id="f-load-note" hidden>📦 Loading / unloading at <b>this unit</b>: helpers and installation persons of the unit are picked in turn, so the same people don't do it every time. Start and end time are compulsory when completing; no expense is paid.</p>
    <details class="more-details"><summary class="small"><b>More details (optional)</b> <span class="muted">– phone, address, notes · filled in from the party list</span></summary>
      <div class="form-grid">
        <div><label>Phone</label><input name="customerPhone" type="tel" value="${esc(v.customerPhone)}"></div>
        <div><label id="f-notes-l">Notes</label><input name="notes" value="${esc(v.notes)}" placeholder="e.g. 2nd floor, no lift"></div>
      </div>
      <label>Address</label><textarea name="address">${esc(v.address)}</textarea>
    </details>
    <p class="muted small" id="f-fair-note">People are picked fairly from all units. "Morning", "Afternoon" and "Evening" jobs can share people; a "Full day" job keeps them the whole day.</p>
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">${d ? 'Save' : 'Book'}</button></div>`,
  async (fd) => {
    const body = Object.fromEntries(fd);
    body.items = readItems();
    if (body.type === 'loading') { body.items = []; body.customer = ''; body.customerPhone = ''; body.address = ''; body.installation = 'no'; }
    if (!String(body.entryBy || '').trim()) throw new Error('Choose your name in "Entry by"');
    if (d) await api(`${base}/deliveries/${d.id}`, { method: 'PUT', body });
    else await api(`${base}/deliveries`, { method: 'POST', body });
    toast(d ? 'Saved' : 'Booked – team assigned');
    reload();
  });
  // Machines: one line per model with quantity.
  const itemsEl = document.getElementById('f-items');
  const itemRow = (it) => `<div class="row item-row" style="margin-top:6px;flex-wrap:nowrap">
      <input class="it-label" list="machine-list" placeholder="Model no." value="${esc(it.label)}" style="flex:1">
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
  // "Entry by" names from the sheet's Made By column; remembers the last one used on this phone.
  loadMakers().then((names) => {
    const wrap = document.getElementById('f-entry-wrap');
    if (!wrap) return;
    const cur = v.entryBy || ''; // new jobs: everyone picks their own name (unit logins are shared)
    if (!names.length) {
      wrap.querySelector('#f-entry').outerHTML = `<input name="entryBy" id="f-entry" value="${esc(cur)}" placeholder="your name" required>`;
      return;
    }
    const list = cur && !names.some((n) => n.toLowerCase() === cur.toLowerCase()) && d ? [cur, ...names] : names;
    wrap.querySelector('#f-entry').innerHTML = `<option value="">— choose your name —</option>` +
      list.map((n) => `<option ${n.toLowerCase() === cur.toLowerCase() ? 'selected' : ''}>${esc(n)}</option>`).join('');
    wrap.querySelector('#f-entry').required = true;
  });
  loadMachineList().then((list) => {
    document.getElementById('machine-list').innerHTML = list.map((m) => (typeof m === 'string' ? `<option value="${esc(m)}"></option>` : `<option value="${esc(m.label)}"></option>`)).join('');
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
  const helpSel = document.getElementById('f-help');
  const sync = () => {
    const svc = type.value === 'service';
    const load = type.value === 'loading';
    document.getElementById('f-inst-wrap').hidden = load;
    document.getElementById('f-cust-block').hidden = load;
    document.getElementById('f-load-note').hidden = !load;
    modalBody.querySelector('.more-details').hidden = load;
    document.getElementById('f-fair-note').hidden = load;
    // Loading / unloading: Morning, Afternoon or Evening only (no Full day).
    const ses = document.getElementById('f-session');
    const fullOpt = ses.querySelector('option[value=FULL]');
    if (fullOpt) fullOpt.hidden = fullOpt.disabled = load;
    if (load && ses.value === 'FULL') ses.value = 'AM';
    document.getElementById('f-help-l').textContent = load ? 'Persons needed (1–4) *' : 'Helpers needed *';
    const cur = Number(helpSel.value) || 0;
    if (load && helpSel.dataset.mode !== 'load') {
      helpSel.innerHTML = [1, 2, 3, 4].map((n) => `<option value="${n}" ${Math.min(4, Math.max(1, cur)) === n ? 'selected' : ''}>${n} person${n > 1 ? 's' : ''}</option>`).join('');
      helpSel.dataset.mode = 'load';
    } else if (!load && helpSel.dataset.mode === 'load') {
      helpSel.innerHTML = helperOptions(cur);
      helpSel.dataset.mode = '';
    }
    document.getElementById('f-inst-l').textContent = svc ? 'Service person (technician) needed?' : 'Installation person needed?';
    document.getElementById('f-date-l').textContent = svc ? 'Service date *' : load ? 'Date *' : 'Delivery date *';
    document.getElementById('f-notes-l').textContent = svc ? 'What service?' : 'Notes';
    if (svc) modalBody.querySelector('.more-details').open = true; // services usually need a note
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

// One short line per completed job; tap to open the full card.
function doneRow(d, who, today) {
  const al = d.allowance;
  const team = d.team.filter((t) => t.person).map((t) => t.person.name).join(', ');
  const work = fmtDur(durBetween(d.startedAt, d.completedAt));
  const money = !al ? '' : al.minutes == null ? '<span class="badge warn">no start</span>' : al.perPerson ? `<b>₹${al.total}</b>` : '<span class="muted">nil</span>';
  return `<details class="done-row"><summary>
      <span class="ok-tick">✓</span>
      <span class="dr-main"><b>${d.type === 'service' ? '🔧 ' : ''}${d.type === 'loading' ? '📦 Loading / Unloading' : esc(d.customer || '(no customer)')}</b>
        <span class="small muted">${who !== 'unit' ? esc(d.unitName) + ' · ' : ''}${esc(SESSION_NAMES[d.session])} · ${esc(team || 'no team')}</span></span>
      <span class="dr-side small">${work ? esc(work) : ''}${d.photos && d.photos.length ? ' · 📒' + d.photos.length : ''}<br>${money}</span>
    </summary><div class="dr-body">${deliveryCard(d, who, today)}</div></details>`;
}

// Open jobs as cards, completed jobs folded into a compact list.
function jobsBlock(list, who, today) {
  const open = list.filter((d) => d.status !== 'done');
  const done = list.filter((d) => d.status === 'done');
  return `${open.length ? `<div class="grid">${open.map((d) => deliveryCard(d, who, today)).join('')}</div>` : ''}
    ${done.length ? `<div class="done-list${open.length ? '' : ' alone'}"><div class="small muted dl-head">✓ Completed (${done.length})${done.some((d) => d.allowance && d.allowance.minutes == null) ? ' · <span class="badge warn">times missing</span>' : ''}</div>${done.map((d) => doneRow(d, who, today)).join('')}</div>` : ''}`;
}

function groupByDate(list, today, who) {
  const dates = [...new Set(list.map((d) => d.date))];
  return dates.map((date) => `<div class="section"><h2>${date === today ? 'Today · ' : ''}${esc(fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
    ${jobsBlock(list.filter((d) => d.date === date), who, today)}</div>`).join('');
}

// ---------- search all jobs ----------
function searchBarHtml() {
  const q = state.search || { q: '', type: '' };
  const opt = (v, l) => `<option value="${v}" ${q.type === v ? 'selected' : ''}>${l}</option>`;
  return `<div class="search-bar no-print"><span>🔍</span>
      <input id="s-q" type="search" placeholder="Search party, model no., helper, phone, date…" value="${esc(q.q)}" autocomplete="off">
      <select id="s-type">${opt('', 'All')}${opt('delivery', '🚚 Deliveries')}${opt('service', '🔧 Services')}${opt('loading', '📦 Loading')}</select></div>
    <div id="s-results" hidden></div>`;
}
// root: element holding the bar; normal: element with the usual page (hidden while searching)
function bindSearch(root, base, who, normal, reload) {
  const input = root.querySelector('#s-q');
  const type = root.querySelector('#s-type');
  const box = root.querySelector('#s-results');
  let timer = null;
  let seq = 0;
  const run = async () => {
    state.search = { q: input.value, type: type.value };
    const q = input.value.trim();
    if (q.length < 2) { box.hidden = true; normal.hidden = false; return; }
    const my = ++seq;
    try {
      const r = await api(`${base}/search?q=${encodeURIComponent(q)}&type=${type.value}`);
      if (my !== seq) return;
      normal.hidden = true;
      box.hidden = false;
      box.innerHTML = `<div class="row section"><b>${r.results.length}${r.results.length === 60 ? '+' : ''} result${r.results.length === 1 ? '' : 's'}</b> for “${esc(q)}”<div class="spacer"></div><button class="small" id="s-clear">✕ Clear search</button></div>
        ${r.results.length ? groupByDate(r.results, r.today, who) : '<div class="card muted">Nothing found. Try part of the party name or model no.</div>'}`;
      box.querySelector('#s-clear').onclick = () => { input.value = ''; run(); };
      bindDeliveryButtons(box, base, r.results, reload);
    } catch (ex) { toast(ex.message, true); }
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 300); };
  type.onchange = run;
  if (input.value.trim().length >= 2) run();
}

// ---------- unit view ----------
async function renderUnit() {
  if (!document.querySelector('.wrap')) {
    $app.innerHTML = topbar('Unit: ' + state.me.name) + '<div class="wrap"><div class="loading">Loading…</div></div>';
    bindLogout();
  }
  if (state.unitMode === 'assembly') return renderUnitAssembly();
  const data = await api('/unit/home');
  const t = data.today;
  state.today = t;
  state.defaultHelpers = data.defaultHelpers;
  state.allowance = data.allowance;
  const all = data.deliveries;
  const pendingPast = all.filter((d) => d.date < t && isOpenJob(d));
  const upcoming = all.filter((d) => d.date >= t);
  const done = all.filter((d) => d.date < t && d.status === 'done').reverse();
  const todays = upcoming.filter((d) => d.date === t);
  const todayOpen = todays.filter(isOpenJob).length;
  const open = upcoming.filter(isOpenJob).reduce((n, d) => n + d.open, 0);
  const wrap = $app.querySelector('.wrap');
  wrap.innerHTML = `${unitSwitchHtml('jobs')}${searchBarHtml()}<div id="u-normal"><div class="hero"><div class="label">Today · ${esc(fmtDate(t))}</div>
      <div class="big">${todays.length ? `${todays.length} job${todays.length > 1 ? 's' : ''} today${todayOpen < todays.length ? ` · ${todays.length - todayOpen} completed` : ''}` : 'No job today'}</div>
      <div class="line">${upcoming.filter(isOpenJob).length} open${open ? ` · <b>${open} place(s) still open</b> – use 🆘 Emergency person` : ''}</div>
      <div class="row"><a class="call" href="#" id="book">+ Book delivery / service / loading</a></div></div>
    ${pendingPast.length ? `<div class="section"><h2>⚠ Earlier jobs not marked completed</h2><div class="grid">${pendingPast.map((d) => deliveryCard(d, 'unit', t)).join('')}</div></div>` : ''}
    ${upcoming.length ? groupByDate(upcoming, t, 'unit') : '<div class="card muted">Nothing booked. Tap "Book delivery / service", choose how many helpers and if an installation / service person is needed – the team is picked automatically.</div>'}
    ${done.length ? `<div class="section"><h2>Completed – last 30 days (${done.length})</h2>${done.some((d) => d.allowance && d.allowance.minutes == null) ? '<p class="small"><span class="badge warn">Some jobs have no start time</span> – open them and tap "🕒 Add times" so the expense can be worked out.</p>' : ''}<div class="done-list alone">${done.map((d) => doneRow(d, 'unit', t)).join('')}</div></div>` : ''}</div>`;
  document.getElementById('book').onclick = (e) => { e.preventDefault(); deliveryForm('/unit', null, renderUnit); };
  bindDeliveryButtons(document.getElementById('u-normal'), '/unit', all, renderUnit);
  bindSearch(wrap, '/unit', 'unit', document.getElementById('u-normal'), renderUnit);
  bindUnitSwitch();
}

// ---------- staff view ----------
async function renderStaff() {
  $app.innerHTML = topbar(state.me.name) + '<div class="wrap"><div class="loading">Loading…</div></div>';
  bindLogout();
  const data = await api('/staff/home');
  if (data.me.role === 'leader') {
    // Team leaders only do assembly.
    $app.querySelector('.wrap').innerHTML = `<div class="hero"><div class="label">Today · ${esc(fmtDate(data.today))}</div><div class="big">👷 Team leader – assembly</div>
      <div class="line">Tap ▶ Start when you begin a machine and ✓ Assembled when it is done.</div></div>`;
    await staffAssemblyHtml($app.querySelector('.wrap'));
    return;
  }
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
    <div class="row section"><h2 style="margin:0">Next jobs</h2><div class="spacer"></div><span class="badge ok">${data.monthDuties} job${data.monthDuties === 1 ? '' : 's'} this month</span>${data.monthExpense ? ` <span class="badge w4">💰 ₹${data.monthExpense} expense this month</span>` : ''}</div>
    ${later.length ? `<div class="grid">${later.map((d) => deliveryCard(d, 'staff', data.today)).join('')}</div>` : '<div class="card muted">Nothing planned yet.</div>'}`;
  await staffAssemblyHtml($app.querySelector('.wrap'));
}

// ---------- admin ----------
const TABS = [
  ['today', 'Today'],
  ['deliveries', 'Deliveries'],
  ['units', 'Units'],
  ['people', 'Helpers & installers'],
  ['leaves', 'Leave'],
  ['assembly', '🛠️ Assembly'],
  ['report', 'Report'],
  ['sheet', 'Clients & machines'],
  ['settings', 'Settings'],
];

async function loadAdmin() {
  const q = state.from ? `?from=${state.from}&to=${state.to}` : '';
  state.admin = await api('/admin/data' + q);
  state.today = state.admin.today;
  state.defaultHelpers = state.admin.settings.defaultHelpers;
  state.allowance = state.admin.settings.allowance;
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
  const tabA = $app.querySelector('[data-tab=assembly]');
  if (tabA) tabA.innerHTML = `🛠️ Assembly${A().asmRequests ? ` <span class="badge bad">${A().asmRequests}</span>` : ''}`;
  const main = document.getElementById('main');
  const views = { today: adminToday, deliveries: adminDeliveries, units: adminUnits, people: adminPeople, leaves: adminLeaves, report: adminReport, assembly: adminAssembly, sheet: adminSheet, settings: adminSettings };
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
  main.innerHTML = `${A().asmRequests ? `<div class="card section alert-card"><b>📝 ${A().asmRequests} request${A().asmRequests > 1 ? 's' : ''} from team leaders waiting for your approval</b> (new machines / old machines) <button class="small primary" id="go-asm">Open</button></div>` : ''}<div class="row section"><div><h1>Today · ${esc(fmtDate(t, { weekday: 'long', day: 'numeric', month: 'long' }))}</h1>
      <div class="muted">${todays.length} job${todays.length === 1 ? '' : 's'}${doneCount ? ` · ${doneCount} completed` : ''} · ${busy.size} people out now${openToday.some((d) => d.open) ? ` · <b class="empty">${openToday.reduce((n, d) => n + d.open, 0)} place(s) open</b>` : ''}</div></div>
      <div class="spacer"></div><button class="primary" id="add">+ New job</button></div>
    ${pendingPast.length ? `<div class="section"><h2>⚠ Earlier jobs not marked completed</h2><div class="grid">${pendingPast.map((d) => deliveryCard(d, 'admin', t)).join('')}</div></div>` : ''}
    ${todays.length ? jobsBlock(todays, 'admin', t) : '<div class="card muted">No job today.</div>'}
    <div class="card" style="margin-top:12px"><h3>Free now (not on an open job)</h3>
      <div class="small"><b>Helpers:</b> ${free.filter((p) => canDo(p, 'helper')).map(tag).join(' &nbsp; ') || '<span class="muted">none</span>'}</div>
      <div class="small" style="margin-top:4px"><b>Installation / service:</b> ${free.filter((p) => canDo(p, 'installer')).map(tag).join(' &nbsp; ') || '<span class="muted">none</span>'}</div></div>`;
  document.getElementById('add').onclick = () => deliveryForm('/admin', null, renderAdmin, t);
  const goAsm = document.getElementById('go-asm');
  if (goAsm) goAsm.onclick = () => { state.tab = 'assembly'; renderAdmin(); };
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
    <p class="muted small">Only people of the matching kind are listed. If you only want someone else (anyone), close this and use "Absent".</p>
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
  main.innerHTML = `${searchBarHtml()}<div id="a-normal"><div class="row section no-print">
      <button id="prev">◀ Prev</button><button id="this">Next 2 weeks</button><button id="next">Next ▶</button>
      <input type="date" id="from" value="${esc(A().from)}" style="width:auto"> to <input type="date" id="to" value="${esc(A().to)}" style="width:auto">
      <button id="go">Show</button>
      <select id="ft" style="width:auto">${opt('', 'Deliveries + services', f.type)}${opt('delivery', '🚚 Deliveries only', f.type)}${opt('service', '🔧 Services only', f.type)}${opt('loading', '📦 Loading / unloading only', f.type)}</select>
      <select id="fs" style="width:auto">${opt('active', 'All except cancelled', f.status)}${opt('open', 'Open only', f.status)}${opt('done', 'Completed only', f.status)}${opt('cancelled', 'Cancelled', f.status)}${opt('all', 'Everything', f.status)}</select>
      <div class="spacer"></div>
      <button id="print">🖨️ Print</button><button id="rebal">↻ Re-balance</button><button class="primary" id="add">+ New job</button></div>
    <h2 class="print-only">${esc(state.pub.orgName)} – ${esc(fmtDate(A().from))} to ${esc(fmtDate(A().to))}</h2>
    <p class="muted small no-print">${list.length} job(s) · ${list.filter((d) => d.status === 'done').length} completed · ${list.filter((d) => d.type === 'service').length} service(s)</p>
    ${list.length ? groupByDate(list, t, 'admin') : '<div class="card muted">No jobs match.</div>'}</div>`;
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
  bindDeliveryButtons(document.getElementById('a-normal'), '/admin', list, renderAdmin);
  bindSearch(main, '/admin', 'admin', document.getElementById('a-normal'), renderAdmin);
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
      <td class="small">${mine.filter((p) => p.role === 'leader').map((p) => esc(p.name)).join(', ') || '<span class="muted">—</span>'}</td>
      <td><code>${esc(u.username)}</code></td>
      <td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
      <td><button class="link" data-edit="${esc(u.id)}">Edit</button><button class="link" data-addp="${esc(u.id)}">+ Person</button></td></tr>`;
  }).join('');
  main.innerHTML = `<div class="row section"><h1>Units</h1><div class="spacer"></div><button class="primary" id="add">+ Add unit</button></div>
    ${A().units.length ? `<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Contact</th><th>Helpers</th><th>Installation</th><th>Team leaders</th><th>Login ID</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="card muted">No units yet. Add your first unit.</div>'}
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

function personForm(p, unitId, role) {
  const v = p || { name: '', phone: '', role: role || 'helper', unitId: unitId || (A().units[0] || {}).id || '', backup: false, username: '', canLogin: false, active: true };
  openModal(`<h2>${p ? 'Edit person' : role === 'leader' ? 'Add team leader' : 'Add helper / installation person'}</h2>
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
    <div class="card section"><h2>💰 Expenses to pay</h2>
      <div class="muted small">Per person, for jobs completed in these dates, by work time (Start → Completed). Rules are in Settings.${s.noStart ? ` <span class="badge warn">${s.noStart} job(s) without start time – no expense; fix with "Edit times"</span>` : ''}</div>
      ${s.expenses.length ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Person</th><th class="num">Completed jobs</th><th class="num">Jobs with expense</th><th class="num">Amount</th></tr></thead><tbody>
        ${s.expenses.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td class="num">${r.jobs}</td><td class="num">${r.paidJobs}</td><td class="num"><b>₹${r.amount}</b></td></tr>`).join('')}
        <tr><td><b>Total</b></td><td></td><td></td><td class="num"><b>₹${s.expenses.reduce((n, r) => n + r.amount, 0)}</b></td></tr></tbody></table></div>
      <details style="margin-top:8px"><summary class="small"><b>Each job</b></summary><div class="table-wrap" style="margin-top:6px"><table><thead><tr><th>Date</th><th>Unit</th><th>Customer</th><th class="num">Work</th><th class="num">Per person</th><th class="num">People</th><th class="num">Total</th></tr></thead><tbody>
        ${s.completed.filter((c) => c.allowance).map((c) => `<tr><td>${esc(fmtDate(c.date))}${c.type === 'service' ? ' 🔧' : ''}</td><td>${esc(c.unitName)}</td><td>${esc(c.customer)}</td><td class="num">${c.allowance.minutes == null ? '<span class="badge warn">no start</span>' : esc(fmtDur(c.allowance.minutes * 60000))}</td><td class="num">₹${c.allowance.perPerson}</td><td class="num">${c.allowance.people.length}</td><td class="num"><b>₹${c.allowance.total}</b></td></tr>`).join('')}
      </tbody></table></div></details>` : '<p class="muted">No completed jobs in these dates yet.</p>'}</div>
    <div class="card section"><h2>Fairness</h2>${s.deliveries} jobs.
      <div class="small">Helpers – difference between most and least: <b>${sh}</b> ${ok(sh)}</div>
      <div class="small">Installation persons – difference: <b>${si}</b> ${ok(si)}</div>
      ${s.unfilled ? `<div class="small" style="margin-top:6px"><span class="badge bad">${s.unfilled} open places</span> – not enough people on some days.</div>` : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Person</th><th class="num">Total</th><th class="num">As helper</th><th class="num">As installer</th><th class="num">Emergency</th><th class="num">📦 Loading</th><th class="num">Leave days</th>${s.units.map((u) => `<th class="num">${esc(u.name)}</th>`).join('')}</tr></thead>
    <tbody>${s.rows.map((r) => `<tr><td><b>${esc(r.name)}</b> ${roleBadge(r.role)}${r.backup ? ' <span class="badge bad">backup</span>' : ''}${r.active ? '' : ' <span class="badge">inactive</span>'}<div class="small muted">${esc(r.unitName)}</div></td>
      <td class="num"><b>${r.total}</b></td><td class="num">${r.helper}</td><td class="num">${r.installer}</td><td class="num">${r.emergency}</td><td class="num">${r.loading || 0}</td><td class="num">${r.leaveDays}</td>${s.units.map((u) => `<td class="num">${heat(r.perUnit[u.id] || 0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="muted small">Counts include planned future jobs up to the end date. The unit columns show how often each person went on that unit's jobs — an even spread means people are shuffled well across units.</p>`;
  document.getElementById('rgo').onclick = () => { state.repFrom = document.getElementById('rf').value; state.repTo = document.getElementById('rt').value; renderAdmin(); };
}

// --- Clients & machines (Google Sheet) ---
// Code for a NEW, separate Apps Script project (it does not touch any script already in the sheet).
const appsScriptCode = (sheetId) => `// Delivery Team – reads the client and machine tabs. Separate project, so it does not
// change any other script you already use with this sheet.
const KEY = 'CHANGE-THIS-TO-A-SECRET';
const SHEET_ID = '${sheetId || 'PASTE-YOUR-SHEET-ID-HERE'}';

function doGet(e) {
  const out = (obj) => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  if (!e || !e.parameter || e.parameter.key !== KEY) return out({ error: 'wrong key' });
  const tabs = String(e.parameter.tabs || 'Party,Machines').split(',').slice(0, 5);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const data = {};
  tabs.forEach((name) => {
    const sh = ss.getSheetByName(name.trim());
    data[name] = sh ? sh.getDataRange().getDisplayValues() : null;
  });
  return out(data);
}`;
const sheetIdOf = (link) => ((String(link || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/) || [])[1] || '');

async function adminSheet(main) {
  const s = await api('/admin/sheet');
  const connected = s.scriptUrl || s.sheetLink;
  main.innerHTML = `<div class="row section"><div><h1>Clients &amp; machines</h1>
      <div class="muted small">Copied from your Google Sheet, so units can pick the customer and machines when booking.</div></div>
      <div class="spacer"></div>${connected ? '<button class="primary" id="sync">↻ Sync now</button>' : ''}</div>
    <div class="card section">
      <div class="row"><span class="badge ok">${s.clients} clients</span><span class="badge w4">${s.machines} machine models</span><span class="badge w3">${s.makers} Entry by names</span>
      ${s.lastSync ? `<span class="small muted">Last sync ${esc(fmtTime(s.lastSync))} · syncs again every 3 hours</span>` : '<span class="small muted">Not synced yet</span>'}</div>
      ${s.lastError ? `<div class="error">${esc(s.lastError)}</div>` : ''}
      <div class="lookup" style="max-width:480px;margin-top:10px"><label>Test search</label><input id="tq" placeholder="type a party name, phone or city" autocomplete="off"><div id="tres" class="small" style="margin-top:6px"></div></div>
      ${s.makerList.length ? `<details style="margin-top:10px"><summary class="small"><b>Entry by names (${s.makerList.length})</b> – from the "${esc(s.makersColumn)}" column of "${esc(s.makersTab)}"</summary><div class="small" style="margin-top:6px">${s.makerList.map(esc).join(' · ')}</div></details>` : ''}
      ${s.machineList.length ? `<details style="margin-top:10px"><summary class="small"><b>Machine list (${s.machineList.length})</b></summary><div class="small" style="margin-top:6px;columns:2">${s.machineList.map((m) => `<div>${esc(m)}</div>`).join('')}</div></details>` : ''}
    </div>
    <form class="card section" id="sheet-form"><h2>Connect your Google Sheet</h2>
      <p class="small"><b>Recommended (sheet stays private):</b></p>
      <ol class="small">
        <li>Go to <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener"><b>script.google.com → New project</b></a> (a <b>new, separate</b> project – do <u>not</u> paste into a script you already use, like your quote app).</li>
        <li>Name it e.g. <i>Delivery Team link</i>. Delete the empty <code>myFunction</code> and paste the code below.</li>
        <li>In the code, change <code>CHANGE-THIS-TO-A-SECRET</code> to your own secret word (e.g. <code>ww-9x7k2</code>). Check <code>SHEET_ID</code> is your sheet's ID (the long part of the sheet link between <code>/d/</code> and <code>/edit</code>). Save.</li>
        <li>Click <b>Deploy → New deployment</b> → ⚙️ type <b>Web app</b> → Execute as <b>Me</b>, Who has access <b>Anyone</b> → <b>Deploy</b> → allow access.</li>
        <li>Copy the <b>Web app URL</b> and paste it below with the same secret word, then <b>Save &amp; sync</b>.</li>
      </ol>
      <div class="small" style="margin-bottom:6px">Your sheet link (fills in the SHEET_ID in the code): <input id="sid-link" placeholder="https://docs.google.com/spreadsheets/d/…/edit" value="${esc(s.sheetLink)}" style="margin-top:4px"></div>
      <details><summary class="small"><b>Show Apps Script code</b></summary><textarea readonly id="code" style="min-height:300px;font-family:monospace;font-size:12px">${esc(appsScriptCode(sheetIdOf(s.sheetLink)))}</textarea><button type="button" id="copy">📋 Copy code</button></details>
      <div class="form-grid">
        <div><label>Apps Script web app URL</label><input name="scriptUrl" value="${esc(s.scriptUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div><label>Secret word ${s.key ? '(saved – leave blank to keep)' : ''}</label><input name="key" autocomplete="off" placeholder="${s.key ? '••••••' : 'same as in the script'}"></div>
        <div><label>Client tab name</label><input name="partyTab" value="${esc(s.partyTab)}"></div>
        <div><label>Machine tab name</label><input name="machineTab" value="${esc(s.machineTab)}"></div>
        <div><label>"Entry by" tab name</label><input name="makersTab" value="${esc(s.makersTab)}" placeholder="empty = type names freely"></div>
        <div><label>"Entry by" column</label><input name="makersColumn" value="${esc(s.makersColumn)}"></div>
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
      toast(`Synced: ${r.clients} clients, ${r.machines} machines, ${r.makers} names`);
      state.makers = null;
      adminSheet(main);
    } catch (ex) { toast(ex.message, true); btn.disabled = false; }
  };
  const sync = document.getElementById('sync');
  if (sync) sync.onclick = async () => {
    sync.disabled = true;
    try { const r = await api('/admin/sheet/sync', { method: 'POST' }); state.machineList = null; state.makers = null; toast(`Synced: ${r.clients} clients, ${r.machines} machines, ${r.makers} names`); adminSheet(main); } catch (ex) { toast(ex.message, true); sync.disabled = false; }
  };
  document.getElementById('sid-link').oninput = (e) => { document.getElementById('code').value = appsScriptCode(sheetIdOf(e.target.value)); };
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
      <h3 style="margin-top:16px">💰 Expense per person (by work time Start → Completed)</h3>
      <div class="muted small">Each line: from this many hours, pay this amount to each person on the job. Under the first line = nil.</div>
      <div class="slab-grid">
        <div><h4 style="margin:10px 0 0">🚚 Deliveries</h4><div id="dslabs"></div><button type="button" class="link" id="add-dslab">+ Add line</button></div>
        <div><h4 style="margin:10px 0 0">🔧 Services</h4><div id="slabs"></div><button type="button" class="link" id="add-slab">+ Add line</button></div>
      </div>
      <div class="form-grid">
        <div><label>Pay expense for</label><select name="appliesTo"><option value="all">Deliveries and services</option><option value="service" ${(s.allowance || {}).appliesTo === 'service' ? 'selected' : ''}>Services only</option></select></div>
        <div><label>Also re-calculate jobs completed from (optional)</label><input type="date" name="recalcFrom"></div>
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
  const slabBox = (id) => document.getElementById(id);
  const slabRow = (x) => `<div class="row slab" style="margin-top:6px;flex-wrap:nowrap"><span>From</span><input class="sh" type="number" step="0.5" min="0.5" max="48" value="${esc(x.fromHours)}" style="width:70px"><span>h → ₹</span><input class="sa" type="number" min="0" value="${esc(x.amount)}" style="width:80px"> <button type="button" class="link danger" title="Remove">✕</button></div>`;
  const addSlab = (id, x) => {
    slabBox(id).insertAdjacentHTML('beforeend', slabRow(x));
    const r = slabBox(id).lastElementChild;
    r.querySelector('button').onclick = () => r.remove();
  };
  ((s.allowance && s.allowance.slabs) || []).forEach((x) => addSlab('slabs', x));
  ((s.allowance && (s.allowance.deliverySlabs || s.allowance.slabs)) || []).forEach((x) => addSlab('dslabs', x));
  document.getElementById('add-slab').onclick = () => addSlab('slabs', { fromHours: '', amount: '' });
  document.getElementById('add-dslab').onclick = () => addSlab('dslabs', { fromHours: '', amount: '' });
  const sf = document.getElementById('set-form');
  sf.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(sf);
    try {
      const readSlabs = (id) => [...document.querySelectorAll(`#${id} .slab`)].map((r) => ({ fromHours: Number(r.querySelector('.sh').value), amount: Number(r.querySelector('.sa').value) })).filter((x) => x.fromHours > 0);
      const slabs = readSlabs('slabs');
      const deliverySlabs = readSlabs('dslabs');
      const body = Object.fromEntries(fd);
      body.allowance = { appliesTo: body.appliesTo, slabs, deliverySlabs, recalcFrom: body.recalcFrom };
      delete body.appliesTo; delete body.recalcFrom;
      await api('/admin/settings', { method: 'PUT', body });
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

// ---------- assembly (shared by admin / unit / team leader) ----------
const ASM_STATUS = { waiting: ['warn', '⏳ Unallocated – team leaders full'], assigned: ['w4', 'Given'], started: ['w3', '🔧 Assembling'], done: ['ok', '✓ Assembled'] };
const monthNow = () => (state.today || new Date().toISOString().slice(0, 10)).slice(0, 7);
const ageText = (iso) => { if (!iso) return ''; const d = Math.floor((Date.now() - new Date(iso)) / 86400000); return d <= 0 ? 'today' : d === 1 ? '1 day' : d + ' days'; };

// who: 'admin' | 'unit' | 'staff'; me = staff person id (team leader)
function asmCard(m, who, me) {
  const [cls, label] = ASM_STATUS[m.status] || ['', m.status];
  const canWork = who === 'admin' || who === 'unit' || (who === 'staff' && m.leader && m.leader.id === me);
  const open = m.status === 'assigned' || m.status === 'started';
  const work = m.startedAt && m.completedAt ? fmtDur(new Date(m.completedAt) - new Date(m.startedAt)) : '';
  const p = (x, role) => (x ? `<b>${esc(x.name)}</b>${x.phone ? ' ' + telLink(x.phone) : ''}` : `<span class="muted">${role} –</span>`);
  const btns = [];
  if (canWork && m.status === 'assigned') btns.push(`<button class="small" data-asm-start="${esc(m.id)}">▶ Start</button>`);
  if (canWork && open) btns.push(`<button class="small primary" data-asm-done="${esc(m.id)}">✓ Assembled</button>`);
  if (who === 'staff' && open && m.leader && m.leader.id === me) btns.push(`<button class="small" data-asm-crew="${esc(m.id)}">👥 Change team</button>`);
  if (who === 'staff' && open && m.leader && m.leader.id === me) btns.push(`<button class="small" data-asm-divert="${esc(m.id)}">↪ Divert</button>`);
  if (who === 'admin' && m.status !== 'done') btns.push(`<button class="small" data-asm-assign="${esc(m.id)}">Change people</button>`);
  // only the login that made the entry (or the admin) may correct the model no.
  const mine = who === 'admin' || (m.creator && state.me && m.creator.role === state.me.role && m.creator.id === state.me.id);
  if (mine && (m.status !== 'done' || who === 'admin')) btns.push(`<button class="small" data-asm-model="${esc(m.id)}">✎ Edit model</button>`);
  if (who === 'admin' && m.status === 'done' && m.location === 'godown') btns.push(`<button class="small" data-asm-dispatch="${esc(m.id)}">🚚 Mark dispatched</button>`);
  if (who === 'admin' && m.status === 'done') btns.push(`<button class="small" data-asm-times="${esc(m.id)}">🕒 Edit times</button>`);
  if (who === 'admin' && m.status === 'started') btns.push(`<button class="small" data-asm-undo="${esc(m.id)}" title="Start was pressed by mistake">↩ Not started</button>`);
  if (who === 'admin' && m.status === 'done' && m.location === 'godown' && !(m.transfers || []).length) btns.push(`<button class="small" data-asm-undo="${esc(m.id)}" title="Assembled was pressed by mistake">↩ Not assembled</button>`);
  if (who === 'admin' && m.status !== 'done') btns.push(`<div class="spacer"></div><button class="small danger" data-asm-cancel="${esc(m.id)}">Cancel</button>`);
  return `<div class="card unit-card${m.status === 'done' ? ' done' : ''}">
    <div class="row"><div class="name">⚙️ ${esc(m.model)}</div><div class="spacer"></div><span class="badge ${cls}">${label}</span></div>
    <div class="small muted">${who !== 'unit' ? esc(m.unitName) + ' · ' : ''}${m.source === 'request' ? '📝 requested by team leader · ' : m.source === 'old' ? '📁 old entry · ' : m.source === 'stock' ? '📦 old stock · ' : ''}added ${esc(fmtTime(m.createdAt))}${m.entryBy ? ' by ' + esc(m.entryBy) : ''}</div>
    <div class="small" style="margin-top:6px">👷 Team leader: ${p(m.leader, 'none yet')}</div>
    <div class="small">🔧 Installation: ${p(m.installer, '')} · 🧰 Helper: ${p(m.helper, '')}</div>
    <div class="small muted" style="margin-top:4px">🕒 ${m.assignedAt ? `Given ${esc(fmtTime(m.assignedAt))}` : 'Not given yet'}${m.startedAt ? ` · Started ${esc(fmtTime(m.startedAt))}` : ''}${m.completedAt ? ` · <b>Assembled ${esc(fmtTime(m.completedAt))}</b>${work ? ` (${esc(work)})` : ''}` : open ? ` · pending ${esc(ageText(m.assignedAt))}` : ''}${m.timesEditedBy ? ` <span class="badge manual">✎ times by ${esc(m.timesEditedBy)}</span>` : ''}</div>
    ${m.status === 'done' && m.location ? `<div class="small" style="margin-top:4px">${m.location === 'dispatched' ? `<span class="badge ok">🚚 Dispatched</span>${m.dispatchParty ? ' to <b>' + esc(m.dispatchParty) + '</b>' : ''}${m.dispatchedAt ? ' · ' + esc(fmtTime(m.dispatchedAt)) : ''}` : '<span class="badge w4">🏬 In godown</span>'}</div>` : ''}
    ${m.transfers && m.transfers.length ? `<div class="small muted">${m.transfers.map((x) => `🏬 Moved ${esc(x.from)} → ${esc(x.to)} ${esc(fmtTime(x.at))}${x.by ? ' by ' + esc(x.by) : ''}`).join('<br>')}</div>` : ''}
    ${m.dispatchPhotos && m.dispatchPhotos.length ? `<div class="small" style="margin-top:6px"><b>🚚 Dispatch photo</b><div class="thumbs">${m.dispatchPhotos.map((ph) => `<span class="thumb"><a href="${esc(ph.url)}" target="_blank" rel="noopener"><img src="${esc(ph.url)}" alt="dispatch photo" loading="lazy"></a></span>`).join('')}</div></div>` : ''}
    ${m.dispatchIncentive && m.dispatchIncentive.amount ? `<div class="small expense">🚚 Dispatch incentive: ₹${m.dispatchIncentive.amount} to ${esc(m.dispatchIncentive.name || '')}</div>` : ''}
    ${m.incentive && (m.incentive.leader || m.incentive.installer) ? `<div class="small expense">🏆 Incentive: team leader ₹${m.incentive.leader} · installation ₹${m.incentive.installer}</div>` : ''}
    ${m.note ? `<div class="small">📝 ${esc(m.note)}</div>` : ''}
    ${m.crewEdits && m.crewEdits.length ? `<div class="small muted">${m.crewEdits.map((x) => `👥 Team changed by ${esc(x.by)} ${esc(fmtTime(x.at))}: ${x.from.installer !== x.to.installer ? `installation ${esc(x.from.installer || '–')} → ${esc(x.to.installer || '–')}` : ''}${x.from.installer !== x.to.installer && x.from.helper !== x.to.helper ? ', ' : ''}${x.from.helper !== x.to.helper ? `helper ${esc(x.from.helper || '–')} → ${esc(x.to.helper || '–')}` : ''}`).join('<br>')}</div>` : ''}
    ${m.modelEdits && m.modelEdits.length ? `<div class="small muted">${m.modelEdits.map((x) => `✎ Model corrected: <s>${esc(x.from)}</s> → ${esc(x.to)} by ${esc(x.by)} ${esc(fmtTime(x.at))}`).join('<br>')}</div>` : ''}
    ${m.diverts && m.diverts.length ? `<div class="small absent-log">${m.diverts.map((x) => `↪ Diverted by <b>${esc(x.from)}</b> to <b>${esc(x.to)}</b> ${esc(fmtTime(x.at))}${x.amount && who === 'admin' ? ` · ₹${x.amount} deducted from ${esc(x.from)}` : ''}${x.reason ? ` (${esc(x.reason)})` : ''}`).join('<br>')}</div>` : ''}
    ${m.photos && m.photos.length ? `<div class="small" style="margin-top:6px"><b>🏷️ Sticker photo</b><div class="thumbs">${m.photos.map((ph) => `<span class="thumb"><a href="${esc(ph.url)}" target="_blank" rel="noopener"><img src="${esc(ph.url)}" alt="machine sticker" loading="lazy"></a></span>`).join('')}</div></div>` : ''}
    ${btns.length ? `<div class="row no-print" style="margin-top:8px">${btns.join('')}</div>` : ''}</div>`;
}

// Summary: for each team leader, how many of each model are given / assembling / assembled.
// showDone: the "Assembled" column is for the admin only; team leaders and units see open work.
function asmSummary(items, showDone) {
  const groups = {};
  for (const m of items) {
    if (!showDone && m.status === 'done') continue;
    const leader = m.leader ? m.leader.name : '⏳ Waiting for a team leader';
    const g = (groups[leader] = groups[leader] || { models: {}, open: 0 });
    const r = (g.models[m.model] = g.models[m.model] || { given: 0, started: 0, done: 0, waiting: 0 });
    if (m.status === 'done') r.done++;
    else { g.open++; if (m.status === 'started') r.started++; else if (m.status === 'waiting') r.waiting++; else r.given++; }
  }
  const names = Object.keys(groups).sort((a, b) => (a.startsWith('⏳') ? 1 : 0) - (b.startsWith('⏳') ? 1 : 0) || a.localeCompare(b));
  if (!names.length) return '';
  const rows = names.flatMap((n) => Object.entries(groups[n].models).map(([model, r], i) => `<tr>${i === 0 ? `<td rowspan="${Object.keys(groups[n].models).length}"><b>${esc(n)}</b>${n.startsWith('⏳') ? '' : `<div class="small muted">${groups[n].open} open</div>`}</td>` : ''}
      <td>${esc(model)}</td><td class="num"><b>${r.given + r.started + r.waiting + (showDone ? r.done : 0)}</b></td><td class="num">${r.waiting || r.given || ''}</td><td class="num">${r.started || ''}</td>${showDone ? `<td class="num">${r.done || ''}</td>` : ''}</tr>`));
  return `<div class="card section"><h3 style="margin-top:0">📦 Given to each team leader</h3><div class="table-wrap"><table>
    <thead><tr><th>Team leader</th><th>Model no.</th><th class="num">Qty</th><th class="num">Not started</th><th class="num">Assembling</th>${showDone ? '<th class="num">Assembled</th>' : ''}</tr></thead><tbody>${rows.join('')}</tbody></table></div>
    ${showDone ? '<div class="small muted" style="margin-top:4px">Assembled = last 30 days.</div>' : ''}</div>`;
}

// One short line per machine; tap it to open the full card (with its buttons).
// Model saved under a name that has no incentive rate: no incentive until it is corrected.
const NORATE = '<span class="badge bad small" style="align-self:flex-start">⚠ No incentive rate – correct the model no.</span>';
function asmRow(m, who, me) {
  const [cls, label] = ASM_STATUS[m.status] || ['', m.status];
  const crew = [m.installer && '🔧 ' + m.installer.name, m.helper && '🧰 ' + m.helper.name].filter(Boolean).join(' · ') || 'no team yet';
  const when = m.status === 'done'
    ? `${fmtTime(m.completedAt)}${m.location === 'dispatched' ? ' · 🚚' : m.location === 'godown' ? ' · 🏬' : ''}`
    : m.status === 'waiting' ? 'waiting ' + ageText(m.createdAt) : (m.status === 'started' ? 'started ' : 'given ') + ageText(m.startedAt || m.assignedAt);
  return `<details class="done-row asm-row"><summary>
      <span class="badge ${cls} asm-dot" title="${esc(label)}">${m.status === 'done' ? '✓' : m.status === 'started' ? '🔧' : m.status === 'waiting' ? '⏳' : '•'}</span>
      <span class="dr-main"><b>${esc(m.model)}</b>${m.noRate ? NORATE : ''}<span class="small muted">${esc(crew)}${who === 'admin' ? ' · ' + esc(m.unitName) : ''}</span></span>
      <span class="dr-side small">${esc(label.replace(/^[^ ]+ /, ''))}<br>${esc(when)}</span>
    </summary><div class="dr-body">${asmCard(m, who, me)}</div></details>`;
}

// Machines grouped by team leader (waiting ones last), as compact lists.
// Same model + status + team = one line "× N"; tap to see each machine (and its buttons).
function asmCluster(ms, who, me) {
  if (ms.length === 1) return asmRow(ms[0], who, me);
  const m = ms[0];
  const [cls, label] = ASM_STATUS[m.status] || ['', m.status];
  const uniq = (f) => [...new Set(ms.map(f).filter(Boolean))].join(', ');
  const crew = [uniq((x) => x.installer && x.installer.name) && '🔧 ' + uniq((x) => x.installer && x.installer.name), uniq((x) => x.helper && x.helper.name) && '🧰 ' + uniq((x) => x.helper && x.helper.name)].filter(Boolean).join(' · ') || 'no team yet';
  return `<details class="done-row asm-row asm-cluster"><summary>
      <span class="badge ${cls} asm-dot">${m.status === 'done' ? '✓' : m.status === 'started' ? '🔧' : m.status === 'waiting' ? '⏳' : '•'}</span>
      <span class="dr-main"><b>${esc(m.model)} <span class="qty-tag">× ${ms.length}</span></b>${m.noRate ? NORATE : ''}<span class="small muted">${esc(crew)}${who === 'admin' ? ' · ' + esc(m.unitName) : ''}</span></span>
      <span class="dr-side small">${esc(label.replace(/^[^ ]+ /, ''))}<br>tap to see each</span>
    </summary><div class="dr-body">${ms.map((x) => asmRow(x, who, me)).join('')}</div></details>`;
}

// Team summary as text, for copying / WhatsApp.
function teamText(name, g) {
  const by = {};
  for (const m of g) {
    const k = [m.status, m.model].join('|');
    const x = (by[k] ||= { m, n: 0, inst: new Set(), help: new Set() });
    x.n++;
    if (m.installer) x.inst.add(m.installer.name);
    if (m.helper) x.help.add(m.helper.name);
  }
  const part = (status, title) => {
    const rows = Object.values(by).filter((x) => x.m.status === status);
    if (!rows.length) return [];
    const total = rows.reduce((n, x) => n + x.n, 0);
    return [`${title} (${total})`, ...rows.map((x) => `• ${x.m.model} × ${x.n}${x.inst.size || x.help.size ? ` – ${[[...x.inst].join(', '), [...x.help].join(', ')].filter(Boolean).join(' / ')}` : ''}`), ''];
  };
  return [`*👷 ${name} – Assembly ${fmtDate(state.today || new Date().toISOString().slice(0, 10))}*`, `Total: ${g.length} machine${g.length > 1 ? 's' : ''}`, '',
    ...part('started', '🔧 Assembling'), ...part('assigned', '• Given, not started'), ...part('waiting', '⏳ Waiting'), ...part('done', '✓ Assembled')].join('\n').trim();
}

// Machines grouped by team leader (waiting ones last), as compact lists.
function asmGrouped(list, who, me) {
  const groups = {};
  for (const m of list) (groups[m.leader ? m.leader.name : '⏳ Unallocated – waiting for a free team leader'] ||= []).push(m);
  const names = Object.keys(groups).sort((a, b) => (a.startsWith('⏳') ? 1 : 0) - (b.startsWith('⏳') ? 1 : 0) || a.localeCompare(b));
  state.teamTexts = state.teamTexts || {};
  return names.map((n, gi) => {
    const g = groups[n];
    const started = g.filter((m) => m.status === 'started').length;
    const clusters = {};
    for (const m of g) (clusters[[m.status, m.model].join('|')] ||= []).push(m);
    const tid = 't' + Math.random().toString(36).slice(2, 8) + gi;
    state.teamTexts[tid] = teamText(n.replace(/^⏳ /, ''), g);
    return `<div class="done-list asm-group"><div class="dl-head row"><span><b>👷 ${esc(n)}</b> <span class="muted">· ${g.length} machine${g.length > 1 ? 's' : ''}${started ? ` · ${started} assembling` : ''}</span></span><span class="spacer"></span>
        <button type="button" class="link small" data-team-copy="${tid}">📋 Copy</button><button type="button" class="link small" data-team-wa="${tid}">📤 WhatsApp</button></div>
      ${Object.values(clusters).map((c) => asmCluster(c, who, me)).join('')}</div>`;
  }).join('');
}

function asmList(items, who, me) {
  const open = items.filter((m) => m.status !== 'done');
  const done = items.filter((m) => m.status === 'done');
  const admin = who === 'admin'; // assembled machines: admin only
  return `${asmSummary(items, admin)}${open.length ? asmGrouped(open, who, me) : '<div class="card muted">No machine pending.</div>'}
    ${admin && done.length ? `<details class="card" style="margin-top:12px"><summary><b>✓ Assembled – last 30 days (${done.length})</b></summary><div style="margin-top:10px">${asmGrouped(done, who, me)}</div></details>` : ''}`;
}

async function asmBoardHtml(month, maxPending) {
  const b = await api('/assembly/board?month=' + month);
  const admin = state.me && state.me.role === 'admin'; // deduction columns: admin only
  const lead = b.leaders.map((r, i) => `<tr><td>${i < 3 && r.done ? ['🥇', '🥈', '🥉'][i] : i + 1}</td><td><b>${esc(r.name)}</b><div class="small muted">${esc(r.unitName)}</div></td>
      <td class="num"><b>${r.done}</b></td><td class="num">${r.pending >= (maxPending || 6) ? `<span class="badge bad">${r.pending} – full</span>` : r.pending}${r.oldestPending ? `<div class="small muted">oldest ${esc(ageText(r.oldestPending))}</div>` : ''}</td>
      <td class="num">${r.avgMinutes == null ? '—' : esc(fmtDur(r.avgMinutes * 60000))}</td>${admin ? `<td class="num">₹${r.incentive}</td><td class="num">${r.deduction ? `<span class="empty">−₹${r.deduction}</span><div class="small muted">${r.diverted} diverted</div>` : '—'}</td><td class="num"><b>₹${r.incentive - (r.deduction || 0)}</b></td>` : `<td class="num"><b>₹${r.incentive}</b></td>`}<td class="num muted">${r.allTime}</td></tr>`).join('');
  const inst = b.installers.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td class="num">${r.done}</td><td class="num"><b>₹${r.incentive}</b></td></tr>`).join('');
  return `<div class="card section"><div class="row"><h2 style="margin:0">🏆 Assembly scoreboard</h2><div class="spacer"></div><input type="month" id="asm-month" value="${esc(month)}" style="width:auto"></div>
    <div class="small muted">${b.totalDone} machine(s) assembled in this month${b.waiting ? ` · <span class="badge warn">${b.waiting} waiting for a free team leader</span>` : ''}. Pending = given but not assembled yet (team leaders with ${maxPending || 6} pending get no new machine).</div>
    ${lead ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>#</th><th>Team leader</th><th class="num">Assembled</th><th class="num">Pending</th><th class="num">Avg time</th>${admin ? '<th class="num">Incentive</th><th class="num">Deduction</th><th class="num">Net</th>' : '<th class="num">Incentive</th>'}<th class="num">All time</th></tr></thead><tbody>${lead}</tbody></table></div>` : '<p class="muted">No team leaders yet.</p>'}
    ${inst ? `<h3 style="margin-top:12px">Installation persons</h3><div class="table-wrap"><table><thead><tr><th>Name</th><th class="num">Assembled</th><th class="num">Incentive</th></tr></thead><tbody>${inst}</tbody></table></div>` : ''}</div>`;
}

// Where the machine is after assembly.
// An assembled machine always goes into godown stock. Sending it to a client is done
// only from the Dispatch login (with dispatch photo), once it is in the godown.
function asmLocationFields() {
  return `<label>📍 Where is the machine now?</label>
    <div class="note small">🏬 It goes into <b>godown stock</b>. Dispatch to a client is done from the 🚚 Dispatch login.</div>`;
}
function bindLocation() {}
function locationValue() {
  return { location: 'godown' };
}

// Start date + time and end date + time (assembly can take more than a day).
function asmTimesForm(m, endIso, old) {
  const st = localInput(m.startedAt);
  const en = localInput(endIso);
  const sDate = st ? st.slice(0, 10) : en.slice(0, 10); // start not pressed: same day as the end, type the time
  return `<div class="form-grid">
      <div><label>Start date *</label><input type="date" id="a-sd" value="${esc(sDate)}"></div>
      <div><label>Start time * ${m.startedAt || old ? '' : '<span class="badge warn">Start not pressed</span>'}</label><input type="time" id="a-st" value="${esc(st.slice(11))}"></div>
      <div><label>End date *</label><input type="date" id="a-ed" value="${esc(en.slice(0, 10))}"></div>
      <div><label>End time *</label><input type="time" id="a-et" value="${esc(en.slice(11))}"></div>
    </div>`;
}
function asmTimesValue() {
  const g = (id) => document.getElementById(id).value;
  if (!g('a-sd') || !g('a-st')) throw new Error('Start date and time are compulsory');
  if (!g('a-ed') || !g('a-et')) throw new Error('End date and time are compulsory');
  const s = new Date(`${g('a-sd')}T${g('a-st')}`);
  const e = new Date(`${g('a-ed')}T${g('a-et')}`);
  if (!(e > s)) throw new Error('End must be after start');
  return { startedAt: s.toISOString(), completedAt: e.toISOString() };
}

function bindAsm(root, base, items, reload) {
  const find = (id) => items.find((m) => m.id === id);
  root.querySelectorAll('[data-team-copy]').forEach((b) => (b.onclick = async () => {
    const text = state.teamTexts[b.dataset.teamCopy] || '';
    try { await navigator.clipboard.writeText(text); toast('Team details copied – paste in WhatsApp'); }
    catch { prompt('Copy this text:', text); }
  }));
  root.querySelectorAll('[data-team-wa]').forEach((b) => (b.onclick = () => window.open('https://wa.me/?text=' + encodeURIComponent(state.teamTexts[b.dataset.teamWa] || ''), '_blank')));
  const post = async (url, msg, body) => { try { await api(url, { method: 'POST', body }); toast(msg); reload(); } catch (ex) { toast(ex.message, true); } };
  root.querySelectorAll('[data-asm-start]').forEach((b) => (b.onclick = () => post(`${base}/${b.dataset.asmStart}/start`, 'Started – time noted')));
  root.querySelectorAll('[data-asm-done]').forEach((b) => (b.onclick = () => {
    const m = find(b.dataset.asmDone);
    openModal(`<h2>Machine assembled</h2><div class="muted">⚙️ ${esc(m.model)} · ${esc(m.unitName)}</div>
      <p class="small"><b>Start and end date / time are compulsory.</b> Change them if Start was not pressed on time.</p>
      ${asmTimesForm(m, new Date().toISOString())}
      <label>🏷️ Photo of the machine sticker (JPG) ${base.startsWith('/admin') ? '(optional for admin)' : '*'}</label>
      <div class="muted small">Take a clear photo of the sticker / name plate on the assembled machine. It is saved as JPG.</div>
      <div id="a-photos"></div>
      ${asmLocationFields()}
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">✓ Assembled</button></div>`,
    async () => {
      const times = asmTimesValue();
      const photos = getPhotos();
      if (!photos.length && !base.startsWith('/admin')) throw new Error('Take a photo (JPG) of the machine sticker first');
      await api(`${base}/${m.id}/complete`, { method: 'POST', body: { ...times, photos, ...locationValue() } });
      toast('Assembled – well done!');
      reload();
    });
    const getPhotos = photoPicker(document.getElementById('a-photos'));
    bindLocation();
  }));
  root.querySelectorAll('[data-asm-undo]').forEach((b) => (b.onclick = async () => {
    const m = find(b.dataset.asmUndo);
    const q = m.status === 'started' ? `Put ${m.model} back to NOT STARTED? (Start was pressed by mistake)` : `Put ${m.model} back to ASSEMBLING? Its end time, godown entry and incentive are removed.`;
    if (!confirm(q)) return;
    try { await api(`/admin/assembly/${m.id}/undo`, { method: 'POST' }); toast('Corrected'); reload(); } catch (ex) { toast(ex.message, true); }
  }));
  root.querySelectorAll('[data-asm-crew]').forEach((b) => (b.onclick = async () => {
    const m = find(b.dataset.asmCrew);
    const r = await api('/staff/assembly');
    const others = items.filter((x) => x.id !== m.id && x.leader && m.leader && x.leader.id === m.leader.id && (x.status === 'assigned' || x.status === 'started')).length;
    const sel = (name, roles, cur) => `<select name="${name}"><option value="">— keep —</option>${r.crew.filter((x) => roles.includes(x.role)).map((x) => `<option value="${esc(x.id)}" ${cur && cur.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
    openModal(`<h2>👥 Change team</h2><div class="muted">⚙️ ${esc(m.model)}</div>
      <label>🔧 Installation person</label>${sel('installerId', ['installer', 'both'], m.installer)}
      <label>🧰 Helper</label>${sel('helperId', ['helper', 'both'], m.helper)}
      ${others ? `<label class="check"><input type="checkbox" name="all"> Also use this team on my other ${others} open machine${others > 1 ? 's' : ''}</label>` : ''}
      <p class="muted small">The change is shown on the machine card.</p>
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
    async (fd) => {
      await api(`/staff/assembly/${m.id}/crew`, { method: 'POST', body: { installerId: fd.get('installerId'), helperId: fd.get('helperId'), all: fd.get('all') === 'on' } });
      toast('Team changed');
      reload();
    });
  }));
  root.querySelectorAll('[data-asm-model]').forEach((b) => (b.onclick = async () => {
    const m = find(b.dataset.asmModel);
    const same = items.filter((x) => x.id !== m.id && x.model === m.model && (m.status === 'done' ? true : x.status !== 'done') && (base.startsWith('/staff') ? x.leader && m.leader && x.leader.id === m.leader.id : x.unitId === m.unitId)).length;
    const models = await loadMachineList();
    openModal(`<h2>✎ Edit model no.</h2><div class="muted">Now: ⚙️ ${esc(m.model)}</div>
      <label>Correct model no. *</label><input name="model" list="asm-models-e" required value="${esc(m.model)}">
      <datalist id="asm-models-e">${models.map((x) => `<option value="${esc(typeof x === 'string' ? x : x.label)}"></option>`).join('')}</datalist>
      ${same ? `<label class="check"><input type="checkbox" name="all" checked> Also change the other ${same} machine${same > 1 ? 's' : ''} with “${esc(m.model)}”</label>` : ''}
      ${m.status === 'done' ? '<p class="small">This machine is assembled – the incentive is worked out again for the new model.</p>' : ''}
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
    async (fd) => {
      const r = await api(`${base}/${m.id}/model`, { method: 'POST', body: { model: fd.get('model'), all: fd.get('all') === 'on' } });
      toast('Model no. corrected');
      reload();
    });
  }));
  root.querySelectorAll('[data-asm-dispatch]').forEach((b) => (b.onclick = () => {
    const m = find(b.dataset.asmDispatch);
    openModal(`<h2>🚚 Mark dispatched</h2><div class="muted">⚙️ ${esc(m.model)} · now in godown</div>
      <label>Client / party name</label><input name="party" placeholder="optional">
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Dispatched</button></div>`,
    async (fd) => { await api(`${base}/${m.id}/dispatch`, { method: 'POST', body: Object.fromEntries(fd) }); toast('Marked dispatched'); reload(); });
  }));
  root.querySelectorAll('[data-asm-divert]').forEach((b) => (b.onclick = async () => {
    const m = find(b.dataset.asmDivert);
    const r = await api('/staff/assembly/leaders');
    openModal(`<h2>↪ Divert machine</h2><div class="muted">⚙️ ${esc(m.model)}</div>
      <label>Give to team leader *</label>${r.leaders.length ? `<select name="toLeaderId" required><option value="">— choose —</option>${r.leaders.map((l) => `<option value="${esc(l.id)}" ${l.full ? 'disabled' : ''}>${esc(l.name)} – ${l.pending} pending${l.full ? ' (full)' : ''}</option>`).join('')}</select>` : '<div class="error">No other team leader in your unit.</div>'}
      <label>Reason</label><input name="reason" placeholder="e.g. too much work, on leave tomorrow">
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Divert</button></div>`,
    async (fd) => {
      if (!fd.get('toLeaderId')) throw new Error('Choose a team leader');
      await api(`/staff/assembly/${m.id}/divert`, { method: 'POST', body: Object.fromEntries(fd) });
      toast('Machine diverted');
      reload();
    });
  }));
  root.querySelectorAll('[data-asm-times]').forEach((b) => (b.onclick = () => {
    const m = find(b.dataset.asmTimes);
    openModal(`<h2>Edit assembly times</h2><div class="muted">⚙️ ${esc(m.model)} · ${esc(m.leader ? m.leader.name : '')}</div>${asmTimesForm(m, m.completedAt)}
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
    async () => { await api(`/admin/assembly/${m.id}/times`, { method: 'POST', body: asmTimesValue() }); toast('Times saved'); reload(); });
  }));
  root.querySelectorAll('[data-asm-cancel]').forEach((b) => (b.onclick = () => { if (confirm('Cancel this machine?')) post(`/admin/assembly/${b.dataset.asmCancel}/cancel`, 'Cancelled'); }));
  root.querySelectorAll('[data-asm-assign]').forEach((b) => (b.onclick = () => {
    const m = find(b.dataset.asmAssign);
    const ppl = A().people.filter((p) => p.active);
    const sel = (name, roles, cur, unit) => `<select name="${name}"><option value="">— none —</option>${ppl.filter((p) => roles.includes(p.role)).sort((a, c) => (c.unitId === unit) - (a.unitId === unit) || a.name.localeCompare(c.name)).map((p) => `<option value="${esc(p.id)}" ${cur && cur.id === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.unitName || '—')})</option>`).join('')}</select>`;
    openModal(`<h2>Change people</h2><div class="muted">⚙️ ${esc(m.model)} · ${esc(m.unitName)}</div>
      <label>👷 Team leader</label>${sel('leaderId', ['leader'], m.leader, m.unitId)}
      <label>🔧 Installation person</label>${sel('installerId', ['installer', 'both'], m.installer, m.unitId)}
      <label>🧰 Helper</label>${sel('helperId', ['helper', 'both'], m.helper, m.unitId)}
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
    async (fd) => { await api(`/admin/assembly/${m.id}/assign`, { method: 'POST', body: Object.fromEntries(fd) }); toast('Saved'); reload(); });
  }));
}

// Add machines that came for assembly (unit / admin).
async function asmAddForm(base, reload) {
  const isAdmin = base === '/admin';
  const isLeader = base === '/staff'; // the leader's own login is the entry
  const [models, makers] = await Promise.all([loadMachineList(), isLeader ? [] : loadMakers()]);
  openModal(`<h2>Machines for assembly</h2>
    ${isAdmin ? `<label>Unit *</label><select name="unitId" required>${A().units.filter((u) => u.active).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select>` : ''}
    ${isLeader ? `<div class="small muted">✍️ Entry by: <b>${esc(state.me.name)}</b> (your login)</div>` : `<label>✍️ Entry by *</label>${makers.length ? `<select name="entryBy" required><option value="">— choose your name —</option>${makers.map((n) => `<option>${esc(n)}</option>`).join('')}</select>` : '<input name="entryBy" required placeholder="your name">'}`}
    <div class="form-grid"><div><label>⚙️ Model no. *</label><input name="model" list="asm-models" required placeholder="Model no."></div>
      <div><label>Quantity *</label><input name="qty" type="number" min="1" max="50" value="1" required></div></div>
    <datalist id="asm-models">${models.map((m) => `<option value="${esc(typeof m === 'string' ? m : m.label)}"></option>`).join('')}</datalist>
    <label>Note</label><input name="note" placeholder="optional">
    <p class="muted small">Each machine goes to the team leader whose team has the fewest machines open (with 1 installation person + 1 helper). A team leader with too many pending gets none – the machine waits for the next free leader.</p>
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Add</button></div>`,
  async (fd) => { await api(isLeader ? '/staff/assembly/machines' : `${base}/assembly`, { method: 'POST', body: Object.fromEntries(fd) }); toast('Added – machines given out'); reload(); });
}

// ----- unit: Jobs | Assembly switch -----
function unitSwitchHtml(cur) {
  return `<div class="seg no-print"><button data-umode="jobs" class="${cur === 'jobs' ? 'on' : ''}">🚚 Jobs</button><button data-umode="assembly" class="${cur === 'assembly' ? 'on' : ''}">🛠️ Assembly</button></div>`;
}
function bindUnitSwitch() {
  document.querySelectorAll('[data-umode]').forEach((b) => (b.onclick = () => { state.unitMode = b.dataset.umode; renderUnit(); }));
}
async function renderUnitAssembly() {
  const wrap = $app.querySelector('.wrap');
  const r = await api('/unit/assembly');
  const month = state.asmMonth || monthNow();
  wrap.innerHTML = `${unitSwitchHtml('assembly')}
    <div class="row section"><div><h1 style="margin:0">🛠️ Assembly</h1>
      <div class="small muted">Team leaders: ${r.leaders.map((l) => `${esc(l.name)} (${l.pending} pending${l.pending >= r.maxPending ? ' – full' : ''})`).join(' · ') || 'none – ask the admin to add team leaders'}</div></div>
      <div class="spacer"></div><span class="small muted">New machines and stock are entered by team leaders from their own login.</span></div>
    ${asmList(r.items, 'unit')}
    <div id="u-godown"></div>
    <div id="asm-board"><div class="loading">Loading scoreboard…</div></div>`;
  api('/unit/assembly/stock').then((g) => { const box = document.getElementById('u-godown'); if (box) box.innerHTML = godownHtml(g.stock, false, '🏬 Our godown stock') + ((g.toFix || []).length ? godownHtml(g.toFix, false, '⚠ Our entries to correct (now in other godowns)') : '') + '<div class="small muted" style="margin:-8px 0 12px">Dispatch to clients / other units is done from the 🚚 Dispatch login.</div>'; });
  bindUnitSwitch();
  bindAsm(wrap, '/unit/assembly', r.items, renderUnit);
  await drawBoard(month, r.maxPending, renderUnit);
}
async function drawBoard(month, maxPending, reload) {
  const box = document.getElementById('asm-board');
  if (!box) return;
  box.innerHTML = await asmBoardHtml(month, maxPending);
  document.getElementById('asm-month').onchange = (e) => { state.asmMonth = e.target.value; drawBoard(e.target.value, maxPending, reload); };
}

// ----- team leader / installation person / helper -----
async function staffAssemblyHtml(wrap) {
  const r = await api('/staff/assembly');
  const me = state.me.id;
  const box = document.createElement('div');
  box.innerHTML = `<div class="row section" style="margin-top:20px"><h2 style="margin:0">🛠️ My assembly</h2><div class="spacer"></div>
      ${r.myMonth && r.myMonth.machines ? `<span class="badge ok">🏆 This month: ${r.myMonth.machines} machine${r.myMonth.machines > 1 ? 's' : ''} · ₹${r.myMonth.incentive}</span>` : ''}
      ${r.isLeader ? `<span class="badge ${r.pending >= r.maxPending ? 'bad' : 'w4'}">${r.pending} / ${r.maxPending} pending</span> <button class="primary small" id="asm-new-l">+ Machines for assembly</button> <button class="small" id="asm-stock-l">📦 Add stock</button> <button class="small" id="asm-req">📝 Request machines</button> <button class="small" id="asm-old-l">📁 Add old machine</button> <button class="small" id="asm-rates">💰 Incentive rates</button>` : ''}</div>
    ${r.items.length ? asmList(r.items, 'staff', me) : '<div class="card muted">No assembly machine for you right now.</div>'}
    ${r.requests.length ? `<div class="card" style="margin-top:12px"><h3>My requests</h3>${r.requests.map((q) => `<div class="small">${q.type === 'old' ? '📁 Old machine: ' : '⚙️ '}${esc(q.model)} × ${q.qty}${q.type === 'old' ? ` (${esc(fmtTime(q.startedAt))} → ${esc(fmtTime(q.completedAt))})` : ''} – ${q.status === 'pending' ? '<span class="badge warn">waiting for admin</span>' : q.status === 'approved' ? `<span class="badge ok">approved ${q.approvedQty || q.qty}</span>` : '<span class="badge bad">rejected</span>'}${q.reason ? ' · ' + esc(q.reason) : ''}</div>`).join('')}</div>` : ''}
    ${r.isLeader ? godownHtml(r.stock || [], false, `🏬 ${esc(r.unitName || 'Our')} godown stock`) + ((r.toFix || []).length ? godownHtml(r.toFix, false, '⚠ My entries to correct (now in other godowns)') : '') : ''}
    <div id="asm-board"></div>`;
  wrap.appendChild(box);
  bindAsm(box, '/staff/assembly', r.items, renderStaff);
  const newBtn = document.getElementById('asm-new-l');
  if (newBtn) newBtn.onclick = () => asmAddForm('/staff', renderStaff);
  const stockBtn = document.getElementById('asm-stock-l');
  if (stockBtn) stockBtn.onclick = () => oldStockForm('/staff/assembly/stock', [{ id: r.unitId, name: r.unitName }], renderStaff, true);
  const ratesBtn = document.getElementById('asm-rates');
  if (ratesBtn) ratesBtn.onclick = async () => {
    const [rt, models] = await Promise.all([api('/staff/assembly/incentives'), loadMachineList()]);
    const opts = models.map((x) => `<option value="${esc(typeof x === 'string' ? x : x.label)}"></option>`).join('');
    openModal(`<h2>💰 Incentive rates</h2>
      <p class="small muted">You can add a <b>new model</b>. Existing rates can be changed only by the admin.</p>
      <details><summary class="small"><b>🛠️ Assembly rates (${rt.incentives.length})</b></summary><div class="table-wrap" style="margin-top:6px"><table><thead><tr><th>Model no.</th><th class="num">Leader ₹</th><th class="num">Install ₹</th></tr></thead><tbody>
        ${rt.incentives.map((x) => `<tr><td>${esc(x.model)}</td><td class="num">${x.leader}</td><td class="num">${x.installer}</td></tr>`).join('')}</tbody></table></div></details>
      <details><summary class="small"><b>🚚 Dispatch rates (${rt.dispatchIncentives.length})</b></summary><div class="table-wrap" style="margin-top:6px"><table><thead><tr><th>Model no.</th><th class="num">Dispatch ₹</th></tr></thead><tbody>
        ${rt.dispatchIncentives.map((x) => `<tr><td>${esc(x.model)}</td><td class="num">${x.amount}</td></tr>`).join('')}</tbody></table></div></details>
      <h3 style="margin-top:12px">Add a new model</h3>
      <label>Rate for *</label><select name="type" id="r-type"><option value="assembly">🛠️ Assembly (leader + installation)</option><option value="dispatch">🚚 Dispatch</option></select>
      <label>⚙️ Model no. *</label><input name="model" list="r-models" required><datalist id="r-models">${opts}</datalist>
      <div class="form-grid" id="r-asm"><div><label>Leader ₹</label><input name="leader" type="number" min="0"></div><div><label>Install ₹</label><input name="installer" type="number" min="0"></div></div>
      <div id="r-dsp" hidden><label>Dispatch ₹</label><input name="amount" type="number" min="0"></div>
      <div class="actions"><button value="cancel">Close</button><button class="primary" value="ok">Add rate</button></div>`,
    async (fd) => { await api('/staff/assembly/incentives', { method: 'POST', body: Object.fromEntries(fd) }); toast('Rate added – the admin can see who added it'); });
    const t = document.getElementById('r-type');
    t.onchange = () => { document.getElementById('r-asm').hidden = t.value !== 'assembly'; document.getElementById('r-dsp').hidden = t.value !== 'dispatch'; };
  };
  const oldBtn = document.getElementById('asm-old-l');
  if (oldBtn) oldBtn.onclick = async () => {
    const models = await loadMachineList();
    const sel = (name, roles, label) => `<label>${label}</label><select name="${name}"><option value="">— none —</option>${r.crew.filter((x) => roles.includes(x.role)).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>`;
    openModal(`<h2>📁 Add old machine</h2><p class="small">A machine that was missed earlier. It is added to your record straight away.</p>
      <label>Status *</label><select name="completed" id="o-status"><option value="yes">✓ Completed (assembled)</option><option value="no">🔧 Still assembling</option></select>
      <div class="form-grid"><div><label>⚙️ Model no. *</label><input name="model" list="asm-models" required></div><div><label>Quantity</label><input name="qty" type="number" min="1" max="10" value="1"></div></div>
      <datalist id="asm-models">${models.map((m) => `<option value="${esc(typeof m === 'string' ? m : m.label)}"></option>`).join('')}</datalist>
      ${sel('installerId', ['installer', 'both'], '🔧 Installation person')}${sel('helperId', ['helper', 'both'], '🧰 Helper')}
      ${asmTimesForm({}, '', true)}
      <div id="o-done">
        <label>🏷️ Photo of the machine sticker (JPG) *</label><div id="o-photos"></div>
        ${asmLocationFields()}
      </div>
      <label>Note</label><input name="note" placeholder="e.g. assembled in October, not entered">
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Add</button></div>`,
    async (fd) => {
      const done = fd.get('completed') !== 'no';
      const g = (id) => document.getElementById(id).value;
      if (!g('a-sd') || !g('a-st')) throw new Error('Start date and time are compulsory');
      const body = { ...Object.fromEntries(fd), startedAt: new Date(`${g('a-sd')}T${g('a-st')}`).toISOString() };
      if (done) {
        Object.assign(body, asmTimesValue());
        body.photos = getOldPhotos();
        if (!body.photos.length) throw new Error('Take a photo (JPG) of the machine sticker');
        Object.assign(body, locationValue());
      } else { delete body.completedAt; }
      await api('/staff/assembly/old', { method: 'POST', body });
      toast(done ? 'Old machine added as assembled' : 'Added – finish it from your list');
      renderStaff();
    });
    const getOldPhotos = photoPicker(document.getElementById('o-photos'));
    bindLocation();
    const st = document.getElementById('o-status');
    const sync = () => {
      const done = st.value !== 'no';
      document.getElementById('o-done').hidden = !done;
      ['a-ed', 'a-et'].forEach((id) => { document.getElementById(id).closest('div').hidden = !done; });
    };
    st.onchange = sync;
    sync();
  };
  const req = document.getElementById('asm-req');
  if (req) req.onclick = async () => {
    const models = await loadMachineList();
    openModal(`<h2>Request machines</h2><p class="small">The admin approves before the machines are given to you.</p>
      <div class="form-grid"><div><label>⚙️ Model no. *</label><input name="model" list="asm-models" required></div><div><label>Quantity *</label><input name="qty" type="number" min="1" max="20" value="1" required></div></div>
      <datalist id="asm-models">${models.map((m) => `<option value="${esc(typeof m === 'string' ? m : m.label)}"></option>`).join('')}</datalist>
      <label>Note</label><input name="note" placeholder="optional">
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Send request</button></div>`,
    async (fd) => { await api('/staff/assembly/request', { method: 'POST', body: Object.fromEntries(fd) }); toast('Request sent to admin'); renderStaff(); });
  };
  await drawBoard(state.asmMonth || monthNow(), r.maxPending, renderStaff);
}

// ----- admin tab -----
async function adminAssembly(main) {
  const r = await api('/admin/assembly');
  const f = state.asmFilter || { status: 'open', unit: '' };
  const items = r.items.filter((m) => m.source !== 'stock' && (!f.unit || (m.asmUnitId || m.unitId) === f.unit) && (f.status === 'all' || (f.status === 'open' ? m.status !== 'done' : m.status === f.status)));
  const pendingReq = r.requests.filter((q) => q.status === 'pending');
  const s = r.settings;
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`;
  const leaderCards = A().units.filter((u) => u.active).map((u) => {
    const ls = A().people.filter((p) => p.role === 'leader' && p.unitId === u.id);
    const waitingHere = r.items.filter((m) => m.unitId === u.id && m.status === 'waiting').length;
    return `<div class="card unit-card"><div class="row"><div class="name">${esc(u.name)}</div><div class="spacer"></div><button class="small" data-add-leader="${esc(u.id)}">+ Add team leader</button></div>
      ${waitingHere ? `<div class="small"><span class="badge warn">${waitingHere} machine(s) waiting</span>${ls.length ? '' : ' – add a team leader so they can be given out'}</div>` : ''}
      ${ls.length ? ls.map((p) => { const x = r.leaders.find((l) => l.id === p.id); return `<div class="drv"><div class="who-line"><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="badge">inactive</span>'} ${p.canLogin ? '<span class="badge ok">can log in</span>' : '<span class="badge warn">no login PIN</span>'}</div>
        <div class="sub-line small"><span class="muted">${x ? x.pending : 0} pending</span>${telLink(p.phone)}<button class="link small" data-edit-leader="${esc(p.id)}">Edit</button><button class="link small danger" data-del-leader="${esc(p.id)}">Remove</button></div></div>`; }).join('') : '<div class="small muted" style="margin-top:6px">No team leader yet.</div>'}</div>`;
  }).join('');
  main.innerHTML = `<div class="row section"><h1 style="margin:0">🛠️ Assembly</h1><div class="spacer"></div>
      <button id="asm-old">📁 Add old machine</button><button id="asm-stock">📦 Add stock</button><button class="primary" id="asm-add">+ Machines for assembly</button></div>
    <div class="section"><h2>👷 Team leaders by unit</h2><div class="muted small" style="margin-bottom:8px">Machines of a unit are shared equally between its team leaders (each with 1 installation person + 1 helper of the unit). Adding a leader gives out waiting machines at once; removing one sends their unfinished machines back to the others. Give a PIN so the leader can log in.</div>
      <div class="grid">${leaderCards}</div></div>
    ${pendingReq.length ? `<div class="card section"><h2>📝 Requests from team leaders (${pendingReq.length})</h2><div class="small muted">📝 = wants new machines · 📁 = old machine to add to their record</div>${pendingReq.map((q) => `<div class="row" style="border-bottom:1px solid var(--line);padding:6px 0">
        <div><b>${esc(q.leaderName)}</b> <span class="small muted">${esc(q.unitName)} · ${q.leaderPending} pending now</span><div class="small">${q.type === 'old' ? '<span class="badge warn">📁 Old machine</span> ' : '📝 '}⚙️ ${esc(q.model)} × ${q.qty}${q.note ? ' · ' + esc(q.note) : ''} · sent ${esc(fmtTime(q.createdAt))}</div>
        ${q.type === 'old' ? `<div class="small muted">Assembled ${esc(fmtTime(q.startedAt))} → ${esc(fmtTime(q.completedAt))}${q.installerName ? ' · Installation: ' + esc(q.installerName) : ''}${q.helperName ? ' · Helper: ' + esc(q.helperName) : ''}</div>` : ''}</div>
        <div class="spacer"></div><input type="number" min="1" max="20" value="${q.qty}" data-req-qty="${esc(q.id)}" style="width:70px" title="Quantity to give">
        <button class="small primary" data-req-ok="${esc(q.id)}">Approve</button><button class="small danger" data-req-no="${esc(q.id)}">Reject</button></div>`).join('')}</div>` : ''}
    <div id="asm-board"></div>
    <div class="row no-print" style="margin-bottom:-6px"><div class="spacer"></div><button class="small" id="add-stock">📦 Add old stock</button></div>
    ${godownHtml(r.stock, true)}
    <div id="adm-dsp-board"></div>
    <div class="card section"><div class="row"><h2 style="margin:0">🚚 Dispatch logins</h2><div class="spacer"></div><button class="small primary" id="dsp-add">+ Add dispatch login</button></div>
      <div class="small muted">They log in with the 🚚 Dispatch button, see every unit's godown stock and send machines to another unit or to a client.</div>
      ${r.dispatchers.length ? r.dispatchers.map((d) => `<div class="drv"><div class="who-line"><b>${esc(d.name)}</b> <code>${esc(d.username)}</code>${d.active ? '' : ' <span class="badge">inactive</span>'}</div>
        <div class="sub-line small"><button class="link small" data-dsp-pw="${esc(d.id)}">Change password</button><button class="link small" data-dsp-toggle="${esc(d.id)}">${d.active ? 'Make inactive' : 'Make active'}</button><button class="link small danger" data-dsp-del="${esc(d.id)}">Remove</button></div></div>`).join('') : '<div class="small muted" style="margin-top:6px">No dispatch login yet.</div>'}</div>
    <div class="row section" style="margin-top:16px"><h2 style="margin:0">Machines</h2><div class="spacer"></div>
      <select id="af-unit" style="width:auto">${opt('', 'All units', f.unit)}${A().units.map((u) => opt(u.id, esc(u.name), f.unit)).join('')}</select>
      <select id="af-status" style="width:auto">${opt('open', 'Not assembled yet', f.status)}${opt('waiting', 'Waiting for leader', f.status)}${opt('done', 'Assembled (30 days)', f.status)}${opt('all', 'All', f.status)}</select></div>
    ${asmSummary(items, true)}
    ${items.length ? asmGrouped(items, 'admin') : '<div class="card muted">No machines.</div>'}
    <form class="card section" id="asm-set" style="margin-top:16px"><h2>Assembly settings</h2>
      <div class="form-grid">
        <div><label>Max pending per team leader</label><input name="maxPending" type="number" min="1" max="50" value="${esc(s.maxPending)}"></div>
        <div><label>Max pending per installation person</label><input name="maxInstallerPending" type="number" min="1" max="50" value="${esc(s.maxInstallerPending || 10)}"></div>
        <div><label>Deduction per diverted machine ₹</label><input name="divertPenalty" type="number" min="0" value="${esc(s.divertPenalty ?? 100)}"></div>
      </div>
      <h3 style="margin-top:12px">🛠️ Assembly incentive per model</h3><div class="muted small">Paid when the machine is assembled: Leader ₹ to the team leader, Install ₹ to the installation person. Only the exact model names in this list can be entered and get incentive. The amount is fixed on each machine when it is assembled.</div>
      <div id="inc-rows"></div><button type="button" class="link" id="inc-add">+ Add model</button>
      <h3 style="margin-top:18px">🚚 Dispatch incentive per model</h3><div class="muted small">Paid to the dispatch person (Dispatch login) for each machine sent to a <b>client</b>. Machines sent to other units count for the monthly bonus below. Only exact model names in this list get dispatch incentive.</div>
      <div id="dinc-rows"></div><div class="row"><button type="button" class="link" id="dinc-add">+ Add model</button><button type="button" class="link" id="dinc-all">⧉ Add all assembly models at one rate</button></div>
      <h3 style="margin-top:18px">🔁 Monthly bonus for godown transfer</h3><div class="muted small">Paid once a month to the dispatch person, by how many machines they sent to the unit(s) ticked below that month. Transfers to other units do not count. Not shown to team leaders or units.</div>
      <label>Bonus only for transfers to</label><div class="row">${A().units.filter((u) => u.active).map((u) => `<label class="check"><input type="checkbox" class="uds-unit" value="${esc(u.id)}" ${(r.bonusUnits || []).includes(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div>
      <div class="table-wrap"><table id="uds-rows"><thead><tr><th>From machine no.</th><th>Bonus ₹ for the month</th></tr></thead><tbody>${(s.unitDispatchSlabs || []).concat([{ from: '', amount: '' }]).map((x, i, all) => `<tr><td><input class="uds-f" type="number" min="1" value="${esc(x.from)}" placeholder="e.g. 41"></td><td><input class="uds-a" type="number" min="0" value="${esc(x.amount)}"></td></tr><tr><td colspan="2" class="small muted" style="padding-top:0">${x.from !== '' ? `${x.from}${all[i + 1] && all[i + 1].from !== '' ? `–${all[i + 1].from - 1}` : '+'} machines → ₹${x.amount}` : 'add a new slab (leave empty if not needed)'}</td></tr>`).join('')}</tbody></table></div>
      <datalist id="asm-models2">${(await loadMachineList()).map((m) => `<option value="${esc(typeof m === 'string' ? m : m.label)}"></option>`).join('')}</datalist>
      <div style="margin-top:12px"><button class="primary">Save settings</button></div></form>`;
  document.getElementById('asm-add').onclick = () => asmAddForm('/admin', renderAdmin);
  main.querySelectorAll('[data-add-leader]').forEach((b) => (b.onclick = () => personForm(null, b.dataset.addLeader, 'leader')));
  main.querySelectorAll('[data-edit-leader]').forEach((b) => (b.onclick = () => personForm(A().people.find((p) => p.id === b.dataset.editLeader))));
  main.querySelectorAll('[data-del-leader]').forEach((b) => (b.onclick = async () => {
    const p = A().people.find((x) => x.id === b.dataset.delLeader);
    if (!confirm(`Remove team leader ${p.name}? Their unfinished machines go to the other team leaders of the unit. Finished work and incentive stay in the records.`)) return;
    try { await api(`/admin/people/${p.id}`, { method: 'DELETE' }); toast('Team leader removed – machines shared again'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  }));
  document.getElementById('af-unit').onchange = (e) => { state.asmFilter = { ...f, unit: e.target.value }; adminAssembly(main); };
  document.getElementById('af-status').onchange = (e) => { state.asmFilter = { ...f, status: e.target.value }; adminAssembly(main); };
  bindAsm(main, '/admin/assembly', r.items, renderAdmin);
  bindSend(main, '/admin/godown/send', A().units.filter((u) => u.active), renderAdmin);
  document.getElementById('add-stock').onclick = () => oldStockForm('/admin/godown/stock', A().units.filter((u) => u.active), renderAdmin);
  api('/dispatch/board').then((b) => { const box = document.getElementById('adm-dsp-board'); if (box) box.innerHTML = dispatchBoardHtml(b.board, monthNow(), false); });
  document.getElementById('dsp-add').onclick = () => openModal(`<h2>+ Dispatch login</h2>
      <label>Name *</label><input name="name" required>
      <div class="form-grid"><div><label>Login ID *</label><input name="username" autocapitalize="none" required placeholder="e.g. dispatch1"></div><div><label>Password *</label><input name="password" required></div></div>
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Add</button></div>`,
    async (fd) => { await api('/admin/dispatchers', { method: 'POST', body: Object.fromEntries(fd) }); toast('Dispatch login added'); renderAdmin(); });
  const dsp = (id) => r.dispatchers.find((d) => d.id === id);
  main.querySelectorAll('[data-dsp-pw]').forEach((b) => (b.onclick = async () => {
    const pw = prompt(`New password for ${dsp(b.dataset.dspPw).name}:`, '');
    if (!pw) return;
    try { await api(`/admin/dispatchers/${b.dataset.dspPw}`, { method: 'PUT', body: { password: pw } }); toast('Password changed'); } catch (ex) { toast(ex.message, true); }
  }));
  main.querySelectorAll('[data-dsp-toggle]').forEach((b) => (b.onclick = async () => {
    try { await api(`/admin/dispatchers/${b.dataset.dspToggle}`, { method: 'PUT', body: { active: !dsp(b.dataset.dspToggle).active } }); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  }));
  main.querySelectorAll('[data-dsp-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm(`Remove dispatch login ${dsp(b.dataset.dspDel).name}?`)) return;
    try { await api(`/admin/dispatchers/${b.dataset.dspDel}`, { method: 'DELETE' }); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  }));
  main.querySelectorAll('[data-req-ok]').forEach((b) => (b.onclick = async () => {
    const qty = main.querySelector(`[data-req-qty="${b.dataset.reqOk}"]`).value;
    try { await api(`/admin/assembly/requests/${b.dataset.reqOk}/approve`, { method: 'POST', body: { qty } }); toast('Approved – machines given'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  }));
  main.querySelectorAll('[data-req-no]').forEach((b) => (b.onclick = async () => {
    const reason = prompt('Reason (optional):', '');
    if (reason === null) return;
    try { await api(`/admin/assembly/requests/${b.dataset.reqNo}/reject`, { method: 'POST', body: { reason } }); toast('Rejected'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  }));
  // incentive rows
  const rows = document.getElementById('inc-rows');
  const addRow = (x, after) => {
    const html = `<div class="row inc-row" style="margin-top:6px;flex-wrap:nowrap"><input class="ir-m" list="asm-models2" placeholder="Model no." value="${esc(x.model)}" style="flex:1"><span>Leader ₹</span><input class="ir-l" type="number" min="0" value="${esc(x.leader)}" style="width:80px"><span>Install ₹</span><input class="ir-i" type="number" min="0" value="${esc(x.installer)}" style="width:80px">${x.addedBy ? `<span class="badge manual" title="${esc(fmtTime(x.addedAt))}">by ${esc(x.addedBy)}</span>` : ''}<button type="button" class="link small ir-copy" title="Copy these rates to a new row">⧉ Copy</button><button type="button" class="link danger ir-del">✕</button></div>`;
    if (after) after.insertAdjacentHTML('afterend', html); else rows.insertAdjacentHTML('beforeend', html);
    const el = after ? after.nextElementSibling : rows.lastElementChild;
    el.querySelector('.ir-del').onclick = () => el.remove();
    // same rates, new model: pick the model in the new row
    el.querySelector('.ir-copy').onclick = () => {
      const n = addRow({ model: '', leader: el.querySelector('.ir-l').value, installer: el.querySelector('.ir-i').value }, el);
      n.querySelector('.ir-m').focus();
    };
    return el;
  };
  (s.incentives || []).forEach((x) => addRow(x));
  document.getElementById('inc-add').onclick = () => addRow({ model: '', leader: '', installer: '' });
  // dispatch incentive rows (own list)
  const drows = document.getElementById('dinc-rows');
  const addDRow = (x, after) => {
    const html = `<div class="row dinc-row" style="margin-top:6px;flex-wrap:nowrap"><input class="dr-m" list="asm-models2" placeholder="Model no." value="${esc(x.model)}" style="flex:1"><span>Dispatch ₹</span><input class="dr-a" type="number" min="0" value="${esc(x.amount)}" style="width:90px">${x.addedBy ? `<span class="badge manual" title="${esc(fmtTime(x.addedAt))}">by ${esc(x.addedBy)}</span>` : ''}<button type="button" class="link small dr-copy" title="Copy this rate to a new row">⧉ Copy</button><button type="button" class="link danger dr-del">✕</button></div>`;
    if (after) after.insertAdjacentHTML('afterend', html); else drows.insertAdjacentHTML('beforeend', html);
    const el = after ? after.nextElementSibling : drows.lastElementChild;
    el.querySelector('.dr-del').onclick = () => el.remove();
    el.querySelector('.dr-copy').onclick = () => { const n = addDRow({ model: '', amount: el.querySelector('.dr-a').value }, el); n.querySelector('.dr-m').focus(); };
    return el;
  };
  // Every model of the assembly list (not yet in the dispatch list) at one rate.
  document.getElementById('dinc-all').onclick = () => {
    const amount = prompt('Dispatch ₹ for all models of the assembly list that are not in the dispatch list yet:', '');
    if (amount === null || amount === '' || isNaN(Number(amount))) return;
    const have = new Set([...drows.querySelectorAll('.dr-m')].map((i) => i.value.trim().toUpperCase()).filter(Boolean));
    let n = 0;
    for (const i of rows.querySelectorAll('.ir-m')) {
      const m = i.value.trim();
      if (m && !have.has(m.toUpperCase())) { addDRow({ model: m, amount }); have.add(m.toUpperCase()); n++; }
    }
    toast(n ? `${n} model(s) added at ₹${amount} – press Save settings` : 'All assembly models are already in the dispatch list');
  };
  (s.dispatchIncentives || []).forEach((x) => addDRow(x));
  document.getElementById('dinc-add').onclick = () => addDRow({ model: '', amount: '' });
  const form = document.getElementById('asm-set');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    body.unitDispatchUnits = [...document.querySelectorAll('.uds-unit:checked')].map((c) => c.value);
    body.unitDispatchSlabs = [...document.querySelectorAll('#uds-rows tbody tr')].filter((tr) => tr.querySelector('.uds-f')).map((tr) => ({ from: tr.querySelector('.uds-f').value, amount: tr.querySelector('.uds-a').value })).filter((x) => String(x.from).trim() !== '');
    body.dispatchIncentives = [...drows.querySelectorAll('.dinc-row')].map((el) => ({ model: el.querySelector('.dr-m').value, amount: el.querySelector('.dr-a').value })).filter((x) => x.model.trim());
    body.incentives = [...rows.querySelectorAll('.inc-row')].map((el) => ({ model: el.querySelector('.ir-m').value, leader: el.querySelector('.ir-l').value, installer: el.querySelector('.ir-i').value })).filter((x) => x.model.trim());
    try { await api('/admin/assembly/settings', { method: 'PUT', body }); toast('Assembly settings saved'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  };
  document.getElementById('asm-stock').onclick = () => oldStockForm('/admin/godown/stock', A().units.filter((u) => u.active), renderAdmin);
  document.getElementById('asm-old').onclick = async () => {
    const ppl = A().people.filter((p) => p.active || true);
    const sel = (name, roles, label) => `<label>${label}</label><select name="${name}"><option value="">— none —</option>${ppl.filter((p) => roles.includes(p.role)).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.unitName || '—')})</option>`).join('')}</select>`;
    const models = await loadMachineList();
    openModal(`<h2>📁 Add old machine (missed earlier)</h2><p class="small">Added as already assembled, with its times. It counts in the scoreboard and incentive of that month.</p>
      <label>Unit *</label><select name="unitId">${A().units.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select>
      <div class="form-grid"><div><label>⚙️ Model no. *</label><input name="model" list="asm-models3" required></div><div><label>Quantity</label><input name="qty" type="number" min="1" max="50" value="1"></div></div>
      <datalist id="asm-models3">${models.map((m) => `<option value="${esc(typeof m === 'string' ? m : m.label)}"></option>`).join('')}</datalist>
      ${sel('leaderId', ['leader'], '👷 Team leader *')}${sel('installerId', ['installer', 'both'], '🔧 Installation person')}${sel('helperId', ['helper', 'both'], '🧰 Helper')}
      ${asmTimesForm({}, '', true)}
      ${asmLocationFields()}
      <label>Note</label><input name="note" placeholder="optional">
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Add</button></div>`,
    async (fd) => { await api('/admin/assembly/old', { method: 'POST', body: { ...Object.fromEntries(fd), ...asmTimesValue(), ...locationValue() } }); toast('Old machine added'); renderAdmin(); });
    bindLocation();
  };
  await drawBoard(state.asmMonth || monthNow(), s.maxPending, renderAdmin);
}

// ---------- godown stock & dispatch ----------
// Party (client) search box, filled from the Google Sheet party list.
function clientSearch(input, list) {
  let timer = null;
  let found = [];
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      try { found = (await api('/lookup/clients?q=' + encodeURIComponent(q))).clients; } catch { found = []; }
      list.innerHTML = found.length ? found.map((c, i) => `<button type="button" data-i="${i}"><b>${esc(c.name)}</b><span class="small muted">${esc([c.city, c.phone].filter(Boolean).join(' · '))}</span></button>`).join('') : '<div class="small muted" style="padding:8px">Not in the party list – type the name.</div>';
      list.hidden = false;
      list.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => { input.value = found[Number(b.dataset.i)].name; list.hidden = true; }));
    }, 200);
  };
  input.onblur = () => setTimeout(() => (list.hidden = true), 200);
}

// Copy / WhatsApp buttons for any text (handled once, for the whole page).
function shareButtons(text) {
  state.shareTexts = state.shareTexts || {};
  const id = 's' + Math.random().toString(36).slice(2, 10);
  state.shareTexts[id] = text;
  return `<button type="button" class="link small" data-share-copy="${id}">📋 Copy</button><button type="button" class="link small" data-share-wa="${id}">📤 WhatsApp</button>`;
}
document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-share-copy]');
  const w = e.target.closest('[data-share-wa]');
  if (c) {
    const text = (state.shareTexts || {})[c.dataset.shareCopy] || '';
    try { await navigator.clipboard.writeText(text); toast('Copied – paste in WhatsApp'); } catch { prompt('Copy this text:', text); }
  } else if (w) window.open('https://wa.me/?text=' + encodeURIComponent((state.shareTexts || {})[w.dataset.shareWa] || ''), '_blank');
});

function godownText(units) {
  const day = fmtDate(state.today || new Date().toISOString().slice(0, 10));
  const total = units.reduce((n, u) => n + u.total, 0);
  const lines = [units.length === 1 ? `*🏬 ${units[0].unitName} – Godown stock ${day}*` : `*🏬 Godown stock ${day}*`, `Total: ${total} machine${total === 1 ? '' : 's'}`];
  for (const u of units) {
    if (units.length > 1) lines.push('', `*${u.unitName}* (${u.total})`);
    else lines.push('');
    for (const m of u.models) lines.push(`• ${m.model} × ${m.qty}${(m.booked || []).length ? ` (booked: ${m.booked.map((x) => `${x.party} ${x.qty}`).join(', ')})` : ''}`);
  }
  return lines.join('\n');
}

function godownHtml(stock, canSend, title = '🏬 Godown stock') {
  const total = stock.reduce((n, u) => n + u.total, 0);
  // One full-width list: a heading per unit, one line per model (qty, oldest, Send).
  return `<div class="section"><div class="row"><h2 style="margin:0">${title}</h2><div class="spacer"></div><span class="badge w4">${total} machine${total === 1 ? '' : 's'} in godown</span>${stock.length > 1 ? shareButtons(godownText(stock)) : ''}</div>
    ${stock.length ? stock.map((u) => `<div class="done-list asm-group" style="margin-top:8px"><div class="dl-head row"><span><b>🏬 ${esc(u.unitName)}</b> <span class="muted">· ${u.total} machine${u.total === 1 ? '' : 's'}</span></span><span class="spacer"></span>${shareButtons(godownText([u]))}</div>
      ${u.models.map((m) => `<div class="godown-row"><span class="dr-main"><b>${esc(m.model)}</b>${m.noRate ? NORATE : ''}<span class="small muted">oldest ${esc(ageText(m.oldest))}${m.oldStock ? ` · 📦 ${m.oldStock} old stock` : ''}</span>${(m.entries || []).length ? `<span class="small muted">${m.entries.map((x) => `${esc(x.text)}${x.at ? ` · <span class="nowrap">🕒 ${esc(fmtTime(x.at + ':00Z'))}</span>` : ''}${m.entries.length > 1 || x.qty > 1 ? ` × ${x.qty}` : ''}`).join('<br>')}</span>` : ''}${(m.booked || []).length ? `<span class="small">${m.booked.map((x) => `<span class="badge warn">👤 booked: ${esc(x.party)} × ${x.qty}</span>`).join(' ')}</span>` : ''}</span>
        <span class="godown-qty">${m.qty}</span>${(() => { const n = !state.me ? 0 : state.me.role === 'admin' ? m.qty : (m.creators || []).filter((c) => c.role === state.me.role && c.id === state.me.id).reduce((t, c) => t + c.qty, 0); return n ? `<button class="small nowrap" data-stock-edit="${esc(u.unitId)}|${esc(m.model)}|${n}" data-entries="${esc(JSON.stringify(m.entries || []))}" title="Correct the model no. or remove extra old stock">✎ Correct</button>` : ''; })()}${canSend ? `<button class="small primary nowrap" data-send="${esc(u.unitId)}|${esc(m.model)}|${m.qty}" data-booked="${esc(JSON.stringify(m.booked || []))}">🚚 Send</button>` : ''}</div>`).join('')}</div>`).join('')
    : '<div class="card muted" style="margin-top:8px">No machine in the godown.</div>'}</div>`;
}

// ✎ Model on an old-stock line: correct a wrong model no. (works wherever the godown list is shown).
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-stock-edit]');
  if (!b) return;
  const [unitId, from, n] = b.dataset.stockEdit.split('|');
  let entries = [];
  try { entries = JSON.parse(b.dataset.entries || '[]'); } catch { entries = []; }
  const models = await loadMachineList();
  // more than one kind of entry on this line: say which ones are wrong
  const whichHtml = entries.length > 1 ? `<label>Which ones? *</label><div class="pick-list">${entries.map((x, i) => `<label class="check"><input type="radio" name="entry" value="${i}"> ${esc(x.text)}${x.at ? ` · 🕒 ${esc(fmtTime(x.at + ':00Z'))}` : ''} – ${x.qty}</label>`).join('')}</div>` : '';
  openModal(`<h2>✎ Correct entry</h2><div class="muted small">In the godown as <b>${esc(from)}</b> (${n} machine${n === '1' ? '' : 's'}).</div>
    ${whichHtml}
    <label>What is wrong? *</label>
    <div class="row"><label class="check"><input type="radio" name="act" value="model" checked> ✎ Wrong model no.</label><label class="check"><input type="radio" name="act" value="remove"> ➖ ${state.me && state.me.role === 'admin' ? 'Entered by mistake – remove from godown' : 'Too many entered (old stock) – remove extra'}</label></div>
    <div id="ce-model"><label>Correct model no. *</label><input name="model" list="asm-models-gs" placeholder="type and pick from the list"></div>
    <div id="ce-remove" hidden><label>Why? *</label><input name="reason" placeholder="e.g. entered 4, only 3 in godown"></div>
    <datalist id="asm-models-gs">${models.map((x) => `<option value="${esc(typeof x === 'string' ? x : x.label)}"></option>`).join('')}</datalist>
    <label id="ce-qty-label">How many to change</label><input name="qty" type="number" min="1" max="${esc(n)}" value="${esc(n)}">
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
  async (fd) => {
    if (entries.length > 1 && fd.get('entry') === null) throw new Error('Choose which ones to change');
    const entry = entries.length > 1 ? entries[Number(fd.get('entry'))] : null;
    if (entry && Number(fd.get('qty')) > entry.qty) throw new Error(`Only ${entry.qty} in that group`);
    const where = { unitId, from, qty: fd.get('qty'), entry: entry ? entry.text : '', entryAt: entry ? entry.at : '' };
    if (fd.get('act') === 'remove') {
      if (!String(fd.get('reason') || '').trim()) throw new Error('Write why they are removed');
      if (!confirm(`Remove ${fd.get('qty')} × ${from} from the godown?`)) return;
      const r = await api('/godown/remove', { method: 'POST', body: { ...where, reason: fd.get('reason') } });
      toast(`${r.removed} removed from the godown`);
    } else {
      if (!String(fd.get('model') || '').trim()) throw new Error('Enter the correct model no.');
      const r = await api('/godown/edit-model', { method: 'POST', body: { ...where, model: fd.get('model') } });
      toast(`${r.changed} changed to ${fd.get('model')}`);
    }
    render();
  });
  modalBody.querySelectorAll('[name=act]').forEach((r) => (r.onchange = () => {
    const rm = modalBody.querySelector('[name=act]:checked').value === 'remove';
    document.getElementById('ce-model').hidden = rm;
    document.getElementById('ce-remove').hidden = !rm;
    document.getElementById('ce-qty-label').textContent = rm ? 'How many to remove' : 'How many to change';
    const q = modalBody.querySelector('[name=qty]'); if (rm) q.value = 1;
  }));
  modalBody.querySelectorAll('[name=entry]').forEach((r) => (r.onchange = () => { const q = modalBody.querySelector('[name=qty]'); const e = entries[Number(r.value)]; q.max = e.qty; q.value = e.qty; }));
});

function historyHtml(history) {
  if (!history || !history.length) return '';
  return `<div class="card section"><h2>Recent dispatches (30 days)</h2><div class="table-wrap"><table><thead><tr><th>When</th><th>Model no.</th><th class="num">Qty</th><th>From</th><th>To</th><th>By</th><th>Photo</th><th class="num">Dispatch incentive</th></tr></thead><tbody>
    ${history.map((h) => `<tr><td class="small">${esc(fmtTime(h.at))}</td><td>${esc(h.model)}</td><td class="num"><b>${h.qty}</b></td><td>${esc(h.from)}</td><td>${h.kind === 'client' ? '👤 ' : '🏬 '}${esc(h.to)}${h.booked ? `<div class="small"><span class="badge warn">👤 booked: ${esc(h.booked)}</span></div>` : ''}</td><td class="small">${esc(h.by)}</td><td>${h.photo ? `<a href="/api/photos/${esc(h.photo)}" target="_blank" rel="noopener"><img src="/api/photos/${esc(h.photo)}" alt="dispatch photo" style="width:44px;height:44px;object-fit:cover;border-radius:6px"></a>` : '<span class="muted small">—</span>'}</td><td class="num">${h.kind === 'client' ? (h.incentive ? `₹${h.incentive}` : '—') : '<span class="muted">– unit transfer</span>'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// Send machines from a unit's godown to another unit or to a client.
function bindSend(root, url, units, reload) {
  root.querySelectorAll('[data-send]').forEach((b) => (b.onclick = () => {
    const [unitId, model, max] = b.dataset.send.split('|');
    const from = units.find((u) => u.id === unitId) || { name: '' };
    let booked = [];
    try { booked = JSON.parse(b.dataset.booked || '[]'); } catch { booked = []; }
    const free = Number(max) - booked.reduce((n, x) => n + x.qty, 0);
    // Some machines of this model are booked: ask which ones are going (the booking moves with them).
    const pickHtml = booked.length ? `<label>Which machines? *</label><div class="pick-list">
        ${free > 0 ? `<label class="check"><input type="radio" name="pick" value="free"> 🏬 Free stock (not booked) – ${free}</label>` : ''}
        ${booked.map((x) => `<label class="check"><input type="radio" name="pick" value="${esc(x.party)}"> 👤 Booked: <b>${esc(x.party)}</b> – ${x.qty}</label>`).join('')}</div>
      <div class="small muted">Sending to another unit: the booking goes with the machine to that godown.</div>` : '';
    openModal(`<h2>🚚 Send from godown</h2><div class="muted">${esc(from.name)} · ⚙️ ${esc(model)} · ${max} in godown</div>
      ${pickHtml}
      <label>Quantity *</label><input name="qty" type="number" min="1" max="${max}" value="1" required>
      <label>Send to *</label>
      <div class="row"><label class="check"><input type="radio" name="to" value="client" checked> 👤 Client (dispatch)</label><label class="check"><input type="radio" name="to" value="unit"> 🏬 Another unit</label></div>
      <div id="s-client" class="lookup"><label>Client name *</label><input name="party" id="s-party" autocomplete="off" placeholder="type party name to search"><div id="s-party-list" class="lookup-list" hidden></div>
        <div class="small muted">You get the dispatch incentive for each machine sent to a client.</div></div>
      <div id="s-unit" hidden><label>Unit *</label><select name="toUnitId"><option value="">— choose —</option>${units.filter((u) => u.id !== unitId).map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select>
        <div class="small muted">Moves to that unit's godown (a booked machine stays booked for its client).</div></div>
      <label>📷 Dispatch photo ${url.startsWith('/admin') ? '(optional for admin)' : '*'}</label>
      <div class="muted small">Photo of the machine loaded in the vehicle / challan.</div>
      <div id="s-photos"></div>
      <label>Note</label><input name="note" placeholder="optional (e.g. vehicle no., invoice no.)">
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Send</button></div>`,
    async (fd) => {
      const body = { ...Object.fromEntries(fd), fromUnitId: unitId, model, photos: getPhotos() };
      if (booked.length && !body.pick) throw new Error('Choose which machines you are sending: free stock or booked for a client');
      const groupMax = !body.pick ? Number(max) : body.pick === 'free' ? free : (booked.find((x) => x.party === body.pick) || {}).qty || 0;
      if (Number(body.qty) > groupMax) throw new Error(`Only ${groupMax} of those in the godown`);
      if (!body.photos.length && !url.startsWith('/admin')) throw new Error('Take a dispatch photo first');
      if (body.to === 'client' && !String(body.party || '').trim()) throw new Error('Client name is compulsory');
      if (body.to === 'unit' && !body.toUnitId) throw new Error('Choose the unit');
      const r = await api(url, { method: 'POST', body });
      toast(body.to === 'client' ? `Dispatched ${body.qty} to ${body.party}` : `Sent ${body.qty} to the other unit`);
      reload();
    });
    clientSearch(document.getElementById('s-party'), document.getElementById('s-party-list'));
    const getPhotos = photoPicker(document.getElementById('s-photos'));
    // booked machine going to a client: fill in that client's name
    modalBody.querySelectorAll('[name=pick]').forEach((r) => (r.onchange = () => {
      const p = modalBody.querySelector('[name=pick]:checked').value;
      const q = modalBody.querySelector('[name=qty]');
      const n = p === 'free' ? free : (booked.find((x) => x.party === p) || {}).qty || 1;
      q.max = n; if (Number(q.value) > n) q.value = n;
      if (p !== 'free') document.getElementById('s-party').value = p;
    }));
    modalBody.querySelectorAll('[name=to]').forEach((r) => (r.onchange = () => {
      const c = modalBody.querySelector('[name=to]:checked').value === 'client';
      document.getElementById('s-client').hidden = !c;
      document.getElementById('s-unit').hidden = c;
    }));
  }));
}

function dispatchBoardHtml(board, month, picker) {
  const sum = (k) => board.reduce((t, x) => t + (x[k] || 0), 0);
  return `<div class="card section"><div class="row"><h2 style="margin:0">🏆 Dispatch scoreboard</h2><div class="spacer"></div>${picker ? `<input type="month" id="dsp-month" value="${esc(month)}" style="width:auto">` : `<span class="badge">${esc(month)}</span>`}</div>
    ${board.length ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>#</th><th>Dispatch person</th><th class="num">To clients</th><th class="num">Client incentive</th><th class="num">To other units</th><th class="num">Other unit incentive</th><th class="num">Total incentive</th></tr></thead><tbody>
    ${board.map((x, i) => `<tr><td>${i < 3 && x.toClient ? ['🥇', '🥈', '🥉'][i] : i + 1}</td><td><b>${esc(x.name)}</b></td><td class="num">${x.toClient}</td><td class="num">₹${x.clientIncentive || 0}</td><td class="num">${x.toUnit}</td><td class="num">₹${x.unitBonus || 0}</td><td class="num"><b>₹${x.incentive}</b></td></tr>`).join('')}
    <tr><td></td><td><b>Total</b></td><td class="num"><b>${sum('toClient')}</b></td><td class="num"><b>₹${sum('clientIncentive')}</b></td><td class="num"><b>${sum('toUnit')}</b></td><td class="num"><b>₹${sum('unitBonus')}</b></td><td class="num"><b>₹${sum('incentive')}</b></td></tr></tbody></table></div>` : '<p class="muted">No dispatch logins yet.</p>'}</div>`;
}

// Old stock already in a unit's godown, entered before dispatching it.
// godownOnly: units add plain godown stock only (no "Booked for a client").
async function oldStockForm(url, units, reload, godownOnly) {
  const models = await loadMachineList();
  openModal(`<h2>📦 Add old stock</h2><p class="small">Machines already lying in a unit's godown. They are added to the godown stock and can then be sent. No assembly incentive; the dispatch incentive applies when sent to a client.</p>
    <label>Unit *</label><select name="unitId" required>${units.length === 1 ? '' : '<option value="">— choose —</option>'}${units.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('')}</select>
    ${godownOnly ? '<input type="hidden" name="kind" value="godown">' : `<label>Stock type *</label>
    <div class="row"><label class="check"><input type="radio" name="kind" value="godown"> 🏬 Godown stock</label><label class="check"><input type="radio" name="kind" value="party"> 👤 Booked for a client</label></div>`}
    <div id="os-party-wrap" class="lookup" hidden><label>Client (party) name *</label><input name="party" id="os-party" autocomplete="off" placeholder="type party name to search"><div id="os-party-list" class="lookup-list" hidden></div></div>
    <div class="form-grid"><div><label>⚙️ Model no. *</label><input name="model" list="os-models" required></div><div><label>Quantity *</label><input name="qty" type="number" min="1" max="200" value="1" required></div></div>
    <datalist id="os-models">${models.map((x) => `<option value="${esc(typeof x === 'string' ? x : x.label)}"></option>`).join('')}</datalist>
    <label>Note</label><input name="note" placeholder="optional (e.g. stock count 9 Nov)">
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Add to godown</button></div>`,
  async (fd) => {
    if (!fd.get('kind')) throw new Error('Choose: Godown stock or Booked for a client');
    if (fd.get('kind') === 'party' && !String(fd.get('party') || '').trim()) throw new Error('Client (party) name is compulsory');
    await api(url, { method: 'POST', body: Object.fromEntries(fd) });
    toast(`${fd.get('qty')} added to godown`);
    reload();
  });
  clientSearch(document.getElementById('os-party'), document.getElementById('os-party-list'));
  modalBody.querySelectorAll('[name=kind]').forEach((r) => (r.onchange = () => { document.getElementById('os-party-wrap').hidden = modalBody.querySelector('[name=kind]:checked').value !== 'party'; }));
}

async function renderDispatch() {
  $app.innerHTML = topbar('🚚 Dispatch: ' + state.me.name) + '<div class="wrap"><div class="loading">Loading…</div></div>';
  bindLogout();
  const r = await api('/dispatch/home' + (state.dspMonth ? '?month=' + state.dspMonth : ''));
  const wrap = $app.querySelector('.wrap');
  wrap.innerHTML = `<div class="hero"><div class="label">🏆 My dispatch · ${esc(r.month)}</div>
      <div class="big">₹${r.me.incentive} incentive</div>
      <div class="line">🚚 ${r.me.toClient} machine${r.me.toClient === 1 ? '' : 's'} dispatched to clients: <b>₹${r.me.clientIncentive}</b></div>
      <div class="line">🔁 ${r.me.toBonusUnit} sent to ${esc((r.bonusUnitNames || []).join(' / ') || 'the bonus unit')}: <b>₹${r.me.unitBonus}</b> transfer bonus${r.me.toUnit > r.me.toBonusUnit ? ` <span class="small">(${r.me.toUnit - r.me.toBonusUnit} sent to other units – no bonus)</span>` : ''}</div></div>
    <div class="row no-print" style="margin-bottom:-6px"><div class="spacer"></div><button class="small" id="add-stock">📦 Add old stock</button></div>
    ${godownHtml(r.stock, true)}${dispatchBoardHtml(r.board, r.month, true)}${historyHtml(r.history)}`;
  document.getElementById('add-stock').onclick = () => oldStockForm('/dispatch/stock', r.units, renderDispatch);
  const mi = document.getElementById('dsp-month');
  if (mi) mi.onchange = (e) => { state.dspMonth = e.target.value; renderDispatch(); };
  bindSend(wrap, '/dispatch/send', r.units, renderDispatch);
}

boot();
