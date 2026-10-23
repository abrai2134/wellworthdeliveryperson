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
  if (d.helpersNeeded) parts.push(`${d.helpersNeeded} helper${d.helpersNeeded > 1 ? 's' : ''}`);
  if (d.installation) parts.push('installation person');
  return parts.join(' + ');
}
function placeName(t) {
  if (t.extra) return 'Emergency';
  return t.role === 'installer' ? 'Installation' : `Helper ${t.slot + 1}`;
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
// who: 'admin' | 'unit' | 'staff'
function deliveryCard(d, who, today) {
  const past = d.date < today;
  const canEdit = (who === 'admin' || who === 'unit') && !past && d.status !== 'cancelled';
  const team = d.team.map((t) => {
    const p = t.person;
    const tags = [
      t.extra ? '<span class="badge warn">Emergency</span>' : '',
      p && p.backup ? '<span class="badge bad">Backup person</span>' : '',
      t.manual && !t.extra ? '<span class="badge manual">changed</span>' : '',
      t.fromUnit ? `<span class="small muted">moved from ${esc(t.fromUnit)}</span>` : '',
      t.reason ? `<span class="small muted">${esc(t.reason)}</span>` : '',
    ].join(' ');
    const actions = !canEdit ? '' : [
      who === 'admin' && !t.extra ? `<button class="link small" data-change="${esc(d.id)}|${t.role}|${t.slot}">Change</button>` : '',
      p ? `<button class="link small" data-replace="${esc(d.id)}|${esc(p.id)}|${esc(p.name)}">${t.extra ? 'Remove' : 'Absent – replace'}</button>` : '',
    ].join('');
    return `<div class="drv"><div class="row"><span class="small muted" style="width:86px">${esc(placeName(t))}</span>
      ${p ? `<b>${esc(p.name)}</b> ${roleBadge(p.role)} ${p.unitName ? `<span class="small muted">(${esc(p.unitName)})</span>` : ''} ${tags}` : `<span class="empty">Nobody free – ${t.role === 'installer' ? 'installation person' : 'helper'} needed</span>`}</div>
      <div class="row small" style="margin-left:92px">${p ? telLink(p.phone) : ''} ${actions}</div></div>`;
  }).join('');
  const lost = d.lost.length ? `<div class="badge bad" style="margin-top:8px;white-space:normal">⚠ ${d.lost.map((l) => `${esc(l.person)} was taken by ${esc(l.unit)} for an emergency`).join('; ')}</div>` : '';
  const head = `<div class="row"><div><div class="name">${who === 'admin' || who === 'staff' ? esc(d.unitName) + ' · ' : ''}${esc(SESSION_NAMES[d.session])}</div>
      <div class="small muted">${esc(fmtDate(d.date))} · needs ${esc(needText(d))}</div></div><div class="spacer"></div>
      ${d.status === 'cancelled' ? '<span class="badge">Cancelled</span>' : d.open ? `<span class="badge bad">${d.open} open</span>` : '<span class="badge ok">Team ready</span>'}</div>`;
  const info = [
    d.customer ? `👤 <b>${esc(d.customer)}</b> ${telLink(d.customerPhone)}` : d.customerPhone ? `📞 ${telLink(d.customerPhone)}` : '',
    d.machine ? `⚙️ ${esc(d.machine)}` : '',
    d.address ? `📍 ${esc(d.address)} · <a target="_blank" rel="noopener" href="${mapLink(d.address)}">Map</a>` : '',
    d.notes ? `📝 ${esc(d.notes)}` : '',
  ].filter(Boolean).map((x) => `<div class="small">${x}</div>`).join('');
  const buttons = canEdit
    ? `<div class="row no-print" style="margin-top:10px">
        <button class="small" data-extra="${esc(d.id)}">🆘 Emergency person</button>
        <button class="small" data-edit-del="${esc(d.id)}">Edit</button>
        <button class="small" data-wa="${esc(d.id)}">📤 WhatsApp</button>
        <div class="spacer"></div>
        <button class="small danger" data-cancel-del="${esc(d.id)}">Cancel delivery</button></div>`
    : who !== 'staff' && d.status !== 'cancelled' ? `<div class="row no-print" style="margin-top:10px"><button class="small" data-wa="${esc(d.id)}">📤 WhatsApp</button></div>` : '';
  return `<div class="card unit-card${d.status === 'cancelled' ? ' muted' : ''}">${head}${info ? `<div style="margin-top:6px">${info}</div>` : ''}${team}${lost}${buttons}</div>`;
}

function waText(d) {
  const lines = [`*${state.pub.orgName} – Delivery ${fmtDate(d.date)} (${SESSION_NAMES[d.session]})*`, `Unit: ${d.unitName}`];
  if (d.customer) lines.push(`Customer: ${d.customer}${d.customerPhone ? ' (' + d.customerPhone + ')' : ''}`);
  if (d.machine) lines.push(`Machine: ${d.machine}`);
  if (d.address) lines.push(`Address: ${d.address}`);
  lines.push('Team:');
  for (const t of d.team) {
    const p = t.person;
    lines.push(`• ${placeName(t)}: ${p ? p.name + (p.phone ? ' ' + p.phone : '') : '(open)'}`);
  }
  return lines.join('\n');
}

// Hook up the buttons inside delivery cards. `base` is '/unit' or '/admin'; `list` the deliveries shown.
function bindDeliveryButtons(root, base, list, reload) {
  const find = (id) => list.find((d) => d.id === id);
  root.querySelectorAll('[data-wa]').forEach((b) => (b.onclick = () => window.open('https://wa.me/?text=' + encodeURIComponent(waText(find(b.dataset.wa))), '_blank')));
  root.querySelectorAll('[data-edit-del]').forEach((b) => (b.onclick = () => deliveryForm(base, find(b.dataset.editDel), reload)));
  root.querySelectorAll('[data-cancel-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Cancel this delivery? Its helpers become free.')) return;
    try { await api(`${base}/deliveries/${b.dataset.cancelDel}/cancel`, { method: 'POST' }); toast('Delivery cancelled'); reload(); } catch (ex) { toast(ex.message, true); }
  }));
  root.querySelectorAll('[data-replace]').forEach((b) => (b.onclick = async () => {
    const [id, personId, name] = b.dataset.replace.split('|');
    const d = find(id);
    const t = d.team.find((x) => x.person && x.person.id === personId);
    const msg = t && t.extra ? `Remove ${name} (emergency person) from this delivery?` : `${name} can't come? They are taken off this delivery and someone else is picked automatically.`;
    if (!confirm(msg)) return;
    try {
      if (t && t.extra) await api(`${base}/deliveries/${id}/extra/cancel`, { method: 'POST', body: { slot: t.slot } });
      else await api(`${base}/deliveries/${id}/replace`, { method: 'POST', body: { personId } });
      toast('Done – team updated');
      reload();
    } catch (ex) { toast(ex.message, true); }
  }));
  root.querySelectorAll('[data-extra]').forEach((b) => (b.onclick = () => askExtra(base, find(b.dataset.extra), reload)));
  root.querySelectorAll('[data-change]').forEach((b) => (b.onclick = () => { const [id, role, slot] = b.dataset.change.split('|'); changePlace(find(id), role, Number(slot)); }));
}

function deliveryForm(base, d, reload, presetDate) {
  const isAdmin = base === '/admin';
  const def = state.defaultHelpers ?? 2;
  const v = d || { date: presetDate || state.today, session: 'FULL', helpersNeeded: def, installation: false, customer: '', customerPhone: '', address: '', machine: '', notes: '', unitId: '' };
  const units = isAdmin ? A().units.filter((u) => u.active) : [];
  const helperOpts = Array.from({ length: state.pub.maxHelpers + 1 }, (_, i) => `<option value="${i}" ${Number(v.helpersNeeded) === i ? 'selected' : ''}>${i === 0 ? 'No helper' : i + (i === 1 ? ' helper' : ' helpers')}</option>`).join('');
  openModal(`<h2>${d ? 'Edit delivery' : 'New delivery'}</h2>
    ${isAdmin ? `<label>Unit *</label><select name="unitId" ${d ? 'disabled' : ''} required>${units.map((u) => `<option value="${esc(u.id)}" ${v.unitId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>` : ''}
    <div class="form-grid">
      <div><label>Delivery date *</label><input type="date" name="date" required value="${esc(v.date)}" min="${esc(state.today)}"></div>
      <div><label>Time</label><select name="session">${state.pub.sessions.map((s) => `<option value="${s}" ${v.session === s ? 'selected' : ''}>${SESSION_NAMES[s]}</option>`).join('')}</select></div>
      <div><label>Helpers needed *</label><select name="helpersNeeded">${helperOpts}</select></div>
      <div><label>Installation person needed?</label><select name="installation"><option value="no">No</option><option value="yes" ${v.installation ? 'selected' : ''}>Yes – need installation</option></select></div>
    </div>
    <div class="form-grid">
      <div><label>Customer / party name</label><input name="customer" value="${esc(v.customer)}"></div>
      <div><label>Customer phone</label><input name="customerPhone" type="tel" value="${esc(v.customerPhone)}"></div>
      <div><label>Machine / model</label><input name="machine" value="${esc(v.machine)}" placeholder="e.g. 10 HP screw compressor"></div>
    </div>
    <label>Delivery address</label><textarea name="address">${esc(v.address)}</textarea>
    <label>Notes</label><input name="notes" value="${esc(v.notes)}" placeholder="e.g. 2nd floor, no lift">
    <p class="muted small">Helpers are picked fairly from all units. "Morning" and "Afternoon" deliveries can share people; a "Full day" delivery keeps them the whole day.</p>
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">${d ? 'Save' : 'Book delivery'}</button></div>`,
  async (fd) => {
    const body = Object.fromEntries(fd);
    if (d) await api(`${base}/deliveries/${d.id}`, { method: 'PUT', body });
    else await api(`${base}/deliveries`, { method: 'POST', body });
    toast(d ? 'Delivery updated' : 'Delivery booked – team assigned');
    reload();
  });
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
  state.today = data.today;
  state.defaultHelpers = data.defaultHelpers;
  const upcoming = data.deliveries.filter((d) => d.date >= data.today);
  const recent = data.deliveries.filter((d) => d.date < data.today).reverse();
  const todays = upcoming.filter((d) => d.date === data.today);
  const open = upcoming.reduce((n, d) => n + d.open, 0);
  const wrap = $app.querySelector('.wrap');
  wrap.innerHTML = `<div class="hero"><div class="label">Today · ${esc(fmtDate(data.today))}</div>
      <div class="big">${todays.length ? `${todays.length} deliver${todays.length > 1 ? 'ies' : 'y'} today` : 'No delivery today'}</div>
      <div class="line">${upcoming.length} upcoming${open ? ` · <b>${open} place(s) still open</b> – use 🆘 Emergency person` : ''}</div>
      <div class="row"><a class="call" href="#" id="book">+ Book a delivery</a></div></div>
    ${upcoming.length ? groupByDate(upcoming, data.today, (d) => deliveryCard(d, 'unit', data.today)) : '<div class="card muted">No deliveries booked. Tap "Book a delivery" and choose how many helpers and if installation is needed – the team is picked automatically.</div>'}
    ${recent.length ? `<details class="card"><summary><b>Last 7 days</b></summary><div class="grid" style="margin-top:10px">${recent.map((d) => deliveryCard(d, 'unit', data.today)).join('')}</div></details>` : ''}`;
  document.getElementById('book').onclick = (e) => { e.preventDefault(); deliveryForm('/unit', null, renderUnit); };
  bindDeliveryButtons(wrap, '/unit', data.deliveries, renderUnit);
}

// ---------- staff view ----------
async function renderStaff() {
  $app.innerHTML = topbar(state.me.name) + '<div class="wrap"><div class="loading">Loading…</div></div>';
  bindLogout();
  const data = await api('/staff/home');
  const todays = data.jobs.filter((j) => j.date === data.today);
  const hero = todays.length
    ? todays.map((j) => `<div class="hero"><div class="label">Today · ${esc(SESSION_NAMES[j.session])} · you are ${j.myRole === 'installer' ? 'installation person' : 'helper'}${j.extra ? ' (emergency)' : ''}</div>
        <div class="big">${esc(j.unitName)}</div>
        ${j.customer ? `<div class="line">👤 ${esc(j.customer)}${j.machine ? ' · ' + esc(j.machine) : ''}</div>` : ''}
        ${j.address ? `<div class="line">📍 ${esc(j.address)}</div>` : ''}
        <div class="line small">Team: ${j.team.filter((t) => t.person).map((t) => esc(t.person.name)).join(', ')}</div>
        <div class="row">${j.unit && j.unit.phone ? `<a class="call" href="tel:${esc(j.unit.phone.replace(/[^\d+]/g, ''))}">📞 Call unit</a>` : ''}
        ${j.address ? `<a class="call" target="_blank" rel="noopener" href="${mapLink(j.address)}">🗺️ Map</a>` : ''}</div></div>`).join('')
    : `<div class="hero off"><div class="label">Today · ${esc(fmtDate(data.today))}</div><div class="big">${data.leaves.some((l) => l.from <= data.today) ? 'You are on leave' : 'No delivery today'}</div></div>`;
  const later = data.jobs.filter((j) => j.date > data.today);
  $app.querySelector('.wrap').innerHTML = `${hero}
    <div class="row section"><h2 style="margin:0">Next deliveries</h2><div class="spacer"></div><span class="badge ok">${data.monthDuties} deliver${data.monthDuties === 1 ? 'y' : 'ies'} this month</span></div>
    ${later.length ? `<div class="grid">${later.map((d) => deliveryCard(d, 'staff', data.today)).join('')}</div>` : '<div class="card muted">Nothing planned yet.</div>'}`;
}

// ---------- admin ----------
const TABS = [
  ['today', 'Today'],
  ['deliveries', 'Deliveries'],
  ['units', 'Units'],
  ['people', 'Helpers & installers'],
  ['leaves', 'Leave'],
  ['report', 'Fairness report'],
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
  const views = { today: adminToday, deliveries: adminDeliveries, units: adminUnits, people: adminPeople, leaves: adminLeaves, report: adminReport, settings: adminSettings };
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
      <li>Each unit logs in and books a delivery: date, how many helpers, installation yes/no.</li>
      <li>The team is picked automatically and fairly from all units. Units can ask for an 🆘 emergency person any time.</li></ol></div>`;
    return;
  }
  // Today's deliveries may be outside the chosen range; fetch today explicitly.
  const day = await api(`/admin/data?from=${t}&to=${t}`);
  const todays = day.deliveries.filter((d) => d.status !== 'cancelled');
  const busy = new Set(todays.flatMap((d) => d.team.filter((x) => x.person).map((x) => x.person.id)));
  const free = A().people.filter((p) => p.active && !busy.has(p.id));
  const tag = (p) => `${esc(p.name)} ${onLeaveOn(p.id, t) ? '<span class="badge warn">leave</span>' : p.backup ? '<span class="badge bad">backup</span>' : ''}`;
  main.innerHTML = `<div class="row section"><div><h1>Today · ${esc(fmtDate(t, { weekday: 'long', day: 'numeric', month: 'long' }))}</h1>
      <div class="muted">${todays.length} deliver${todays.length === 1 ? 'y' : 'ies'} · ${todays.reduce((n, d) => n + d.team.filter((x) => x.person).length, 0)} people out${todays.some((d) => d.open) ? ` · <b class="empty">${todays.reduce((n, d) => n + d.open, 0)} place(s) open</b>` : ''}</div></div>
      <div class="spacer"></div><button class="primary" id="add">+ New delivery</button></div>
    ${todays.length ? `<div class="grid">${todays.map((d) => deliveryCard(d, 'admin', t)).join('')}</div>` : '<div class="card muted">No delivery today.</div>'}
    <div class="card" style="margin-top:12px"><h3>Not on a delivery today</h3>
      <div class="small"><b>Helpers:</b> ${free.filter((p) => canDo(p, 'helper')).map(tag).join(' &nbsp; ') || '<span class="muted">none</span>'}</div>
      <div class="small" style="margin-top:4px"><b>Installation:</b> ${free.filter((p) => canDo(p, 'installer')).map(tag).join(' &nbsp; ') || '<span class="muted">none</span>'}</div></div>`;
  document.getElementById('add').onclick = () => deliveryForm('/admin', null, renderAdmin, t);
  bindDeliveryButtons(main, '/admin', todays, renderAdmin);
}

function changePlace(d, role, slot) {
  const current = d.team.find((t) => t.role === role && t.slot === slot && !t.extra);
  const opts = A().people.filter((p) => p.active && canDo(p, role)).map((p) => {
    const leave = onLeaveOn(p.id, d.date);
    const there = A().deliveries.find((x) => x.date === d.date && x.status !== 'cancelled' && x.team.some((t) => t.person && t.person.id === p.id) && (x.id === d.id || x.session === 'FULL' || d.session === 'FULL' || x.session === d.session));
    const note = leave ? ' — on leave' : there && !(current && current.person && current.person.id === p.id) ? ` — on ${there.id === d.id ? 'this delivery' : there.unitName + ' delivery'} (will swap)` : '';
    return `<option value="${esc(p.id)}" ${current && current.person && current.person.id === p.id ? 'selected' : ''} ${leave ? 'disabled' : ''}>${p.backup ? '🆘 ' : ''}${esc(p.name)} (${esc(p.unitName || 'no unit')})${esc(note)}</option>`;
  }).join('');
  openModal(`<h2>Change ${role === 'installer' ? 'installation person' : 'helper'}</h2>
    <div class="muted">${esc(d.unitName)} · ${esc(fmtDate(d.date))} · ${esc(SESSION_NAMES[d.session])} · ${esc(placeName({ role, slot }))}</div>
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
  const showCancelled = state.showCancelled;
  const list = A().deliveries.filter((d) => showCancelled || d.status !== 'cancelled');
  main.innerHTML = `<div class="row section no-print">
      <button id="prev">◀ Prev</button><button id="this">Next 2 weeks</button><button id="next">Next ▶</button>
      <input type="date" id="from" value="${esc(A().from)}" style="width:auto"> to <input type="date" id="to" value="${esc(A().to)}" style="width:auto">
      <button id="go">Show</button>
      <label class="check"><input type="checkbox" id="cx" ${showCancelled ? 'checked' : ''}> show cancelled</label>
      <div class="spacer"></div>
      <button id="print">🖨️ Print</button><button id="rebal">↻ Re-balance</button><button class="primary" id="add">+ New delivery</button></div>
    <h2 class="print-only">${esc(state.pub.orgName)} – ${esc(fmtDate(A().from))} to ${esc(fmtDate(A().to))}</h2>
    ${list.length ? groupByDate(list, t, (d) => deliveryCard(d, 'admin', t)) : '<div class="card muted">No deliveries in these dates.</div>'}`;
  const go = (from, to) => { state.from = from; state.to = to; renderAdmin(); };
  document.getElementById('prev').onclick = () => go(addDays(state.from, -14), addDays(state.to, -14));
  document.getElementById('next').onclick = () => go(addDays(state.from, 14), addDays(state.to, 14));
  document.getElementById('this').onclick = () => go(t, addDays(t, 13));
  document.getElementById('go').onclick = () => go(document.getElementById('from').value, document.getElementById('to').value);
  document.getElementById('cx').onchange = (e) => { state.showCancelled = e.target.checked; adminDeliveries(main); };
  document.getElementById('print').onclick = () => window.print();
  document.getElementById('add').onclick = () => deliveryForm('/admin', null, renderAdmin);
  document.getElementById('rebal').onclick = () => openModal(`<h2>Re-balance teams</h2>
      <p>Teams normally stay as they are once made. Re-balance makes all teams again from the chosen day, using the fairness rules. Past days never change.</p>
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
  main.innerHTML = `<div class="row section"><h1>Fairness report</h1><div class="spacer"></div>
      <input type="date" id="rf" value="${esc(from)}" style="width:auto"> to <input type="date" id="rt" value="${esc(to)}" style="width:auto"><button id="rgo">Show</button></div>
    <div class="card section">${s.deliveries} deliveries.
      <div class="small">Helpers – difference between most and least: <b>${sh}</b> ${ok(sh)}</div>
      <div class="small">Installation persons – difference: <b>${si}</b> ${ok(si)}</div>
      ${s.unfilled ? `<div class="small" style="margin-top:6px"><span class="badge bad">${s.unfilled} open places</span> – not enough people on some days.</div>` : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Person</th><th class="num">Total</th><th class="num">As helper</th><th class="num">As installer</th><th class="num">Emergency</th><th class="num">Leave days</th>${s.units.map((u) => `<th class="num">${esc(u.name)}</th>`).join('')}</tr></thead>
    <tbody>${s.rows.map((r) => `<tr><td><b>${esc(r.name)}</b> ${roleBadge(r.role)}${r.backup ? ' <span class="badge bad">backup</span>' : ''}${r.active ? '' : ' <span class="badge">inactive</span>'}<div class="small muted">${esc(r.unitName)}</div></td>
      <td class="num"><b>${r.total}</b></td><td class="num">${r.helper}</td><td class="num">${r.installer}</td><td class="num">${r.emergency}</td><td class="num">${r.leaveDays}</td>${s.units.map((u) => `<td class="num">${heat(r.perUnit[u.id] || 0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="muted small">Counts include planned future deliveries up to the end date. The unit columns show how often each person went on that unit's deliveries — an even spread means people are shuffled well across units.</p>`;
  document.getElementById('rgo').onclick = () => { state.repFrom = document.getElementById('rf').value; state.repTo = document.getElementById('rt').value; renderAdmin(); };
}

// --- Settings ---
function adminSettings(main) {
  const s = A().settings;
  main.innerHTML = `<h1>Settings</h1>
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
