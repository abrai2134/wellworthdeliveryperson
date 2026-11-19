const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Store, newId } = require('./lib/store');
const auth = require('./lib/auth');
const S = require('./lib/scheduler');
const sheets = require('./lib/sheets');
const allowance = require('./lib/allowance');
const { todayIn, addDays, range, isValid } = require('./lib/dates');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = new Store(path.join(DATA_DIR, 'db.json'));
const db = () => store.db;

const SESSION_DAYS = 30;
// Which code version is running (Render sets RENDER_GIT_COMMIT), shown on the login page.
const VERSION = (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local').slice(0, 7);
const COOKIE = 'wd_session';
const BOOK_AHEAD_DAYS = 400; // services can be a year ahead
const TYPES = ['delivery', 'service', 'loading']; // loading = loading / unloading at the unit (internal)

// ---------- first run: create the admin account ----------
// ---------- start / completed times typed in by hand ----------
// Checks times a person enters (when they forgot to press Start / Completed).
function readTimes(d, body, needCompleted) {
  const iso = (v) => { const x = new Date(String(v || '')); return isNaN(x) ? null : x.toISOString(); };
  const started = body.startedAt ? iso(body.startedAt) : null;
  const completed = body.completedAt ? iso(body.completedAt) : null;
  if (body.startedAt && !started) return { error: 'Start time is not valid' };
  if (body.completedAt && !completed) return { error: 'Completed time is not valid' };
  if (needCompleted && !completed) return { error: 'Enter the completed time' };
  const end = completed || new Date().toISOString();
  if (started && started >= end) return { error: 'Start must be before completed' };
  if (end > new Date(Date.now() + 5 * 60000).toISOString()) return { error: 'Completed time cannot be in the future' };
  const earliest = new Date(Date.parse(d.date + 'T00:00:00Z') - 86400000).toISOString(); // a day before the job date
  if ((started && started < earliest) || end < earliest) return { error: 'Times must be on or after the job date' };
  if (started && Date.parse(end) - Date.parse(started) > 24 * 3600000) return { error: 'Work time cannot be more than 24 hours' };
  return { value: { started, completed } };
}

// ---------- expense allowance ----------
function teamIds(d) {
  return [...new Set(db().assignments.filter((a) => a.deliveryId === d.id && a.personId).map((a) => a.personId))];
}
function setAllowance(d) {
  d.allowance = allowance.compute(d, teamIds(d), db().settings.allowance || allowance.DEFAULT);
}
// Jobs completed before this feature get their expense worked out once.
for (const d of db().deliveries) if (d.status === 'done' && !d.allowance) setAllowance(d);
// Deliveries got their own slabs (under 1 h nil, 1–3 h ₹35, then as before): add them once
// and work out completed deliveries again with the new rule.
{
  const a = db().settings.allowance || (db().settings.allowance = { ...allowance.DEFAULT });
  if (!a.deliverySlabs) {
    a.deliverySlabs = allowance.DEFAULT.deliverySlabs.map((x) => ({ ...x }));
    for (const d of db().deliveries) if (d.status === 'done' && d.type !== 'service') setAllowance(d);
    store.save();
  }
}

if (db().admins.length === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db().admins.push({ id: newId('adm'), username, passHash: auth.hashPassword(password) });
  store.save();
  console.log(`Created admin account "${username}". Log in and change the password.`);
}

const today = () => todayIn(db().settings.timezone);

// Something changed (people, leave, units): fill gaps from today on, keep existing teams.
function changed() {
  S.repairFrom(db(), today());
  require('./lib/assembly').assignWaiting(db(), db().settings.timezone); // a leader may be free / back
  require('./lib/fab').assignWaiting(db(), db().settings.timezone); // fab leaders too
  if (typeof refreshFabAmounts === 'function') refreshFabAmounts(); // a fab leader may now be Contractor
  store.save();
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' })); // room for a few photos
// Always check for a newer page after an update (no stale app.js / style.css in phones).
app.use(express.static(path.join(__dirname, 'public'), { index: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// Simple brute-force protection for login.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, since: now };
  if (now - rec.since > 15 * 60 * 1000) {
    rec.count = 0;
    rec.since = now;
  }
  attempts.set(ip, rec);
  return rec;
}

function findAccount(role, id) {
  if (role === 'admin') return db().admins.find((a) => a.id === id);
  if (role === 'unit') return db().units.find((u) => u.id === id && u.active && !u.deleted);
  if (role === 'staff') return db().people.find((p) => p.id === id && p.active && !p.deleted && p.passHash);
  if (role === 'dispatch') return db().dispatchers.find((d) => d.id === id && d.active && !d.deleted);
  if (role === 'painting') return db().painters.find((d) => d.id === id && d.active && !d.deleted);
  return null;
}

app.use((req, res, next) => {
  const token = auth.parseCookies(req.headers.cookie)[COOKIE];
  const session = auth.readToken(token, db().secret);
  if (session) {
    const account = findAccount(session.role, session.id);
    if (account) req.user = { role: session.role, id: session.id, account };
  }
  next();
});

function need(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) return res.status(401).json({ error: 'Please log in' });
    next();
  };
}

const bad = (res, msg) => res.status(400).json({ error: msg });
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const norm = (v) => str(v).toLowerCase();

// ---------- public ----------
app.get('/api/public', (req, res) => {
  res.json({ orgName: db().settings.orgName, sessions: S.SESSIONS, maxHelpers: S.MAX_HELPERS, version: VERSION });
});

// Public machine search (no login): where a model is – per unit, how many in fab, painting,
// assembly and godown stock. Counts only (no names, clients or money).
app.get('/api/public/find', (req, res) => {
  const q = String(req.query.q || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const unitList = db().units.filter((u) => u.active && !u.deleted).map((u) => ({ id: u.id, name: u.name }));
  const onlyUnit = str(req.query.unitId);
  if (q.length < 2 && !onlyUnit) return res.json({ models: [], units: unitList });
  // A full model no. (e.g. FT~30BK) shows only that model – not FT~30BKSB; otherwise partial matches.
  const allModels = [...db().bend, ...db().fab, ...db().painting, ...db().assembly].map((m) => m.model);
  const exact = q && allModels.some((md) => ASM.key(md) === q || ASM.baseKey(md) === q);
  const hit = (model) => (exact ? ASM.key(model) === q || ASM.baseKey(model) === q : String(model || '').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(q));
  const inUnit = (unitId) => !onlyUnit || unitId === onlyUnit;
  const units = Object.fromEntries(db().units.filter((u) => !u.deleted).map((u) => [u.id, u.name]));
  const out = {};
  const row = (model, unitId) => {
    const m = (out[model] ||= { model, units: {} });
    return (m.units[unitId || ''] ||= { unit: units[unitId] || '(no unit)', bending: 0, fabNotStarted: 0, inFab: 0, paintComing: 0, inPainting: 0, arrived: 0, notStarted: 0, assembling: 0, godown: 0, booked: 0 });
  };
  for (const m of db().bend) if (hit(m.model) && inUnit(m.unitId) && FAB.OPEN.includes(m.status)) row(m.model, m.unitId).bending++;
  for (const m of db().fab) if (hit(m.model) && inUnit(m.unitId) && FAB.OPEN.includes(m.status)) row(m.model, m.unitId)[m.status === 'started' ? 'inFab' : 'fabNotStarted']++;
  for (const x of db().painting) if (hit(x.model) && inUnit(x.unitId) && ['coming', 'in'].includes(x.status)) row(x.model, x.unitId)[x.status === 'coming' ? 'paintComing' : 'inPainting']++;
  for (const m of db().assembly) {
    if (!hit(m.model) || !inUnit(m.unitId)) continue;
    if (m.status === 'arrived') row(m.model, m.unitId).arrived++;
    else if (m.status === 'waiting' || m.status === 'assigned') row(m.model, m.unitId).notStarted++;
    else if (m.status === 'started') row(m.model, m.unitId).assembling++;
    else if (m.status === 'done' && m.location === 'godown') { const r = row(m.model, m.unitId); r.godown++; if (m.bookedParty) r.booked++; }
  }
  const models = Object.values(out).map((m) => ({ model: m.model, units: Object.values(m.units).sort((a, b) => a.unit.localeCompare(b.unit)) }))
    .sort((a, b) => a.model.localeCompare(b.model)).slice(0, onlyUnit && q.length < 2 ? 200 : 30);
  res.json({ models, units: unitList });
});

app.post('/api/login', (req, res) => {
  const rec = tooMany(req.ip);
  if (rec.count >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const role = str(req.body.role);
  const username = norm(req.body.username);
  const password = String(req.body.password || '');
  let account = null;
  if (role === 'admin') account = db().admins.find((a) => a.username.toLowerCase() === username);
  if (role === 'unit') account = db().units.find((u) => !u.deleted && u.active && (u.username || '').toLowerCase() === username);
  if (role === 'staff') account = db().people.find((p) => !p.deleted && p.active && p.passHash && (p.username || '').toLowerCase() === username);
  if (role === 'dispatch') account = db().dispatchers.find((d) => !d.deleted && d.active && (d.username || '').toLowerCase() === username);
  if (role === 'painting') account = db().painters.find((d) => !d.deleted && d.active && (d.username || '').toLowerCase() === username);
  if (!account || !auth.verifyPassword(password, account.passHash)) {
    rec.count++;
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  // a person logs in only with the button of their own section (Fab / Bending / Helper – Team leader)
  if (role === 'staff') {
    const SECTIONS = { fab: ['fableader', 'fabhelper', 'fabmanager'], bend: ['bendleader', 'bendmanager', 'bendcompany'] };
    const own = Object.keys(SECTIONS).find((k) => SECTIONS[k].includes(account.role)) || 'staff';
    const asked = ['fab', 'bend'].includes(str(req.body.section)) ? str(req.body.section) : 'staff';
    const NAMES = { fab: '🏭 Fab', bend: '🔩 Bending', staff: '🧰 Helper / Team leader' };
    if (own !== asked) return res.status(401).json({ error: `This is not a ${NAMES[asked]} login – press the ${NAMES[own]} button to log in` });
  }
  rec.count = 0;
  const token = auth.signToken({ role, id: account.id, exp: Date.now() + SESSION_DAYS * 86400000 }, db().secret);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`
  );
  res.json({ role });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ role: null });
  const a = req.user.account;
  res.json({ role: req.user.role, name: a.name || a.username, id: a.id });
});

// ---------- shared view helpers ----------
const unitName = (id) => (db().units.find((u) => u.id === id) || {}).name || '';

function unitView(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, contactName: u.contactName || '', phone: u.phone || '', address: u.address || '', username: u.username || '', active: !!u.active };
}

function personView(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    phone: p.phone || '',
    role: p.role,
    unitId: p.unitId || '',
    unitName: unitName(p.unitId),
    backup: !!p.backup,
    username: p.username || '',
    canLogin: !!p.passHash,
    active: !!p.active,
    payType: p.payType || '',
    incentiveCut: p.incentiveCut || 0,
  };
}

function deliveryView(d) {
  const team = S.teamOf(db(), d.id)
    .slice()
    .sort((a, b) => (a.role === b.role ? a.slot - b.slot : a.role === 'installer' ? -1 : 1))
    .map((a) => ({
      role: a.role,
      slot: a.slot,
      manual: !!a.manual,
      extra: !!a.extra,
      backup: !!a.backup,
      reason: a.reason || '',
      fromDeliveryId: a.fromDeliveryId || null,
      fromUnit: a.fromDeliveryId ? unitName((db().deliveries.find((x) => x.id === a.fromDeliveryId) || {}).unitId) : '',
      person: personView(db().people.find((p) => p.id === a.personId)),
    }));
  // People taken away from this delivery by another unit's emergency request.
  const lost = db()
    .assignments.filter((a) => a.extra && a.fromDeliveryId === d.id && a.personId)
    .map((a) => ({ person: (db().people.find((p) => p.id === a.personId) || {}).name || '', unit: unitName(a.unitId) }));
  const parent = d.parentId && db().deliveries.find((x) => x.id === d.parentId);
  const services = db()
    .deliveries.filter((x) => x.parentId === d.id && x.status !== 'cancelled')
    .map((x) => ({ id: x.id, date: x.date, status: x.status }));
  return {
    id: d.id,
    type: d.type || 'delivery',
    parentId: d.parentId || null,
    parent: parent ? { id: parent.id, date: parent.date, type: parent.type || 'delivery' } : null,
    services,
    createdAt: d.createdAt || null,
    startedAt: d.startedAt || null,
    completedAt: d.completedAt || null,
    completedBy: d.completedBy || '',
    completionNote: d.completionNote || '',
    timesEditedBy: d.timesEditedBy || '',
    absents: (d.absentLog || []).map((x) => ({ name: (db().people.find((p) => p.id === x.personId) || {}).name || '?', at: x.at, by: x.by, reason: x.reason || '' })),
    allowance: d.status === 'done' && d.allowance && d.allowance.applies
      ? { ...d.allowance, names: d.allowance.people.map((id) => (db().people.find((p) => p.id === id) || {}).name || '?') }
      : null,
    photos: (d.photos || []).map((p) => ({ url: '/api/photos/' + p.file, file: p.file, at: p.at, by: p.by })),
    unitId: d.unitId,
    unitName: unitName(d.unitId),
    date: d.date,
    session: d.session,
    entryBy: d.entryBy || '',
    customer: d.customer || '',
    customerPhone: d.customerPhone || '',
    address: d.address || '',
    machine: d.machine || '',
    items: d.items || [],
    notes: d.notes || '',
    helpersNeeded: d.helpersNeeded,
    installation: !!d.installation,
    status: d.status,
    createdBy: d.createdBy || '',
    team,
    open: team.filter((t) => !t.person).length,
    lost,
  };
}

function readDelivery(body, unitId, opts = {}) {
  const t = today();
  const date = str(body.date);
  if (!isValid(date)) return { error: 'Choose a delivery date' };
  if (date < t) return { error: 'The date cannot be in the past' };
  if (date > addDays(t, BOOK_AHEAD_DAYS)) return { error: `You can book up to ${BOOK_AHEAD_DAYS} days ahead` };
  const session = S.SESSIONS.includes(body.session) ? body.session : body.type === 'loading' ? 'AM' : 'FULL';
  if (body.type === 'loading' && !S.LOADING_SESSIONS.includes(session)) return { error: 'Loading / unloading: choose Morning, Afternoon or Evening' };
  const type = TYPES.includes(body.type) ? body.type : 'delivery';
  const isLoad = type === 'loading';
  // Loading / unloading: 1 to 4 persons, any helper or installation person, no installation place.
  const helpersNeeded = isLoad
    ? parseInt(body.helpersNeeded, 10)
    : Math.max(0, Math.min(S.MAX_HELPERS, parseInt(body.helpersNeeded, 10) || 0));
  if (isLoad && !(helpersNeeded >= S.MIN_LOADERS && helpersNeeded <= S.MAX_LOADERS)) return { error: `Loading / unloading needs ${S.MIN_LOADERS} to ${S.MAX_LOADERS} persons` };
  const installation = !isLoad && (body.installation === true || body.installation === 'on' || body.installation === 'yes');
  if (!helpersNeeded && !installation) return { error: 'Ask for at least one helper or an installation person' };
  if (!liveUnit(unitId)) return { error: 'Choose a unit' };
  let parentId = isLoad ? null : str(body.parentId) || null;
  if (parentId && !db().deliveries.some((x) => x.id === parentId && x.unitId === unitId)) parentId = null;
  // Machines: list of { label, qty }. Older jobs only had a free-text "machine".
  let items = Array.isArray(body.items) ? body.items : [];
  items = items
    .map((i) => ({ label: canonModel(i && i.label), qty: Math.max(1, Math.min(999, parseInt(i && i.qty, 10) || 1)) }))
    .filter((i) => i.label)
    .slice(0, 20);
  const machine = items.length ? items.map((i) => `${i.label} × ${i.qty}`).join(', ').slice(0, 600) : str(body.machine, 120);
  // "Entry by": who raised the request. Must be a name from the sheet's "Made By" column when that list exists.
  let entryBy = str(body.entryBy, 80);
  if (!entryBy && !opts.lenientEntry) return { error: 'Choose who is raising this request (Entry by)' };
  if (db().makers.length && !(opts.lenientEntry && !entryBy)) {
    const hit = db().makers.find((n) => n.toLowerCase() === entryBy.toLowerCase());
    if (!hit) return { error: entryBy ? `"${entryBy}" is not in the Made By list – choose a name from the list` : 'Choose who is raising this request (Entry by)' };
    entryBy = hit;
  }
  return {
    value: {
      unitId,
      type,
      entryBy,
      items,
      parentId,
      date,
      session,
      helpersNeeded,
      installation,
      customer: str(body.customer, 120),
      customerPhone: str(body.customerPhone, 30),
      address: str(body.address, 300),
      machine,
      notes: str(body.notes, 500),
    },
  };
}
const liveUnit = (id) => db().units.find((u) => u.id === id && u.active && !u.deleted);

// A unit's loading / unloading job that has no end time yet blocks the next one.
function openLoading(unitId, exceptId) {
  return db().deliveries.find((x) => x.unitId === unitId && x.type === 'loading' && S.isOpen(x) && x.id !== exceptId);
}
function loadingBlock(unitId, exceptId) {
  const o = openLoading(unitId, exceptId);
  return o ? { error: `The loading / unloading job of ${o.date} (${{ AM: 'morning', PM: 'afternoon', EVE: 'evening' }[o.session] || 'full day'}) has no end time yet. Mark it ✓ Completed with start and end time before booking the next one.` } : null;
}

function createDelivery(body, unitId, by) {
  const r = readDelivery(body, unitId);
  if (r.error) return r;
  if (r.value.type === 'loading') { const b = loadingBlock(unitId); if (b) return b; }
  const d = { id: newId('dlv'), ...r.value, status: 'planned', excluded: [], createdBy: by, createdAt: new Date().toISOString() };
  db().deliveries.push(d);
  S.repairDate(db(), d.date);
  store.save();
  return { value: d };
}

function updateDelivery(d, body) {
  if (d.status === 'cancelled') return { error: 'This delivery was cancelled' };
  if (d.status === 'done') return { error: 'This job is completed. Reopen it first to change it.' };
  if (d.date < today()) return { error: 'Past deliveries cannot be changed' };
  const r = readDelivery({ ...body, type: body.type || d.type, parentId: body.parentId === undefined ? d.parentId : body.parentId }, d.unitId);
  if (r.error) return r;
  if (r.value.type === 'loading' && d.type !== 'loading') { const b = loadingBlock(d.unitId, d.id); if (b) return b; }
  const oldDate = d.date;
  Object.assign(d, r.value);
  if (oldDate !== d.date) {
    db().assignments = db().assignments.filter((a) => a.deliveryId !== d.id);
    d.excluded = [];
    S.repairDate(db(), oldDate);
  }
  S.repairDate(db(), d.date);
  store.save();
  return { value: d };
}

function cancelDelivery(d) {
  if (d.status === 'cancelled') return { error: 'Already cancelled' };
  if (d.status === 'done') return { error: 'This job is already completed' };
  if (d.date < today()) return { error: 'Past deliveries cannot be changed' };
  d.status = 'cancelled';
  db().assignments = db().assignments.filter((a) => a.deliveryId !== d.id);
  S.repairDate(db(), d.date); // people are free again for other deliveries that day
  store.save();
  return { value: d };
}

// The team has left for the job.
function startDelivery(d, by) {
  if (!S.isOpen(d)) return { error: 'This job is not open' };
  if (d.date > today()) return { error: 'This job is on a later day' };
  d.status = 'started';
  d.startedAt = new Date().toISOString();
  d.startedBy = by;
  store.save();
  return { value: d };
}

// Job finished: record the time, free the team for other jobs that day and optionally
// book a follow-up service visit.
// ---------- photos (service book / customer remarks) ----------
// Saved on the data disk next to db.json; only logged-in users who can see the job can open them.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_PHOTOS = 10;
const PHOTO_NAME = /^[a-z0-9_]+\.(jpg|png|webp)$/;

// Check photos (data: URLs from the browser) before anything is saved.
function readPhotos(d, list) {
  const photos = Array.isArray(list) ? list.slice(0, MAX_PHOTOS) : [];
  if ((d.photos || []).length + photos.length > MAX_PHOTOS) return { error: `A job can have at most ${MAX_PHOTOS} photos` };
  const out = [];
  for (const p of photos) {
    const m = typeof p === 'string' && p.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return { error: 'Only photos (JPG / PNG) can be uploaded' };
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 4 * 1024 * 1024) return { error: 'A photo is too big (max 4 MB)' };
    out.push({ ext: m[1] === 'jpeg' ? 'jpg' : m[1], buf });
  }
  return { value: out };
}

function savePhotos(d, photos, by) {
  if (!photos.length) return;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  d.photos = d.photos || [];
  for (const p of photos) {
    const file = `${d.id.replace(/[^a-z0-9]/gi, '').toLowerCase()}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${p.ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), p.buf);
    d.photos.push({ file, at: new Date().toISOString(), by });
  }
}

function addPhotos(d, body, by) {
  if (d.status === 'cancelled') return { error: 'This job was cancelled' };
  const r = readPhotos(d, body.photos);
  if (r.error) return r;
  if (!r.value.length) return { error: 'Choose a photo' };
  savePhotos(d, r.value, by);
  store.save();
  return { value: d };
}

function completeDelivery(d, body, by) {
  if (!S.isOpen(d)) return { error: 'This job is not open' };
  if (d.date > today()) return { error: 'This job is on a later day' };
  let service = null;
  const after = d.type === 'loading' ? '' : str(body.serviceAfter); // no service after loading
  if (after) {
    const date = after === 'date' ? str(body.serviceDate) : addDays(today(), parseInt(after, 10) || 0);
    service = readDelivery(
      {
        type: 'service',
        parentId: d.id,
        date,
        session: str(body.serviceSession) || 'FULL',
        helpersNeeded: body.serviceHelpers !== undefined ? body.serviceHelpers : 0,
        installation: 'yes',
        customer: d.customer,
        customerPhone: d.customerPhone,
        address: d.address,
        machine: d.machine,
        items: d.items || [],
        entryBy: d.entryBy || '',
        notes: str(body.serviceNotes, 500),
      },
      d.unitId,
      { lenientEntry: true } // older jobs may have no "Entry by"
    );
    if (service.error) return { error: 'Service: ' + service.error };
  }
  const times = readTimes(d, body, false);
  if (times.error) return times;
  // Loading / unloading: start and end time are compulsory.
  if (d.type === 'loading' && !(times.value.started || d.startedAt)) return { error: 'Start time is compulsory for loading / unloading' };
  const photos = readPhotos(d, body.photos);
  if (photos.error) return photos;
  savePhotos(d, photos.value, by);
  d.status = 'done';
  const pressedStart = d.startedAt;
  if (times.value.started) d.startedAt = times.value.started;
  d.completedAt = times.value.completed || new Date().toISOString();
  d.completedBy = by;
  // Remember when times were typed in rather than pressed live.
  if (times.value.completed || (times.value.started && times.value.started !== pressedStart)) d.timesEditedBy = by;
  d.completionNote = str(body.note, 300);
  setAllowance(d);
  S.repairDate(db(), d.date); // the team is free again for other jobs that day
  if (service) {
    const sv = { id: newId('dlv'), ...service.value, status: 'planned', excluded: [], createdBy: by, createdAt: new Date().toISOString() };
    db().deliveries.push(sv);
    S.repairDate(db(), sv.date);
  }
  store.save();
  return { value: d };
}

// Marked completed by mistake: open it again with the same team where possible.
function reopenDelivery(d) {
  if (d.status !== 'done' && d.status !== 'started') return { error: 'This job is not completed or started' };
  d.status = 'planned';
  d.completedAt = null;
  d.startedAt = null;
  delete d.allowance;
  delete d.timesEditedBy;
  S.repairDate(db(), d.date);
  store.save();
  return { value: d };
}

// Fix start / completed time of a completed job; the expense is worked out again.
// Units may only add times when Start was never recorded; the admin can always change them.
function setTimes(d, body, by) {
  if (d.status !== 'done') return { error: 'Only completed jobs' };
  if (by === 'unit' && d.startedAt) return { error: 'Times are already recorded – ask the admin to change them' };
  const t = readTimes(d, body, true);
  if (t.error) return t;
  if (by === 'unit' && !t.value.started) return { error: 'Enter the start time' };
  d.startedAt = t.value.started;
  d.completedAt = t.value.completed;
  d.timesEditedBy = by;
  setAllowance(d);
  store.save();
  return { value: d };
}

function peopleFor(d) {
  const order = { free: 0, other: 1, emergency: 2, mine: 3 };
  return S.personStatus(db(), d.id)
    .sort((a, b) => order[a.status] - order[b.status] || (b.person.backup ? 1 : 0) - (a.person.backup ? 1 : 0) || a.person.name.localeCompare(b.person.name))
    .map((x) => ({ ...personView(x.person), status: x.status, at: unitName(x.unitId) }));
}

function addExtra(d, body, by) {
  if (d.type === 'loading' && by !== 'admin') return { error: 'Only the admin can change people on loading / unloading' };
  if (d.date < today()) return { error: 'Past deliveries cannot be changed' };
  try {
    S.addExtra(db(), d.id, str(body.personId), { role: str(body.role), reason: str(body.reason, 200), requestedBy: by });
  } catch (e) {
    return { error: e.message };
  }
  S.repairDate(db(), d.date); // refill the place the person left, if anyone is free
  store.save();
  return { value: d };
}

function cancelExtra(d, body) {
  if (d.date < today()) return { error: 'Past deliveries cannot be changed' };
  if (!S.isOpen(d)) return { error: 'This job is completed or cancelled' };
  if (!S.removeExtra(db(), d.id, Number(body.slot))) return { error: 'Nothing to cancel' };
  S.repairDate(db(), d.date);
  store.save();
  return { value: d };
}

// Someone is absent: take them off and pick a new name. Every absent is recorded on the job
// (who, by whom, when, reason) so the admin can see it.
function replace(d, body, by) {
  if (d.date < today()) return { error: 'Past deliveries cannot be changed' };
  if (!S.isOpen(d)) return { error: 'This job is completed or cancelled' };
  const personId = str(body.personId);
  try {
    S.replacePerson(db(), d.id, personId);
  } catch (e) {
    return { error: e.message };
  }
  const now = db().assignments.filter((a) => a.deliveryId === d.id && a.personId).map((a) => a.personId);
  d.absentLog = d.absentLog || [];
  d.absentLog.push({ personId, at: new Date().toISOString(), by, reason: str(body.reason, 150), newTeam: now });
  store.save();
  return { value: d };
}

const send = (res, r) => (r.error ? bad(res, r.error) : res.json({ ...(r.value && r.value.changed !== undefined ? { changed: r.value.changed, model: r.value.model } : {}), ok: true, id: r.value && r.value.id }));

// ---------- unit login ----------
const unit = express.Router();
unit.use(need('unit'));

// ---------- search all jobs ----------
// Matches party, phone, address, models, notes, team names, unit and date (2026-10-24 or 24/10).
function searchJobs(list, q, type) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const names = Object.fromEntries(db().people.map((p) => [p.id, p.name]));
  const out = [];
  for (const d of list) {
    if (d.status === 'cancelled') continue;
    if (type && (d.type || 'delivery') !== type) continue;
    const [y, m, dd] = d.date.split('-');
    const team = db().assignments.filter((a) => a.deliveryId === d.id && a.personId).map((a) => names[a.personId] || '');
    const text = [
      d.customer, d.customerPhone, d.address, d.machine, d.notes, d.completionNote, d.entryBy,
      ...(d.items || []).map((i) => i.label), ...team, unitName(d.unitId),
      d.date, `${dd}/${m}/${y}`, `${dd}/${m}`, `${+dd}/${+m}`, d.type === 'service' ? 'service' : d.type === 'loading' ? 'loading unloading' : 'delivery',
    ].join(' ').toLowerCase();
    if (words.every((w) => text.includes(w))) out.push(d);
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 60);
}

unit.get('/search', (req, res) => {
  const list = searchJobs(db().deliveries.filter((d) => d.unitId === req.user.id), str(req.query.q, 100), str(req.query.type));
  res.json({ today: today(), results: list.map(deliveryView) });
});

unit.get('/home', (req, res) => {
  const u = req.user.account;
  const t = today();
  const deliveries = db()
    .deliveries.filter((d) => d.unitId === u.id && d.status !== 'cancelled' && (d.date >= addDays(t, -30) || S.isOpen(d)))
    .sort((a, b) => a.date.localeCompare(b.date) || a.session.localeCompare(b.session))
    .map(deliveryView);
  res.json({ today: t, unit: unitView(u), deliveries, defaultHelpers: db().settings.defaultHelpers || 2, bookAhead: BOOK_AHEAD_DAYS, allowance: db().settings.allowance });
});

function ownDelivery(req, res) {
  const d = db().deliveries.find((x) => x.id === req.params.id && x.unitId === req.user.id);
  if (!d) res.status(404).json({ error: 'Delivery not found' });
  return d;
}

unit.post('/deliveries', (req, res) => send(res, createDelivery(req.body, req.user.id, 'unit')));
unit.put('/deliveries/:id', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, updateDelivery(d, req.body)); });
unit.post('/deliveries/:id/cancel', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, cancelDelivery(d)); });
unit.get('/deliveries/:id/people', (req, res) => { const d = ownDelivery(req, res); if (d) res.json({ people: peopleFor(d) }); });
unit.post('/deliveries/:id/extra', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, addExtra(d, req.body, 'unit')); });
unit.post('/deliveries/:id/extra/cancel', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, cancelExtra(d, req.body)); });
unit.post('/deliveries/:id/start', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, startDelivery(d, 'unit')); });
unit.post('/deliveries/:id/complete', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, completeDelivery(d, req.body, 'unit')); });
unit.post('/deliveries/:id/photos', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, addPhotos(d, req.body, 'unit')); });
unit.post('/deliveries/:id/times', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, setTimes(d, req.body, 'unit')); });
unit.post('/deliveries/:id/reopen', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, reopenDelivery(d)); });
unit.post('/deliveries/:id/replace', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, replace(d, req.body, 'unit')); });

app.use('/api/unit', unit);

// Open a photo: admin, the job's unit, or a person on that job.
app.get('/api/photos/:file', (req, res) => {
  const file = req.params.file;
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  if (!PHOTO_NAME.test(file)) return res.status(404).json({ error: 'Not found' });
  const d = db().deliveries.find((x) => (x.photos || []).some((p) => p.file === file));
  const am = !d && db().assembly.find((x) => [...(x.photos || []), ...(x.dispatchPhotos || [])].some((p) => p.file === file)); // sticker / dispatch photo
  if (!d && !am) return res.status(404).json({ error: 'Not found' });
  const u = req.user;
  const ok = d
    ? u.role === 'admin' || (u.role === 'unit' && d.unitId === u.id) || (u.role === 'staff' && db().assignments.some((a) => a.deliveryId === d.id && a.personId === u.id))
    : u.role === 'admin' || u.role === 'dispatch' || (u.role === 'unit' && (am.unitId === u.id || (am.transfers || []).some((t) => t.from === u.id))) || (u.role === 'staff' && [am.leaderId, am.installerId, am.helperId].includes(u.id));
  if (!ok) return res.status(403).json({ error: 'Not allowed' });
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(UPLOAD_DIR, file), (err) => err && !res.headersSent && res.status(404).json({ error: 'Photo file missing' }));
});

// ---------- client & machine lookup (units and admin) ----------
function needLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in' }); // any login (team leaders pick clients too)
  next();
}
app.get('/api/lookup/clients', needLogin, (req, res) => {
  res.json({ clients: sheets.searchClients(db().clients, str(req.query.q, 80), 10) });
});
app.get('/api/lookup/makers', needLogin, (req, res) => {
  res.json({ makers: db().makers });
});
// The model list is also used by team leaders (request / old machine forms).
app.get('/api/lookup/machines', (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in' })), (req, res) => {
  // machine list + model names that have an incentive rate (so the exact rate name can be picked)
  const s = asmSettings();
  const details = db().machines.map((m) => ({ label: m.label, desc: m.desc || '' }));
  for (const x of [...(s.incentives || []), ...(s.dispatchIncentives || []), ...((db().settings.fab && db().settings.fab.contractorRates) || [])]) if (x.model && !details.some((d) => ASM.sameRate(d.label, x.model))) details.push({ label: x.model, desc: '' });
  res.json({ machines: details.map((d) => d.label), details });
});

// Lists copied before model names were used on their own: switch them over once.
for (const m of db().machines) {
  if (m.model && m.label !== m.model) { m.desc = m.machine && m.machine !== m.model ? m.machine : ''; m.label = m.model; }
}

// Copy the client and machine lists from the Google Sheet.
let syncing = null;
async function syncSheet() {
  const cfg = db().sheet;
  if (!cfg.scriptUrl && !cfg.sheetLink) return { error: 'Google Sheet is not connected yet' };
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const r = await sheets.fetchTabs(cfg);
      db().clients = r.clients;
      if (!r.missingMachineTab) db().machines = r.machines;
      if (r.makers) db().makers = r.makers;
      cfg.lastSync = new Date().toISOString();
      const problems = [];
      if (r.machineError) problems.push(`Machine list not updated: ${r.machineError}. Columns found: ${r.machineHeader.join(', ') || 'none'}`);
      else if (r.missingMachineTab) problems.push(`Tab "${cfg.machineTab}" not found – machine list not updated`);
      if (r.makersError) problems.push(`"Entry by" names not updated: ${r.makersError}`);
      cfg.lastError = problems.length ? 'Clients updated. ' + problems.join(' · ') : '';
      store.save();
      return { clients: r.clients.length, machines: db().machines.length, makers: db().makers.length, warning: cfg.lastError };
    } catch (e) {
      cfg.lastError = e.message;
      store.save();
      return { error: e.message };
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

// ---------- staff (helper / installation person) login ----------
app.get('/api/staff/home', need('staff'), (req, res) => {
  const p = req.user.account;
  const t = today();
  const mine = db()
    .assignments.filter((a) => a.personId === p.id && a.date >= t)
    .sort((a, b) => a.date.localeCompare(b.date));
  const jobs = mine
    .map((a) => {
      const d = db().deliveries.find((x) => x.id === a.deliveryId);
      if (!d) return null;
      const v = deliveryView(d);
      return { ...v, myRole: a.role, extra: !!a.extra, unit: unitView(db().units.find((u) => u.id === d.unitId)) };
    })
    .filter(Boolean);
  const month = t.slice(0, 7);
  const monthDuties = db().assignments.filter((a) => a.personId === p.id && a.date.startsWith(month)).length;
  const leaves = db().leaves.filter((l) => l.personId === p.id && l.to >= t);
  const monthExpense = db()
    .deliveries.filter((d) => d.status === 'done' && d.date.startsWith(month) && d.allowance && d.allowance.applies && d.allowance.people.includes(p.id))
    .reduce((n, d) => n + (d.allowance.perPerson || 0), 0);
  res.json({ today: t, me: personView(p), jobs, monthDuties, monthExpense, leaves });
});

// ---------- admin ----------
const admin = express.Router();
admin.use(need('admin'));

admin.get('/data', (req, res) => {
  const t = today();
  const from = isValid(req.query.from) ? req.query.from : t;
  let to = isValid(req.query.to) ? req.query.to : addDays(t, 13);
  if (to < from) to = from;
  if (range(from, to).length > 92) to = addDays(from, 91);
  res.json({
    today: t,
    from,
    to,
    asmRequests: db().assemblyRequests.filter((r) => r.status === 'pending').length, // alert for the admin
    settings: db().settings,
    units: db().units.filter((u) => !u.deleted).map(unitView),
    people: db().people.filter((p) => !p.deleted).map(personView),
    allUnits: db().units.map((u) => ({ id: u.id, name: u.name })),
    allPeople: db().people.map((p) => ({ id: p.id, name: p.name, role: p.role })),
    leaves: db().leaves.slice().sort((a, b) => (a.from < b.from ? 1 : -1)),
    deliveries: db()
      .deliveries.filter((d) => d.date >= from && d.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || a.session.localeCompare(b.session) || unitName(a.unitId).localeCompare(unitName(b.unitId)))
      .map(deliveryView),
  });
});

admin.get('/search', (req, res) => {
  const list = searchJobs(db().deliveries, str(req.query.q, 100), str(req.query.type));
  res.json({ today: today(), results: list.map(deliveryView) });
});

admin.get('/stats', (req, res) => {
  const t = today();
  const from = isValid(req.query.from) ? req.query.from : addDays(t, -29);
  const to = isValid(req.query.to) ? req.query.to : addDays(t, 30);
  const list = db().assignments.filter((a) => a.date >= from && a.date <= to);
  const people = db().people.filter((p) => !p.deleted);
  const units = db().units.filter((u) => !u.deleted);
  const rows = people.map((p) => {
    const all = list.filter((a) => a.personId === p.id);
    const mine = all.filter((a) => a.role !== 'loader'); // deliveries + services (loading counted on its own)
    const perUnit = {};
    for (const u of units) perUnit[u.id] = mine.filter((a) => a.unitId === u.id).length;
    const leaveDays = range(from, to).filter((date) => S.onLeave(db(), p.id, date)).length;
    return {
      personId: p.id,
      name: p.name,
      role: p.role,
      backup: !!p.backup,
      unitName: unitName(p.unitId),
      active: p.active,
      total: mine.length,
      helper: mine.filter((a) => a.role === 'helper').length,
      installer: mine.filter((a) => a.role === 'installer').length,
      emergency: mine.filter((a) => a.extra).length,
      loading: all.filter((a) => a.role === 'loader').length,
      leaveDays,
      perUnit,
    };
  });
  const deliveries = db().deliveries.filter((d) => d.date >= from && d.date <= to && d.status !== 'cancelled').length;
  const unfilled = list.filter((a) => !a.personId).length;
  const completed = db()
    .deliveries.filter((d) => d.date >= from && d.date <= to && d.status === 'done')
    .sort((a, b) => (a.completedAt || '').localeCompare(b.completedAt || ''))
    .map((d) => ({
      id: d.id,
      type: d.type || 'delivery',
      unitId: d.unitId,
      unitName: unitName(d.unitId),
      date: d.date,
      customer: d.customer || '',
      createdAt: d.createdAt || null,
      startedAt: d.startedAt || null,
      completedAt: d.completedAt || null,
      allowance: d.allowance && d.allowance.applies ? d.allowance : null,
    }));
  // Expense to pay each person for completed jobs in these dates.
  const pay = {};
  for (const c of completed) {
    if (!c.allowance) continue;
    for (const id of c.allowance.people) {
      const r = (pay[id] = pay[id] || { personId: id, name: (db().people.find((p) => p.id === id) || {}).name || '?', jobs: 0, paidJobs: 0, amount: 0 });
      r.jobs++;
      if (c.allowance.perPerson) { r.paidJobs++; r.amount += c.allowance.perPerson; }
    }
  }
  const expenses = Object.values(pay).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const noStart = completed.filter((c) => c.allowance && c.allowance.minutes == null).length;
  const pending = db().deliveries.filter((d) => d.date < t && S.isOpen(d)).length;
  res.json({ from, to, units: units.map((u) => ({ id: u.id, name: u.name })), rows, deliveries, unfilled, completed, pending, expenses, noStart });
});

function readUnit(body, existing) {
  const name = str(body.name, 80);
  if (!name) return { error: 'Unit name is required' };
  const username = norm(body.username) || name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!/^[a-z0-9._@-]{3,40}$/.test(username)) return { error: 'Login ID must be 3-40 letters/numbers (no spaces)' };
  if (db().units.some((u) => !u.deleted && u !== existing && (u.username || '').toLowerCase() === username)) {
    return { error: 'Another unit already uses this login ID' };
  }
  const password = String(body.password || '');
  if (!existing && password.length < 4) return { error: 'Password must be at least 4 characters' };
  if (existing && password && password.length < 4) return { error: 'Password must be at least 4 characters' };
  return {
    value: {
      name,
      username,
      contactName: str(body.contactName, 80),
      phone: str(body.phone, 30),
      address: str(body.address, 300),
      active: body.active !== false,
    },
    password,
  };
}

function readPerson(body, existing) {
  const name = str(body.name, 80);
  if (!name) return { error: 'Name is required' };
  const role = str(body.role);
  if (!S.ROLES.includes(role)) return { error: 'Choose helper or installation person' };
  const unitId = str(body.unitId);
  if (unitId && !db().units.some((u) => u.id === unitId && !u.deleted)) return { error: 'Choose a unit' };
  const phone = str(body.phone, 30);
  const username = norm(body.username) || phone.replace(/\D/g, '');
  const password = String(body.password || '');
  if (password && password.length < 4) return { error: 'Password/PIN must be at least 4 characters' };
  const wantsLogin = password || (existing && existing.passHash);
  if (wantsLogin) {
    if (!/^[a-z0-9._@-]{3,40}$/.test(username)) return { error: 'Login ID must be 3-40 letters/numbers (no spaces), or enter a phone number' };
    if (db().people.some((p) => !p.deleted && p !== existing && p.passHash && (p.username || '').toLowerCase() === username)) {
      return { error: 'Another person already uses this login ID' };
    }
  }
  return {
    // Contractor (paid per production) or Payroll (gets incentive) – used for rates later
    value: { name, phone, username, role, unitId, backup: !!body.backup, active: body.active !== false, incentiveCut: Math.max(0, Math.min(100, Number(body.incentiveCut) || 0)), payType: ['contractor', 'payroll'].includes(str(body.payType)) ? str(body.payType) : '' },
    password,
  };
}

admin.post('/units', (req, res) => {
  const r = readUnit(req.body);
  if (r.error) return bad(res, r.error);
  db().units.push({ id: newId('unit'), ...r.value, passHash: auth.hashPassword(r.password), createdAt: today() });
  changed();
  res.json({ ok: true });
});

admin.put('/units/:id', (req, res) => {
  const u = db().units.find((x) => x.id === req.params.id && !x.deleted);
  if (!u) return res.status(404).json({ error: 'Unit not found' });
  const r = readUnit(req.body, u);
  if (r.error) return bad(res, r.error);
  Object.assign(u, r.value);
  if (r.password) u.passHash = auth.hashPassword(r.password);
  changed();
  res.json({ ok: true });
});

admin.delete('/units/:id', (req, res) => {
  const u = db().units.find((x) => x.id === req.params.id && !x.deleted);
  if (!u) return res.status(404).json({ error: 'Unit not found' });
  u.deleted = true; // keep history readable
  u.active = false;
  for (const d of db().deliveries) if (d.unitId === u.id && d.date >= today()) d.status = 'cancelled';
  db().assignments = db().assignments.filter((a) => !(a.unitId === u.id && a.date >= today()));
  changed();
  res.json({ ok: true });
});

admin.post('/people', (req, res) => {
  const r = readPerson(req.body);
  if (r.error) return bad(res, r.error);
  const p = { id: newId('per'), ...r.value, passHash: r.password ? auth.hashPassword(r.password) : null, baseline: 0, createdAt: today() };
  db().people.push(p);
  if (p.active) S.alignBaseline(db(), p);
  if (p.active && p.role === 'leader') require('./lib/assembly').alignLeader(db(), p);
  changed();
  res.json({ ok: true });
});

admin.put('/people/:id', (req, res) => {
  const p = db().people.find((x) => x.id === req.params.id && !x.deleted);
  if (!p) return res.status(404).json({ error: 'Person not found' });
  const r = readPerson(req.body, p);
  if (r.error) return bad(res, r.error);
  const wasActive = p.active;
  const wasRole = p.role;
  Object.assign(p, r.value);
  if (r.password) p.passHash = auth.hashPassword(r.password);
  if (req.body.removeLogin) p.passHash = null;
  if (!wasActive && p.active) S.alignBaseline(db(), p);
  // became a team leader or came back: start level with the other leaders
  if (p.active && p.role === 'leader' && (!wasActive || wasRole !== 'leader')) require('./lib/assembly').alignLeader(db(), p);
  changed();
  res.json({ ok: true });
});

admin.delete('/people/:id', (req, res) => {
  const p = db().people.find((x) => x.id === req.params.id && !x.deleted);
  if (!p) return res.status(404).json({ error: 'Person not found' });
  p.deleted = true;
  p.active = false;
  changed();
  res.json({ ok: true });
});

admin.post('/leaves', (req, res) => {
  const personId = str(req.body.personId);
  const from = str(req.body.from);
  const to = str(req.body.to) || from;
  if (!db().people.some((p) => p.id === personId && !p.deleted)) return bad(res, 'Choose a person');
  if (!isValid(from) || !isValid(to) || to < from) return bad(res, 'Choose valid dates');
  db().leaves.push({ id: newId('lv'), personId, from, to, reason: str(req.body.reason, 200) });
  changed();
  res.json({ ok: true });
});

admin.delete('/leaves/:id', (req, res) => {
  db().leaves = db().leaves.filter((l) => l.id !== req.params.id);
  changed();
  res.json({ ok: true });
});

function anyDelivery(req, res) {
  const d = db().deliveries.find((x) => x.id === req.params.id);
  if (!d) res.status(404).json({ error: 'Delivery not found' });
  return d;
}

admin.post('/deliveries', (req, res) => send(res, createDelivery(req.body, str(req.body.unitId), 'admin')));
admin.put('/deliveries/:id', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, updateDelivery(d, req.body)); });
admin.post('/deliveries/:id/cancel', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, cancelDelivery(d)); });
admin.get('/deliveries/:id/people', (req, res) => { const d = anyDelivery(req, res); if (d) res.json({ people: peopleFor(d) }); });
admin.post('/deliveries/:id/extra', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, addExtra(d, req.body, 'admin')); });
admin.post('/deliveries/:id/extra/cancel', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, cancelExtra(d, req.body)); });
admin.post('/deliveries/:id/start', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, startDelivery(d, 'admin')); });
admin.post('/deliveries/:id/complete', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, completeDelivery(d, req.body, 'admin')); });
admin.post('/deliveries/:id/photos', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, addPhotos(d, req.body, 'admin')); });
admin.post('/deliveries/:id/photos/delete', (req, res) => {
  const d = anyDelivery(req, res);
  if (!d) return;
  const file = str(req.body.file);
  if (!(d.photos || []).some((p) => p.file === file)) return bad(res, 'Photo not found');
  d.photos = d.photos.filter((p) => p.file !== file);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, file)); } catch { /* already gone */ }
  store.save();
  res.json({ ok: true });
});
// Fix start / completed time (e.g. Start was not pressed); the expense is worked out again.
admin.post('/deliveries/:id/times', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, setTimes(d, req.body, 'admin')); });
admin.post('/deliveries/:id/reopen', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, reopenDelivery(d)); });
admin.post('/deliveries/:id/replace', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, replace(d, req.body, 'admin')); });

admin.post('/deliveries/:id/assign', (req, res) => {
  const d = anyDelivery(req, res);
  if (!d) return;
  if (d.date < today()) return bad(res, 'Past deliveries cannot be changed');
  if (!S.isOpen(d)) return bad(res, 'This job is completed or cancelled');
  try {
    S.setManual(db(), d.id, str(req.body.role), Number(req.body.slot), str(req.body.personId));
  } catch (e) {
    return bad(res, e.message);
  }
  store.save();
  res.json({ ok: true });
});

admin.post('/rebalance', (req, res) => {
  const t = today();
  const from = isValid(req.body.from) ? req.body.from : addDays(t, 1);
  if (from < t) return bad(res, 'Past days cannot be changed');
  S.rebalanceFrom(db(), from, req.body.keepManual !== false);
  store.save();
  res.json({ ok: true });
});

admin.put('/settings', (req, res) => {
  const s = db().settings;
  const b = req.body;
  if (b.orgName !== undefined) s.orgName = str(b.orgName, 80) || 'Well Worth Delivery Team';
  if (b.timezone !== undefined) {
    try {
      todayIn(str(b.timezone));
      s.timezone = str(b.timezone);
    } catch {
      return bad(res, 'Unknown time zone');
    }
  }
  if (b.allowance && typeof b.allowance === 'object') {
    s.allowance = {
      appliesTo: b.allowance.appliesTo === 'service' ? 'service' : 'all',
      slabs: allowance.cleanSlabs(b.allowance.slabs),
      deliverySlabs: allowance.cleanSlabs(b.allowance.deliverySlabs !== undefined ? b.allowance.deliverySlabs : (s.allowance || {}).deliverySlabs),
    };
    if (b.allowance.recalcFrom && isValid(b.allowance.recalcFrom)) {
      for (const d of db().deliveries) if (d.status === 'done' && d.date >= b.allowance.recalcFrom) setAllowance(d);
    }
  }
  if (b.defaultHelpers !== undefined) s.defaultHelpers = Math.max(0, Math.min(S.MAX_HELPERS, parseInt(b.defaultHelpers, 10) || 2));
  store.save();
  res.json({ ok: true });
});

admin.get('/sheet', (req, res) => {
  const c = db().sheet;
  res.json({
    ...c,
    clients: db().clients.length,
    machines: db().machines.length,
    sampleClients: db().clients.slice(0, 5),
    machineList: db().machines.map((m) => m.label),
    makers: db().makers.length,
    makerList: db().makers,
  });
});

admin.put('/sheet', async (req, res) => {
  const c = db().sheet;
  const b = req.body;
  const url = str(b.scriptUrl, 500);
  if (url && !/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return bad(res, 'The Apps Script URL should start with https://script.google.com/');
  c.scriptUrl = url;
  if (b.key !== undefined && str(b.key, 100)) c.key = str(b.key, 100);
  c.sheetLink = str(b.sheetLink, 500);
  c.partyTab = str(b.partyTab, 60) || 'Party';
  c.machineTab = str(b.machineTab, 60) || 'Machines';
  if (b.makersTab !== undefined) c.makersTab = str(b.makersTab, 60); // empty = no "Entry by" list
  if (b.makersColumn !== undefined) c.makersColumn = str(b.makersColumn, 60) || 'Made By';
  store.save();
  const r = await syncSheet();
  if (r.error) return bad(res, 'Saved, but sync failed: ' + r.error);
  res.json({ ok: true, ...r });
});

admin.post('/sheet/sync', async (req, res) => {
  const r = await syncSheet();
  if (r.error) return bad(res, r.error);
  res.json({ ok: true, ...r });
});

admin.post('/password', (req, res) => {
  const a = req.user.account;
  if (!auth.verifyPassword(String(req.body.current || ''), a.passHash)) return bad(res, 'Current password is wrong');
  const next = String(req.body.next || '');
  if (next.length < 6) return bad(res, 'New password must be at least 6 characters');
  const username = norm(req.body.username);
  if (username) a.username = username;
  a.passHash = auth.hashPassword(next);
  store.save();
  res.json({ ok: true });
});

admin.get('/backup', (req, res) => {
  const { secret, ...rest } = db();
  res.setHeader('Content-Disposition', `attachment; filename="delivery-team-backup-${today()}.json"`);
  res.json(rest);
});

admin.post('/restore', (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.units) || !Array.isArray(data.people) || !Array.isArray(data.admins) || !data.admins.length) {
    return bad(res, 'This does not look like a backup file');
  }
  store.replace(data);
  res.json({ ok: true });
});

// ---------- assembly ----------
const ASM = require('./lib/assembly');
ASM.assignWaiting(db(), db().settings.timezone); // on start: give out anything still waiting
{
  // Dispatch incentive moved to its own list: copy amounts typed in the old "Dispatch ₹" column once.
  const a = db().settings.assembly;
  if (a && !a.dispatchIncentives) {
    a.dispatchIncentives = (a.incentives || []).filter((x) => Number(x.dispatch) > 0).map((x) => ({ model: x.model, amount: Number(x.dispatch) }));
    store.save();
  }
}
const personName = (id) => (db().people.find((p) => p.id === id) || {}).name || '';
const personBrief = (id) => {
  const p = db().people.find((x) => x.id === id);
  return p ? { id: p.id, name: p.name, phone: p.phone || '', unitName: unitName(p.unitId) } : null;
};
function asmView(m) {
  return {
    id: m.id,
    noRate: !ASM.hasRate(db(), m.model, 'assembly'),
    creator: ASM.creatorOf(db(), m),
    unitId: m.unitId,
    unitName: unitName(m.unitId),
    asmUnitId: ((m.transfers || [])[0] || {}).from || m.unitId,
    model: m.model,
    status: m.status,
    source: m.source || 'new',
    leader: personBrief(m.leaderId),
    installer: personBrief(m.installerId),
    helper: personBrief(m.helperId),
    createdAt: m.createdAt || null,
    createdBy: m.createdBy || '',
    entryBy: m.entryBy || '',
    assignedAt: m.assignedAt || null,
    startedAt: m.startedAt || null,
    completedAt: m.completedAt || null,
    timesEditedBy: m.timesEditedBy || '',
    incentive: m.incentive || null,
    note: m.note || '',
    photos: (m.photos || []).map((p) => ({ url: '/api/photos/' + p.file, at: p.at })),
    location: m.location || '',
    modelEdits: (m.modelEdits || []).map((x) => ({ from: x.from, to: x.to, by: x.by, at: x.at })),
    crewEdits: (m.crewEdits || []).map((x) => ({ by: x.by, at: x.at, from: x.from, to: x.to })),
    dispatchParty: m.dispatchParty || '',
    dispatchedAt: m.dispatchedAt || null,
    dispatchIncentive: m.dispatchIncentive || null,
    transfers: (m.transfers || []).map((x) => ({ from: unitName(x.from), to: unitName(x.to), at: x.at, by: x.by })),
    bookedParty: m.bookedParty || '',
    dispatchPhotos: (m.dispatchPhotos || []).map((p) => ({ url: '/api/photos/' + p.file, at: p.at, kind: p.kind })),
    diverts: (m.diverts || []).map((x) => ({ from: personName(x.from), to: personName(x.to), at: x.at, reason: x.reason || '' })),
  };
}
const asmSettings = () => ASM.settings(db());
// Incentive reduction % per team leader / dispatch login (e.g. 10%). Only the team leader's share
// and the dispatch incentive are reduced – installation persons and helpers never are.
const cutOf = (acc) => Math.max(0, Math.min(100, Number(acc && acc.incentiveCut) || 0));
function asmIncentive(model, leaderId) {
  const inc = { ...ASM.incentiveFor(db(), model) };
  const cut = cutOf(db().people.find((p) => p.id === leaderId));
  if (cut) { inc.leaderFull = inc.leader; inc.leader = Math.round((inc.leader * (100 - cut)) / 100); inc.leaderCut = cut; }
  return inc;
}
function dispatchCut(amount, dispatcherId) {
  const cut = cutOf(db().dispatchers.find((d) => d.id === dispatcherId));
  return cut ? Math.round((amount * (100 - cut)) / 100) : amount;
}
// One time: 10% reduction for the 814 team leaders Satish, Tamanna, Sandeep (and their dispatch logins).
if (!db().settings.cut814v1) {
  const names = ['SATISH', 'TAMANNA', 'SANDEEP'];
  const u814 = db().units.find((u) => !u.deleted && String(u.name).trim() === '814');
  for (const p of db().people) if (u814 && p.unitId === u814.id && p.role === 'leader' && !p.deleted && names.includes(String(p.name).trim().toUpperCase()) && !p.incentiveCut) p.incentiveCut = 10;
  for (const d of db().dispatchers) if (!d.deleted && names.includes(String(d.name).trim().toUpperCase()) && !d.incentiveCut) d.incentiveCut = 10;
  db().settings.cut814v1 = true;
  store.save();
}
// Transfer bonus cut to 50%: switch the saved slabs over once, unless the admin had changed them.
{
  const a = db().settings.assembly;
  if (a && JSON.stringify(a.unitDispatchSlabs) === JSON.stringify(ASM.OLD_UNIT_SLABS)) { a.unitDispatchSlabs = ASM.DEFAULT_SETTINGS.unitDispatchSlabs; store.save(); }
}
// Typed model no. -> the name in the machine list, so "FT24BK" is saved as "FT~24BK (DUAL SUCTION POINT)".
// Exact match (ignoring ~, spaces, case) first; then the model part before the brackets, only if
// that points to one machine. Otherwise it is kept as typed.
// Every model no. entered must have an incentive rate (assembly or dispatch list), so a typing
// mistake like "T15~CH3" for "TP150~CH3" is caught at once.
// which = 'assembly': machines to assemble need an assembly rate; 'any': godown stock needs an
// assembly or a dispatch rate.
function rateMissing(model, which = 'assembly') {
  if (!model || ASM.hasRate(db(), model, which)) return '';
  return `No ${which === 'assembly' ? 'assembly ' : ''}incentive is set for model "${model}". Pick the exact model name from the list – entry is allowed only for models that have an incentive rate. If it is a new model, the admin or a team leader must add its rate first.`;
}
function canonModel(typed) {
  const t = str(typed, 120);
  if (!t) return t;
  // a name in the incentive lists wins, so what is saved matches the rate exactly
  const s = asmSettings();
  const rateName = [...(s.incentives || []), ...(s.dispatchIncentives || []), ...((db().settings.fab && db().settings.fab.contractorRates) || [])].map((x) => x.model).find((m) => ASM.sameRate(m, t));
  if (rateName) return rateName;
  const list = db().machines.map((m) => m.label).filter(Boolean);
  const exact = list.find((l) => ASM.key(l) === ASM.key(t));
  if (exact) return exact;
  const base = ASM.baseKey(t);
  const hits = list.filter((l) => ASM.baseKey(l) === base);
  return hits.length === 1 ? hits[0] : t;
}
function asmAssign() {
  ASM.assignWaiting(db(), db().settings.timezone);
}
// Who raised it: a name from the sheet's Made By column when that list exists.
function readEntry(body) {
  let entryBy = str(body.entryBy, 80);
  if (!entryBy) return { error: 'Choose who is raising this request (Entry by)' };
  if (db().makers.length) {
    const hit = db().makers.find((n) => n.toLowerCase() === entryBy.toLowerCase());
    if (!hit) return { error: `"${entryBy}" is not in the Made By list – choose a name from the list` };
    entryBy = hit;
  }
  return { value: entryBy };
}
function addMachines(unitId, body, by, creator) {
  if (!liveUnit(unitId)) return { error: 'Choose a unit' };
  const model = canonModel(body.model);
  if (!model) return { error: 'Enter the model no.' };
  { const miss = rateMissing(model); if (miss) return { error: miss }; }
  const qty = parseInt(body.qty, 10);
  if (!(qty >= 1 && qty <= 50)) return { error: 'Quantity must be 1 to 50' };
  // a team leader's own login is the entry (no "Entry by" list needed)
  const e = creator && creator.role === 'staff' ? { value: by } : readEntry(body);
  if (e.error) return e;
  const now = new Date().toISOString();
  for (let i = 0; i < qty; i++) {
    db().assembly.push({ id: newId('asm'), unitId, model, status: 'waiting', source: 'new', createdAt: now, createdBy: by, creator: creator || (by === 'admin' ? { role: 'admin', id: 'admin' } : { role: 'unit', id: unitId }), entryBy: e.value, note: str(body.note, 200) });
  }
  asmAssign();
  store.save();
  return { value: { id: '' } };
}
// Start / end times typed in (or now). Assembly can take a few days.
function asmTimes(m, body, needStart) {
  const iso = (v) => { const x = new Date(String(v || '')); return isNaN(x) ? null : x.toISOString(); };
  const started = body.startedAt ? iso(body.startedAt) : m.startedAt || null;
  const completed = body.completedAt ? iso(body.completedAt) : new Date().toISOString();
  if (body.startedAt && !iso(body.startedAt)) return { error: 'Start time is not valid' };
  if (body.completedAt && !iso(body.completedAt)) return { error: 'End time is not valid' };
  if (needStart && !started) return { error: 'Start date and time are compulsory' };
  if (started && started >= completed) return { error: 'Start must be before the end' };
  if (completed > new Date(Date.now() + 5 * 60000).toISOString()) return { error: 'End time cannot be in the future' };
  if (started && Date.parse(completed) - Date.parse(started) > 60 * 86400000) return { error: 'Assembly time cannot be more than 60 days' };
  return { value: { started, completed } };
}
function asmStart(m, by) {
  if (m.status !== 'assigned') return { error: m.status === 'waiting' ? 'No team leader yet' : 'Already started or finished' };
  m.status = 'started';
  m.startedAt = new Date().toISOString();
  m.startedBy = by;
  store.save();
  return { value: m };
}
// Where the machine is after assembly: in the godown or dispatched to a client.
// Assembled machines go into godown stock; dispatch to a client is done only from the
// Dispatch login (Send from godown), so it is never accepted here.
function readLocation(body) {
  const location = str(body.location) || 'godown';
  if (location !== 'godown') return { error: 'Dispatch to a client is done from the Dispatch login, after the machine is in the godown' };
  return { value: { location, godownAt: new Date().toISOString() } };
}
// Correct a wrong model no. `scope` = machines that may change together ("same model" tick box).
function asmEditModel(m, body, by, scope, user) {
  if (user && !ASM.canEditModel(db(), user, m)) return { error: 'Only the login that made this entry (or the admin) can correct the model no.' };
  const model = canonModel(body.model);
  if (!model) return { error: 'Enter the model no.' };
  { const miss = rateMissing(model); if (miss) return { error: miss }; }
  if (by !== 'admin' && !['waiting', 'assigned', 'started'].includes(m.status)) return { error: 'Assembled machines can be corrected by the admin only' };
  const old = m.model;
  if (model === old) return { error: 'The model no. is the same' };
  const list = body.all ? db().assembly.filter((x) => x.model === old && scope(x) && (!user || ASM.canEditModel(db(), user, x)) && (by === 'admin' || ['waiting', 'assigned', 'started'].includes(x.status))) : [m];
  const at = new Date().toISOString();
  for (const x of list) {
    (x.modelEdits = x.modelEdits || []).push({ from: old, to: model, by, at });
    x.model = model;
    if (x.status === 'done') x.incentive = asmIncentive(model, x.leaderId); // incentive follows the right model
  }
  store.save();
  return { value: { id: m.id, count: list.length } };
}

function asmDispatch(m, body, by) {
  if (m.status !== 'done') return { error: 'Only assembled machines can be dispatched' };
  if (m.location === 'dispatched') return { error: 'Already dispatched' };
  if (!str(body.party)) return { error: 'Client name is compulsory' };
  m.location = 'dispatched';
  m.dispatchParty = str(body.party, 120);
  m.dispatchedAt = new Date().toISOString();
  m.dispatchedBy = by;
  store.save();
  return { value: m };
}

// An installation person may have at most N machines not assembled yet (Assembly settings).
function installerLimit(person, adding) {
  const max = Math.max(1, Number(asmSettings().maxInstallerPending) || 10);
  const now = ASM.installerOpen(db(), person.id);
  if (adding <= 0 || now + adding <= max) return '';
  return `${person.name} already has ${now} machine${now === 1 ? '' : 's'} pending (max ${max}). Ask them to finish some machines first, then you can give ${adding > 1 ? 'these' : 'this one'} to them.`;
}

function asmComplete(m, body, by) {
  if (!['assigned', 'started'].includes(m.status)) return { error: 'This machine is not open' };
  const t = asmTimes(m, body, true);
  if (t.error) return t;
  // Photo of the machine sticker is compulsory (the admin may skip it).
  const ph = readPhotos(m, body.photos);
  if (ph.error) return ph;
  if (!ph.value.length && !(m.photos || []).length && by !== 'admin') return { error: 'Take a photo (JPG) of the machine sticker first' };
  const loc = readLocation(body);
  if (loc.error) return loc;
  savePhotos(m, ph.value, by);
  Object.assign(m, loc.value);
  if (body.startedAt && t.value.started !== m.startedAt) m.timesEditedBy = by;
  if (body.completedAt) m.timesEditedBy = by;
  m.startedAt = t.value.started;
  m.completedAt = t.value.completed;
  m.status = 'done';
  m.completedBy = by;
  m.incentive = asmIncentive(m.model, m.leaderId);
  asmAssign(); // the leader may now be under the pending limit
  store.save();
  return { value: m };
}
function asmFind(req, res, check) {
  const m = db().assembly.find((x) => x.id === req.params.id);
  if (!m || (check && !check(m))) { res.status(404).json({ error: 'Machine not found' }); return null; }
  return m;
}
// The unit where a machine was assembled (it may later be transferred to another unit's godown).
const asmUnitOf = (m) => ((m.transfers || [])[0] || {}).from || m.unitId;
// Assembled and still in the godown of the unit that assembled it (not transferred, not dispatched).
const inOwnGodown = (m) => m.status === 'done' && m.location === 'godown' && !(m.transfers || []).length;
const asmList = (filter) => db().assembly.filter(filter).sort((a, b) => (a.status === 'done') - (b.status === 'done') || (b.completedAt || b.createdAt || '').localeCompare(a.completedAt || a.createdAt || '')).map(asmView);
const recentDone = (m, days = 30) => m.status !== 'done' || (m.completedAt || '') >= new Date(Date.now() - days * 86400000).toISOString();
const monthOf = (q) => (/^\d{4}-\d{2}$/.test(String(q || '')) ? q : today().slice(0, 7));

// Scoreboard: every login can see it, so people can compare.
app.get('/api/assembly/board', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  const b = ASM.board(db(), monthOf(req.query.month));
  // Divert deductions are known only to the admin: everyone else sees the incentive already
  // reduced, with no deduction amount or count.
  if (req.user.role !== 'admin') b.leaders = b.leaders.map(({ deduction, diverted, ...r }) => ({ ...r, incentive: r.incentive - (deduction || 0) }));
  res.json(b);
});

// Unit
unit.get('/assembly', (req, res) => {
  res.json({
    // assembly work of this unit: machines assembled here (not ones transferred in, not old stock)
    // open work only – assembled machines are shown to the admin only
    // open work + assembled machines still in this unit's godown (gone once transferred or dispatched)
    items: asmList((m) => asmUnitOf(m) === req.user.id && m.source !== 'stock' && (!['cancelled', 'done', 'arrived'].includes(m.status) || inOwnGodown(m))),
    arrived: arrivedOf(req.user.id),
    leaders: ASM.leadersOf(db(), req.user.id).map((p) => ({ id: p.id, name: p.name, pending: ASM.pendingOf(db(), p.id) })),
    maxPending: asmSettings().maxPending,
  });
});
// New machines and old stock are entered from the team leader's own login (so every entry has a name).
unit.post('/assembly', (req, res) => bad(res, 'New machines are entered by a team leader from their own login'));
unit.post('/assembly/:id/start', (req, res) => { const m = asmFind(req, res, (x) => x.unitId === req.user.id); if (m) send(res, asmStart(m, 'unit')); });
unit.post('/assembly/:id/model', (req, res) => { const m = asmFind(req, res, (x) => x.unitId === req.user.id); if (m) send(res, asmEditModel(m, req.body, 'unit', (x) => x.unitId === req.user.id, req.user)); });
unit.post('/assembly/:id/dispatch', (req, res) => bad(res, 'Dispatch is done from the Dispatch login'));
unit.get('/assembly/stock', (req, res) => res.json({
  stock: ASM.stock(db(), req.user.id),
  // this unit's own wrong entries (no incentive rate) that are now in another unit's godown
  toFix: ASM.stock(db(), null, (m) => m.unitId !== req.user.id && !ASM.hasRate(db(), m.model) && ASM.canEditModel(db(), req.user, m)),
}));
unit.post('/assembly/:id/complete', (req, res) => { const m = asmFind(req, res, (x) => x.unitId === req.user.id); if (m) send(res, asmComplete(m, req.body, 'unit')); });

// Staff (team leader / installation person / helper)
app.get('/api/staff/assembly', need('staff'), (req, res) => {
  const p = req.user.account;
  res.json({
    isLeader: p.role === 'leader',
    // own machines, plus machines this leader entered (so a wrong entry can be corrected)
    // open work only (assembled machines: admin only)
    arrived: p.role === 'leader' ? arrivedOf(p.unitId) : [],
    items: asmList((m) => (!['cancelled', 'done', 'arrived'].includes(m.status) || (p.role === 'leader' && m.leaderId === p.id && inOwnGodown(m))) && (m.leaderId === p.id || m.installerId === p.id || m.helperId === p.id || (m.creator && m.creator.role === 'staff' && m.creator.id === p.id))),
    unitId: p.unitId,
    unitName: unitName(p.unitId),
    stock: p.role === 'leader' ? ASM.stock(db(), p.unitId) : [],
    toFix: p.role === 'leader' ? ASM.stock(db(), null, (m) => m.unitId !== p.unitId && !ASM.hasRate(db(), m.model) && ASM.canEditModel(db(), req.user, m)) : [],
    requests: db().assemblyRequests.filter((r) => r.leaderId === p.id).slice(-20).reverse(),
    // For "Add old machine": installation persons and helpers of the leader's unit.
    crew: p.role === 'leader'
      ? db().people.filter((x) => x.active && !x.deleted && x.unitId === p.unitId && ['installer', 'helper', 'both'].includes(x.role)).map((x) => ({ id: x.id, name: x.name, role: x.role }))
      : [],
    pending: ASM.pendingOf(db(), p.id),
    maxPending: asmSettings().maxPending,
    // My own incentive this month (team leader share or installation share).
    myMonth: (() => {
      const month = monthOf(req.query.month);
      const done = db().assembly.filter((m) => m.status === 'done' && (m.completedAt || '').slice(0, 7) === month);
      const asLeader = done.filter((m) => m.leaderId === p.id);
      const asInst = done.filter((m) => m.installerId === p.id);
      const asHelp = done.filter((m) => m.helperId === p.id);
      return {
        month,
        machines: asLeader.length + asInst.length + asHelp.length,
        incentive: asLeader.reduce((n, m) => n + ((m.incentive && m.incentive.leader) || 0), 0) + asInst.reduce((n, m) => n + ((m.incentive && m.incentive.installer) || 0), 0) - ASM.deductionsOf(db(), p.id, month),
        // installation persons / helpers: every machine they worked on this month, to check their incentive
        list: p.role === 'leader' ? [] : done.filter((m) => m.installerId === p.id || m.helperId === p.id)
          .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
          .map((m) => {
            const asI = m.installerId === p.id;
            return { at: m.completedAt, model: m.model, leader: personName(m.leaderId), role: asI ? 'Installation' : 'Helper', amount: asI ? (m.incentive && m.incentive.installer) || 0 : 0 };
          }),
      };
    })(),
  });
});
const myMachine = (req) => (m) => m.leaderId === req.user.id;
// Team leader enters new machines for assembly and old stock for their unit's godown.
app.post('/api/staff/assembly/machines', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'leader') return bad(res, 'Only team leaders can enter machines');
  send(res, addMachines(p.unitId, req.body, p.name, { role: 'staff', id: p.id }));
});
app.post('/api/staff/assembly/stock', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'leader') return bad(res, 'Only team leaders can add stock');
  send(res, addOldStock({ ...req.body, unitId: p.unitId, kind: 'godown', party: '' }, p.name, 'staff', { role: 'staff', id: p.id }));
});
app.post('/api/staff/assembly/:id/start', need('staff'), (req, res) => { const m = asmFind(req, res, myMachine(req)); if (m) send(res, asmStart(m, req.user.account.name)); });
// Team leader changes the installation person / helper on their own open machines.
app.post('/api/staff/assembly/:id/crew', need('staff'), (req, res) => {
  const p = req.user.account;
  const m = asmFind(req, res, myMachine(req));
  if (!m) return;
  if (!['assigned', 'started'].includes(m.status)) return bad(res, 'Only machines not assembled yet');
  const pick = (id, roles) => db().people.find((x) => x.id === id && x.active && !x.deleted && x.unitId === p.unitId && roles.includes(x.role));
  const inst = req.body.installerId ? pick(str(req.body.installerId), ['installer', 'both']) : null;
  const help = req.body.helperId ? pick(str(req.body.helperId), ['helper', 'both']) : null;
  if (req.body.installerId && !inst) return bad(res, 'Choose an installation person of your unit');
  if (req.body.helperId && !help) return bad(res, 'Choose a helper of your unit');
  if (inst && help && inst.id === help.id) return bad(res, 'Installation person and helper must be different');
  const list = req.body.all ? db().assembly.filter((x) => x.leaderId === p.id && ['assigned', 'started'].includes(x.status)) : [m];
  if (inst) { const e = installerLimit(inst, list.filter((x) => x.installerId !== inst.id).length); if (e) return bad(res, e); }
  const at = new Date().toISOString();
  for (const x of list) {
    const before = { installer: personName(x.installerId), helper: personName(x.helperId) };
    if (inst) x.installerId = inst.id;
    if (help) x.helperId = help.id;
    (x.crewEdits = x.crewEdits || []).push({ by: p.name, at, from: before, to: { installer: personName(x.installerId), helper: personName(x.helperId) } });
  }
  store.save();
  res.json({ ok: true, count: list.length });
});

app.post('/api/staff/assembly/:id/model', need('staff'), (req, res) => { const m = asmFind(req, res, (x) => x.leaderId === req.user.id || ASM.canEditModel(db(), req.user, x)); if (m) send(res, asmEditModel(m, req.body, req.user.account.name, (x) => x.leaderId === req.user.id, req.user)); });
app.post('/api/staff/assembly/:id/dispatch', need('staff'), (req, res) => bad(res, 'Dispatch is done from the Dispatch login'));
app.post('/api/staff/assembly/:id/complete', need('staff'), (req, res) => { const m = asmFind(req, res, myMachine(req)); if (m) send(res, asmComplete(m, req.body, req.user.account.name)); });
// Team leader passes a machine to another team leader of the unit; ₹ per machine is
// taken off the diverting leader's incentive (Assembly settings → divert deduction).
app.get('/api/staff/assembly/leaders', need('staff'), (req, res) => {
  const p = req.user.account;
  const max = asmSettings().maxPending;
  res.json({
    penalty: asmSettings().divertPenalty,
    leaders: ASM.leadersOf(db(), p.unitId).filter((x) => x.id !== p.id).map((x) => ({ id: x.id, name: x.name, pending: ASM.pendingOf(db(), x.id), full: ASM.pendingOf(db(), x.id) >= max })),
  });
});
app.post('/api/staff/assembly/:id/divert', need('staff'), (req, res) => {
  const p = req.user.account;
  const m = asmFind(req, res, (x) => x.leaderId === p.id);
  if (!m) return;
  if (!['assigned', 'started'].includes(m.status)) return bad(res, 'Only machines not assembled yet can be diverted');
  const to = ASM.leadersOf(db(), m.unitId).find((x) => x.id === str(req.body.toLeaderId) && x.id !== p.id);
  if (!to) return bad(res, 'Choose another team leader of your unit');
  if (ASM.pendingOf(db(), to.id) >= asmSettings().maxPending) return bad(res, `${to.name} already has ${asmSettings().maxPending} pending machines`);
  const amount = Math.max(0, Number(asmSettings().divertPenalty) || 0);
  const at = new Date().toISOString();
  (m.diverts = m.diverts || []).push({ from: p.id, to: to.id, at, reason: str(req.body.reason, 150), amount });
  if (amount) db().assemblyDeductions.push({ id: newId('ded'), leaderId: p.id, machineId: m.id, model: m.model, amount, at, reason: 'Diverted to ' + to.name });
  m.leaderId = to.id;
  m.status = 'assigned';
  m.startedAt = null;
  m.assignedAt = at;
  m.manual = true; // keep it with the new leader
  asmAssign();
  store.save();
  res.json({ ok: true });
});

// Team leader adds an old machine that was missed out; counted after the admin approves.
app.post('/api/staff/assembly/old', need('staff'), (req, res) => {
  // Team leader adds an old machine that was missed out – added straight away (no approval).
  // Completed: end date-time, sticker photo and godown / dispatched are compulsory.
  // Still assembling: only the start; it shows in their list to finish later.
  const p = req.user.account;
  if (p.role !== 'leader') return bad(res, 'Only team leaders can add old machines');
  const model = canonModel(req.body.model);
  const qty = parseInt(req.body.qty, 10) || 1;
  if (!model) return bad(res, 'Enter the model no.');
  { const miss = rateMissing(model); if (miss) return bad(res, miss); }
  if (qty < 1 || qty > 10) return bad(res, 'Quantity must be 1 to 10');
  const completed = req.body.completed !== 'no';
  const crewOk = (id, roles) => !id || db().people.some((x) => x.id === id && !x.deleted && roles.includes(x.role));
  const installerId = str(req.body.installerId) || null;
  const helperId = str(req.body.helperId) || null;
  if (!crewOk(installerId, ['installer', 'both'])) return bad(res, 'Choose an installation person');
  if (!crewOk(helperId, ['helper', 'both'])) return bad(res, 'Choose a helper');
  let t;
  if (completed) {
    if (!req.body.completedAt) return bad(res, 'End date and time are compulsory for a completed machine');
    t = asmTimes({}, req.body, true);
  } else {
    t = asmTimes({}, { startedAt: req.body.startedAt }, true); // end = now just for the check
  }
  if (t.error) return bad(res, t.error);
  const loc = completed ? readLocation(req.body) : { value: {} };
  if (loc.error) return bad(res, loc.error);
  const ph = completed ? readPhotos({ photos: [] }, req.body.photos) : { value: [] };
  if (ph.error) return bad(res, ph.error);
  if (completed && !ph.value.length) return bad(res, 'Take a photo (JPG) of the machine sticker');
  const made = [];
  for (let i = 0; i < qty; i++) {
    const m = {
      id: newId('asm'), unitId: p.unitId, model, status: completed ? 'done' : 'started', source: 'old', leaderId: p.id, installerId, helperId,
      createdAt: new Date().toISOString(), assignedAt: t.value.started, startedAt: t.value.started, completedAt: completed ? t.value.completed : null,
      createdBy: p.name, entryBy: `${p.name} (old entry)`, timesEditedBy: p.name, note: str(req.body.note, 200), manual: true,
      ...(completed ? { incentive: asmIncentive(model, p.id), ...loc.value } : {}),
    };
    made.push(m);
    db().assembly.push(m);
  }
  if (completed) { savePhotos(made[0], ph.value, p.name); for (const m of made.slice(1)) m.photos = made[0].photos.slice(); }
  store.save();
  res.json({ ok: true });
});

app.post('/api/staff/assembly/request', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'leader') return bad(res, 'Only team leaders can request machines');
  const model = canonModel(req.body.model);
  const qty = parseInt(req.body.qty, 10);
  if (!model) return bad(res, 'Enter the model no.');
  { const miss = rateMissing(model); if (miss) return bad(res, miss); }
  if (!(qty >= 1 && qty <= 20)) return bad(res, 'Quantity must be 1 to 20');
  db().assemblyRequests.push({ id: newId('req'), leaderId: p.id, unitId: p.unitId, model, qty, note: str(req.body.note, 200), status: 'pending', createdAt: new Date().toISOString() });
  store.save();
  res.json({ ok: true });
});

// Admin
admin.get('/assembly', (req, res) => {
  const from = isValid(req.query.from) ? req.query.from : addDays(today(), -30);
  res.json({
    // admin only: the divert deduction amounts
    arrived: db().units.filter((u) => !u.deleted).map((u) => ({ unitId: u.id, unitName: u.name, models: arrivedOf(u.id) })).filter((u) => u.models.length),
    items: asmList((m) => !['cancelled', 'arrived'].includes(m.status) && (m.status !== 'done' || (m.completedAt || '').slice(0, 10) >= from))
      .map((v) => { const m = db().assembly.find((x) => x.id === v.id); return { ...v, diverts: v.diverts.map((d, i) => ({ ...d, amount: ((m.diverts || [])[i] || {}).amount || 0 })) }; }),
    requests: db().assemblyRequests.slice().reverse().filter((r) => r.status === 'pending' || (r.decidedAt || '') >= new Date(Date.now() - 14 * 86400000).toISOString())
      .map((r) => ({ ...r, leaderName: personName(r.leaderId), unitName: unitName(r.unitId), leaderPending: ASM.pendingOf(db(), r.leaderId), installerName: personName(r.installerId), helperName: personName(r.helperId) })),
    settings: asmSettings(),
    bonusUnits: ASM.bonusUnits(db()),
    reducedUnits: ASM.reducedDispatchUnits(db()),
    stock: ASM.stock(db()),
    dispatchers: db().dispatchers.filter((d) => !d.deleted).map((d) => ({ id: d.id, name: d.name, username: d.username, active: !!d.active, incentiveCut: d.incentiveCut || 0 })),
    leaders: db().people.filter((p) => p.role === 'leader' && p.active && !p.deleted).map((p) => ({ id: p.id, name: p.name, unitId: p.unitId, unitName: unitName(p.unitId), pending: ASM.pendingOf(db(), p.id) })),
  });
});
admin.post('/assembly', (req, res) => send(res, addMachines(str(req.body.unitId), req.body, 'admin')));
admin.post('/assembly/:id/start', (req, res) => { const m = asmFind(req, res); if (m) send(res, asmStart(m, 'admin')); });
// Admin corrects a wrong status: "Start" pressed by mistake -> back to not started;
// "Assembled" by mistake (machine still in the godown) -> back to assembling.
admin.post('/assembly/:id/undo', (req, res) => {
  const m = asmFind(req, res);
  if (!m) return;
  const at = new Date().toISOString();
  if (m.status === 'started') {
    (m.statusEdits = m.statusEdits || []).push({ from: 'started', to: 'assigned', by: 'admin', at, startedAt: m.startedAt });
    m.status = 'assigned';
    m.startedAt = null;
    m.startedBy = null;
  } else if (m.status === 'done') {
    if (m.location !== 'godown' || (m.transfers || []).length) return bad(res, 'Only a machine still in its own godown (not sent anywhere) can go back to assembling');
    (m.statusEdits = m.statusEdits || []).push({ from: 'done', to: 'started', by: 'admin', at, completedAt: m.completedAt });
    m.status = 'started';
    m.completedAt = null;
    m.location = null;
    m.godownAt = null;
    m.incentive = null;
  } else return bad(res, 'Nothing to undo on this machine');
  asmAssign();
  store.save();
  res.json({ ok: true });
});
admin.post('/assembly/:id/model', (req, res) => { const m = asmFind(req, res); if (m) send(res, asmEditModel(m, req.body, 'admin', (x) => x.unitId === m.unitId)); });
admin.post('/assembly/:id/dispatch', (req, res) => { const m = asmFind(req, res); if (m) send(res, asmDispatch(m, req.body, 'admin')); });
admin.post('/assembly/:id/complete', (req, res) => { const m = asmFind(req, res); if (m) send(res, asmComplete(m, req.body, 'admin')); });
admin.post('/assembly/:id/times', (req, res) => {
  const m = asmFind(req, res);
  if (!m) return;
  if (m.status !== 'done') return bad(res, 'Only finished machines');
  const t = asmTimes({}, req.body, true);
  if (t.error) return bad(res, t.error);
  m.startedAt = t.value.started;
  m.completedAt = t.value.completed;
  m.timesEditedBy = 'admin';
  store.save();
  res.json({ ok: true });
});
admin.post('/assembly/:id/cancel', (req, res) => {
  const m = asmFind(req, res);
  if (!m) return;
  if (m.status === 'done') return bad(res, 'Finished machines cannot be cancelled');
  m.status = 'cancelled';
  asmAssign();
  store.save();
  res.json({ ok: true });
});
// Change team leader / installation person / helper (admin only).
admin.post('/assembly/:id/assign', (req, res) => {
  const m = asmFind(req, res);
  if (!m) return;
  if (m.status === 'cancelled') return bad(res, 'Cancelled');
  const ok = (id, roles) => !id || db().people.some((p) => p.id === id && p.active && !p.deleted && roles.includes(p.role));
  const { leaderId, installerId, helperId } = req.body;
  if (!ok(leaderId, ['leader'])) return bad(res, 'Choose a team leader');
  if (!ok(installerId, ['installer', 'both'])) return bad(res, 'Choose an installation person');
  if (!ok(helperId, ['helper', 'both'])) return bad(res, 'Choose a helper');
  if (installerId && installerId === helperId) return bad(res, 'Installation person and helper must be different');
  if (installerId && installerId !== m.installerId && m.status !== 'done') {
    const e = installerLimit(db().people.find((x) => x.id === installerId), 1);
    if (e) return bad(res, e);
  }
  if (leaderId !== undefined) {
    m.leaderId = leaderId || null;
    if (m.status === 'waiting' && m.leaderId) { m.status = 'assigned'; m.assignedAt = new Date().toISOString(); }
    if (m.status === 'assigned' && !m.leaderId) m.status = 'waiting';
  }
  if (installerId !== undefined) m.installerId = installerId || null;
  if (helperId !== undefined) m.helperId = helperId || null;
  m.manual = true;
  asmAssign();
  store.save();
  res.json({ ok: true });
});
// Old machine that was missed out earlier: added as finished, with its times.
admin.post('/assembly/old', (req, res) => {
  const unitId = str(req.body.unitId);
  if (!liveUnit(unitId)) return bad(res, 'Choose a unit');
  const model = canonModel(req.body.model);
  if (!model) return bad(res, 'Enter the model no.');
  { const miss = rateMissing(model); if (miss) return bad(res, miss); }
  const qty = parseInt(req.body.qty, 10) || 1;
  if (qty < 1 || qty > 50) return bad(res, 'Quantity must be 1 to 50');
  // Team leader, installation person and helper are optional for the admin (old stock found later).
  // With a team leader the times are compulsory (they count for the scoreboard); without one, now.
  const leaderId = str(req.body.leaderId);
  const leader = leaderId ? db().people.find((p) => p.id === leaderId && p.role === 'leader' && !p.deleted) : null;
  if (leaderId && !leader) return bad(res, 'That team leader was not found');
  let t = asmTimes({}, req.body, true);
  if (t.error) {
    if (leader) return bad(res, t.error);
    const now = new Date().toISOString();
    t = { value: { started: now, completed: now } };
  }
  for (let i = 0; i < qty; i++) {
    db().assembly.push({
      id: newId('asm'), unitId, model, status: 'done', source: 'old', leaderId: leader ? leader.id : null,
      installerId: str(req.body.installerId) || null, helperId: str(req.body.helperId) || null,
      createdAt: t.value.started, assignedAt: t.value.started, startedAt: t.value.started, completedAt: t.value.completed,
      createdBy: 'admin', entryBy: 'admin (old entry)', timesEditedBy: 'admin', note: str(req.body.note, 200),
      incentive: asmIncentive(model, leader ? leader.id : null),
      location: 'godown', godownAt: new Date().toISOString(),
    });
  }
  store.save();
  res.json({ ok: true });
});
admin.post('/assembly/requests/:id/:action', (req, res) => {
  const r = db().assemblyRequests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Request not found' });
  if (r.status !== 'pending') return bad(res, 'Already decided');
  if (req.params.action === 'reject') {
    r.status = 'rejected';
  } else if (req.params.action === 'approve' && r.type === 'old') {
    { const miss = rateMissing(r.model); if (miss) return bad(res, miss); }
    // Old machine claimed by a team leader: added as already assembled, with its times.
    const leader = db().people.find((p) => p.id === r.leaderId && !p.deleted);
    if (!leader) return bad(res, 'That team leader was removed');
    const qty = Math.max(1, Math.min(10, parseInt(req.body.qty, 10) || r.qty));
    for (let i = 0; i < qty; i++) {
      db().assembly.push({
        id: newId('asm'), unitId: r.unitId, model: r.model, status: 'done', source: 'old', requestId: r.id, leaderId: leader.id,
        installerId: r.installerId || null, helperId: r.helperId || null,
        createdAt: r.startedAt, assignedAt: r.startedAt, startedAt: r.startedAt, completedAt: r.completedAt,
        createdBy: leader.name, entryBy: `${leader.name} (old entry, approved by admin)`, timesEditedBy: leader.name, note: r.note,
        incentive: asmIncentive(r.model, leader.id),
      });
    }
    r.status = 'approved';
    r.approvedQty = qty;
  } else if (req.params.action === 'approve') {
    { const miss = rateMissing(r.model); if (miss) return bad(res, miss); }
    const leader = db().people.find((p) => p.id === r.leaderId && p.active && !p.deleted);
    if (!leader) return bad(res, 'That team leader is no longer active');
    const qty = Math.max(1, Math.min(20, parseInt(req.body.qty, 10) || r.qty));
    const now = new Date().toISOString();
    for (let i = 0; i < qty; i++) {
      const m = { id: newId('asm'), unitId: leader.unitId, model: r.model, status: 'assigned', source: 'request', requestId: r.id, leaderId: leader.id, createdAt: now, assignedAt: now, createdBy: 'admin', entryBy: `${leader.name} (request)`, note: r.note };
      ASM.pickCrew(db(), m, today());
      db().assembly.push(m);
    }
    r.status = 'approved';
    r.approvedQty = qty;
  } else return bad(res, 'Unknown action');
  r.decidedAt = new Date().toISOString();
  r.reason = str(req.body.reason, 200);
  store.save();
  res.json({ ok: true });
});
// keep "added by <team leader>" on a rate when the admin saves the list again
const modelKey = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function addedBy(list, x) {
  const old = (list || []).find((o) => modelKey(o.model) === modelKey(x && x.model));
  return old && old.addedBy ? { addedBy: old.addedBy, addedAt: old.addedAt } : {};
}

// Team leaders can see the rates and ADD a model that is not in a list yet (not change rates).
app.get('/api/staff/assembly/incentives', need('staff'), (req, res) => {
  if (req.user.account.role !== 'leader') return bad(res, 'Only team leaders');
  const s = asmSettings();
  res.json({ incentives: s.incentives || [], dispatchIncentives: s.dispatchIncentives || [], defaultLeader: s.defaultLeader, defaultInstaller: s.defaultInstaller, defaultDispatch: s.defaultDispatch });
});
app.post('/api/staff/assembly/incentives', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'leader') return bad(res, 'Only team leaders can add incentive rates');
  const money = (v) => Math.max(0, Math.min(100000, Math.round(Number(v) || 0)));
  const model = canonModel(req.body.model);
  if (!model) return bad(res, 'Enter the model no.');
  const s = { ...asmSettings() };
  const stamp = { addedBy: p.name, addedAt: new Date().toISOString() };
  if (req.body.type === 'dispatch') {
    if ((s.dispatchIncentives || []).some((x) => modelKey(x.model) === modelKey(model))) return bad(res, 'This model already has a dispatch rate – only the admin can change it');
    s.dispatchIncentives = [...(s.dispatchIncentives || []), { model, amount: money(req.body.amount), ...stamp }];
  } else {
    if ((s.incentives || []).some((x) => modelKey(x.model) === modelKey(model))) return bad(res, 'This model already has an assembly rate – only the admin can change it');
    s.incentives = [...(s.incentives || []), { model, leader: money(req.body.leader), installer: money(req.body.installer), ...stamp }];
  }
  db().settings.assembly = s;
  refreshDispatchIncentives();
  store.save();
  res.json({ ok: true });
});

// A rate list may hold each model only once (exact name, ignoring capitals and spaces).
function duplicateIn(rows, label) {
  const seen = [];
  for (const x of rows || []) {
    const model = canonModel(x && x.model);
    if (!model) continue;
    if (seen.some((m) => ASM.sameRate(m, model))) return `"${model}" is twice in the ${label} list – the same model cannot be added twice. Remove one row and save again.`;
    seen.push(model);
  }
  return '';
}
// Clean lists that already hold a model twice: keep the row with the highest rate.
function dedupeRates(list, score) {
  const out = [];
  for (const x of list || []) {
    const i = out.findIndex((o) => ASM.sameRate(o.model, x.model));
    if (i < 0) out.push(x); else if (score(x) > score(out[i])) out[i] = x;
  }
  return out;
}
{
  const a = db().settings.assembly || {};
  const f = db().settings.fab || {};
  const before = JSON.stringify([a.incentives, a.dispatchIncentives, f.contractorRates]);
  if (a.incentives) a.incentives = dedupeRates(a.incentives, (x) => (Number(x.leader) || 0) + (Number(x.installer) || 0));
  if (a.dispatchIncentives) a.dispatchIncentives = dedupeRates(a.dispatchIncentives, (x) => Number(x.amount) || 0);
  if (f.contractorRates) f.contractorRates = dedupeRates(f.contractorRates, (x) => Number(x.rate) || 0);
  if (JSON.stringify([a.incentives, a.dispatchIncentives, f.contractorRates]) !== before) store.save();
}
admin.put('/assembly/settings', (req, res) => {
  const b = req.body;
  { const dup = (Array.isArray(b.incentives) && duplicateIn(b.incentives, 'assembly incentive')) || (Array.isArray(b.dispatchIncentives) && duplicateIn(b.dispatchIncentives, 'dispatch incentive')); if (dup) return bad(res, dup); }
  const cur = asmSettings();
  const money = (v) => Math.max(0, Math.min(100000, Math.round(Number(v) || 0)));
  db().settings.assembly = {
    maxPending: Math.max(1, Math.min(50, parseInt(b.maxPending, 10) || cur.maxPending)),
    defaultLeader: b.defaultLeader !== undefined ? money(b.defaultLeader) : cur.defaultLeader,
    defaultInstaller: b.defaultInstaller !== undefined ? money(b.defaultInstaller) : cur.defaultInstaller,
    divertPenalty: b.divertPenalty !== undefined ? money(b.divertPenalty) : cur.divertPenalty,
    maxInstallerPending: Math.max(1, Math.min(50, parseInt(b.maxInstallerPending, 10) || cur.maxInstallerPending || 10)),
    defaultDispatch: b.defaultDispatch !== undefined ? money(b.defaultDispatch) : cur.defaultDispatch,
    reducedDispatchUnits: Array.isArray(b.reducedDispatchUnits) ? b.reducedDispatchUnits.map((x) => str(x)).filter((id) => db().units.some((u) => u.id === id)) : cur.reducedDispatchUnits,
    reducedDispatchPercent: b.reducedDispatchPercent !== undefined && b.reducedDispatchPercent !== '' ? Math.max(0, Math.min(100, Number(b.reducedDispatchPercent) || 0)) : cur.reducedDispatchPercent,
    unitDispatchUnits: Array.isArray(b.unitDispatchUnits) ? b.unitDispatchUnits.map((x) => str(x)).filter((id) => db().units.some((u) => u.id === id)) : cur.unitDispatchUnits,
    unitDispatchSlabs: Array.isArray(b.unitDispatchSlabs)
      ? b.unitDispatchSlabs.map((x) => ({ from: Math.max(1, parseInt(x && x.from, 10) || 0), amount: money(x && x.amount) })).filter((x) => x.from >= 1).sort((a, c) => a.from - c.from).slice(0, 10)
      : cur.unitDispatchSlabs,
    dispatchIncentives: Array.isArray(b.dispatchIncentives)
      ? b.dispatchIncentives.map((x) => ({ model: canonModel(x && x.model), amount: money(x && x.amount), ...addedBy(cur.dispatchIncentives, x) })).filter((x) => x.model).slice(0, 300)
      : cur.dispatchIncentives || [],
    incentives: Array.isArray(b.incentives)
      ? b.incentives.map((x) => ({ model: canonModel(x && x.model), leader: money(x && x.leader), installer: money(x && x.installer), ...addedBy(cur.incentives, x) })).filter((x) => x.model).slice(0, 300)
      : cur.incentives,
  };
  refreshDispatchIncentives();
  asmAssign();
  store.save();
  res.json({ ok: true });
});

// ---------- godown dispatch (Dispatch login + admin) ----------
// Send `qty` machines of a model from a unit's godown (oldest first) to another unit's godown
// (no incentive) or to a client (client name compulsory; dispatch incentive to the team leader).
// `who` = { name, dispatcherId } – a Dispatch login earns the dispatch incentive; the admin does not.
function sendFromGodown(body, who) {
  const by = who.name;
  const fromUnitId = str(body.fromUnitId);
  const model = str(body.model, 120);
  const qty = parseInt(body.qty, 10);
  const to = str(body.to);
  if (!fromUnitId || !model) return { error: 'Choose the unit and model' };
  if (!(qty >= 1)) return { error: 'Enter the quantity' };
  const forParty = to === 'client' ? str(body.party).toLowerCase() : '';
  const avail = db().assembly.filter((m) => m.status === 'done' && m.location === 'godown' && m.unitId === fromUnitId && m.model === model)
    // machines booked for this client first, then free stock (oldest first), others' bookings last
    .sort((a, b) => rank(a) - rank(b) || (a.completedAt || a.godownAt || '').localeCompare(b.completedAt || b.godownAt || ''));
  function rank(m) { return !m.bookedParty ? 1 : m.bookedParty.toLowerCase() === forParty ? 0 : 2; }
  if (qty > avail.length) return { error: `Only ${avail.length} in the godown` };
  // "Which machines": 'free' = not booked, otherwise the client the machines are booked for.
  // Compulsory when some of this model are booked, so the right machines (and their booking) move.
  const pick = str(body.pick, 120);
  const anyBooked = avail.some((m) => m.bookedParty);
  if (anyBooked && !pick) return { error: 'Choose which machines you are sending: free stock or booked for a client' };
  if (pick) {
    const group = avail.filter((m) => (pick === 'free' ? !m.bookedParty : (m.bookedParty || '') === pick));
    if (!group.length) return { error: 'No such machines in this godown' };
    if (qty > group.length) return { error: `Only ${group.length} ${pick === 'free' ? 'free (not booked)' : 'booked for ' + pick} in the godown` };
    avail.splice(0, avail.length, ...group);
  }
  // "Which machines" by entry (assembled by whom / old stock / transfer, with date): the ones that
  // are physically loaded, so the godown list stays right. Compulsory when the line has more than one.
  const entry = str(body.entry, 300);
  const entryAt = str(body.entryAt, 40);
  const entries = new Set(avail.map((m) => ASM.stockEntry(db(), m) + '|' + ASM.stockEntryAt(m)));
  if (entries.size > 1 && !entry) return { error: 'Choose which machines you are sending (assembled by whom / when)' };
  if (entry) {
    const group = avail.filter((m) => ASM.stockEntry(db(), m) === entry && (!entryAt || ASM.stockEntryAt(m) === entryAt));
    if (!group.length) return { error: 'Those machines are no longer in this godown – refresh the page' };
    if (qty > group.length) return { error: `Only ${group.length} of those machines in the godown` };
    avail.splice(0, avail.length, ...group);
  }
  // check the destination before saving any photo
  if (to === 'client' && !str(body.party)) return { error: 'Client name is compulsory' };
  // Only machines booked for a client can be dispatched to a client; free stock moves only
  // to another unit's godown.
  if (to === 'client' && avail.slice(0, qty).some((m) => !m.bookedParty)) {
    return { error: 'Free stock (not booked) cannot be dispatched to a client. Book the machine for the client first (✎ Correct → Change booking), then you can dispatch. Free stock can only be sent to another unit\'s godown.' };
  }
  // A machine booked for one client cannot be dispatched to another.
  if (to === 'client') {
    const norm = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const wrong = avail.slice(0, qty).find((m) => m.bookedParty && norm(m.bookedParty) !== norm(body.party));
    if (wrong) return { error: `This machine is booked for "${wrong.bookedParty}" but you are dispatching to "${str(body.party)}". Booked for someone else and dispatching to someone else – kindly correct the booking name first (✎ Correct → Change booking).` };
  }
  if (to === 'unit' && (!liveUnit(str(body.toUnitId)) || str(body.toUnitId) === fromUnitId)) return { error: 'Choose a different unit to send to' };
  // Dispatch photo (vehicle / loaded machine / challan) is compulsory for Dispatch logins.
  const ph = readPhotos({ photos: [] }, body.photos);
  if (ph.error) return ph;
  if (!ph.value.length && who.dispatcherId) return { error: 'Take a dispatch photo first' };
  const at = new Date().toISOString();
  const list = avail.slice(0, qty);
  if (!['unit', 'client'].includes(to)) return { error: 'Choose: to another unit or to a client' };
  // one copy of the photo, shared by every machine in this dispatch
  let photoRefs = [];
  if (ph.value.length) { const holder = { id: list[0].id, photos: [] }; savePhotos(holder, ph.value, by); photoRefs = holder.photos.map((p) => ({ ...p, kind: to })); }
  for (const m of list) if (photoRefs.length) m.dispatchPhotos = [...(m.dispatchPhotos || []), ...photoRefs];
  if (to === 'unit') {
    const toUnit = liveUnit(str(body.toUnitId));
    if (!toUnit) return { error: 'Choose the unit to send to' };
    if (toUnit.id === fromUnitId) return { error: 'Choose a different unit' };
    for (const m of list) {
      (m.transfers = m.transfers || []).push({ from: m.unitId, to: toUnit.id, at, by, dispatcherId: who.dispatcherId || null, note: str(body.note, 200), ...(m.bookedParty ? { bookedParty: m.bookedParty } : {}) });
      m.unitId = toUnit.id;
      m.godownAt = at;
    }
  } else if (to === 'client') {
    const party = str(body.party, 120);
    if (!party) return { error: 'Client name is compulsory' };
    for (const m of list) {
      m.location = 'dispatched';
      m.dispatchParty = party;
      m.dispatchedAt = at;
      m.dispatchedBy = by;
      m.dispatchNote = str(body.note, 200);
      m.dispatchIncentive = who.dispatcherId ? { dispatcherId: who.dispatcherId, name: by, fromUnitId: m.unitId, amount: dispatchCut(ASM.dispatchAmount(db(), m.model, m.unitId), who.dispatcherId) } : null;
    }
  } else return { error: 'Choose: to another unit or to a client' };
  store.save();
  return { value: { id: '', count: list.length } };
}
// Recent movements for the history list.
function godownHistory(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = [];
  // which machine left: how it came into the godown (assembled by whom / old stock / transfer) and when
  const what = (m) => {
    const when = String(m.source === 'stock' ? m.createdAt || m.godownAt : m.completedAt || m.godownAt || '').slice(0, 16);
    const how = m.source === 'stock' ? `old stock by ${String(m.createdBy || '?').replace(/ \(unit\)$/, '')}` : m.leaderId ? `assembled by ${personName(m.leaderId)}` : 'old machine';
    return { how, when };
  };
  for (const m of db().assembly) {
    const photoAt = (at, kind) => ((m.dispatchPhotos || []).find((p) => p.at === at && p.kind === kind) || (m.dispatchPhotos || []).find((p) => p.kind === kind && Math.abs(Date.parse(p.at) - Date.parse(at)) < 60000) || {}).file;
    if (m.location === 'dispatched' && (m.dispatchedAt || '') >= since) rows.push({ at: m.dispatchedAt, kind: 'client', model: m.model, from: unitName(m.unitId), to: m.dispatchParty, by: m.dispatchedBy || '', leader: personName(m.leaderId), incentive: (m.dispatchIncentive && m.dispatchIncentive.amount) || 0, photo: photoAt(m.dispatchedAt, 'client'), what: what(m) });
    for (const t of m.transfers || []) if ((t.at || '') >= since) rows.push({ at: t.at, kind: 'unit', model: m.model, from: unitName(t.from), to: unitName(t.to), by: t.by || '', booked: t.bookedParty || '', photo: photoAt(t.at, 'unit'), what: what(m) });
  }
  // group same moment + model + destination
  const g = {};
  for (const r of rows) {
    const k = [r.at, r.kind, r.model, r.from, r.to, r.booked || ''].join('|');
    const x = (g[k] ||= { ...r, qty: 0, incentive: 0, items: {} });
    x.qty++; x.incentive += r.incentive || 0;
    const ik = r.what.how + '|' + r.what.when; (x.items[ik] ||= { ...r.what, qty: 0 }).qty++;
  }
  return Object.values(g).map(({ what, ...x }) => ({ ...x, items: Object.values(x.items) })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
}
app.get('/api/dispatch/home', need('dispatch'), (req, res) => {
  const month = monthOf(req.query.month);
  // Dispatch logins see the scoreboard with client incentive and other-unit (transfer) incentive;
  // only the slab rates stay with the admin.
  const board = ASM.dispatchBoard(db(), month);
  const mine = board.find((r) => r.id === req.user.id);
  res.json({
    stock: ASM.stock(db()), units: db().units.filter((u) => u.active && !u.deleted).map((u) => ({ id: u.id, name: u.name })), history: godownHistory(),
    // transfers to units without a bonus are shown only to the admin
    month, board: board.map(({ toUnit, ...x }) => ({ ...x, toUnit: x.toBonusUnit || 0 })),
    me: mine ? { toClient: mine.toClient, toBonusUnit: mine.toBonusUnit, clientIncentive: mine.clientIncentive, unitBonus: mine.unitBonus, incentive: mine.incentive }
      : { toClient: 0, toBonusUnit: 0, clientIncentive: 0, unitBonus: 0, incentive: 0 },
    bonusUnitNames: ASM.bonusUnits(db()).map(unitName).filter(Boolean),
  });
});
app.post('/api/dispatch/send', need('dispatch'), (req, res) => send(res, sendFromGodown(req.body, { name: req.user.account.name, dispatcherId: req.user.id })));
// Dispatch money is for the admin and dispatch logins only (not team leaders / units).
// Machines sent to a client from a Dispatch login while their model had no dispatch rate got ₹0.
// When the rate is added later (exact model name), they get it: last 2 months.
function refreshDispatchIncentives() {
  const since = new Date(Date.now() - 62 * 86400000).toISOString();
  let n = 0;
  for (const m of db().assembly) {
    const d = m.dispatchIncentive;
    if (m.location !== 'dispatched' || !d || !d.dispatcherId || d.amount || (m.dispatchedAt || '') < since) continue;
    const amount = dispatchCut(ASM.dispatchAmount(db(), m.model, d.fromUnitId || m.unitId), d.dispatcherId);
    if (amount > 0) { d.amount = amount; d.rateAddedLater = true; n++; }
  }
  return n;
}
if (refreshDispatchIncentives()) store.save();
// Client dispatches in a month whose model has no dispatch rate (₹0), per model.
function dispatchMissingRates(month) {
  const g = {};
  for (const m of db().assembly) {
    const d = m.dispatchIncentive;
    if (m.location === 'dispatched' && d && d.dispatcherId && !d.amount && (m.dispatchedAt || '').slice(0, 7) === month) (g[m.model] ||= { model: m.model, qty: 0, by: new Set() }).qty++, g[m.model].by.add(d.name);
  }
  return Object.values(g).map((x) => ({ model: x.model, qty: x.qty, by: [...x.by].join(', ') }));
}
app.get('/api/dispatch/board', (req, res) => {
  if (!req.user || !['admin', 'dispatch'].includes(req.user.role)) return res.status(403).json({ error: 'Not allowed' });
  const month = monthOf(req.query.month);
  const board = ASM.dispatchBoard(db(), month);
  res.json({ board, missing: req.user.role === 'admin' ? dispatchMissingRates(month) : [] });
});
admin.get('/godown', (req, res) => res.json({ stock: ASM.stock(db()), units: db().units.filter((u) => u.active && !u.deleted).map((u) => ({ id: u.id, name: u.name })), history: godownHistory() }));
admin.post('/godown/send', (req, res) => send(res, sendFromGodown(req.body, { name: 'admin' })));

// Old stock already lying in a unit's godown (before this app): added straight to the godown,
// no team / assembly incentive; the dispatch incentive applies when it goes to a client.
function addOldStock(body, by, role, creator) {
  const unitId = str(body.unitId);
  if (!liveUnit(unitId)) return { error: 'Choose the unit' };
  const model = canonModel(body.model);
  if (!model) return { error: 'Enter the model no.' };
  { const miss = rateMissing(model, 'any'); if (miss) return { error: miss }; }
  const qty = parseInt(body.qty, 10);
  if (!(qty >= 1 && qty <= 200)) return { error: 'Quantity must be 1 to 200' };
  // compulsory: plain godown stock, or already booked for a client (party name compulsory)
  const kind = str(body.kind);
  if (!['godown', 'party'].includes(kind)) return { error: 'Choose: Godown stock or Booked for a client' };
  const party = kind === 'party' ? str(body.party, 120) : '';
  if (kind === 'party' && !party) return { error: 'Client (party) name is compulsory' };
  const at = new Date().toISOString();
  for (let i = 0; i < qty; i++) {
    db().assembly.push({ id: newId('asm'), unitId, model, status: 'done', source: 'stock', location: 'godown', godownAt: at, createdAt: at, createdBy: by, createdRole: role, ...(creator ? { creator } : {}), entryBy: `${by} (old stock)`, note: str(body.note, 200), ...(party ? { bookedParty: party } : {}) });
  }
  store.save();
  return { value: { id: '', count: qty } };
}
app.post('/api/dispatch/stock', need('dispatch'), (req, res) => send(res, addOldStock(req.body, req.user.account.name, 'dispatch')));
// Correct the model no. of machines in a godown (typing mistakes). Only the login that made the
// entry can correct it (the admin can correct everything).
app.post('/api/godown/edit-model', (req, res) => {
  const role = req.user && req.user.role;
  if (!['admin', 'dispatch', 'unit', 'staff'].includes(role)) return res.status(403).json({ error: 'Not allowed' });
  const unitId = str(req.body.unitId) || (role === 'unit' ? req.user.id : '');
  const from = str(req.body.from, 120);
  const model = canonModel(req.body.model);
  if (!model) return bad(res, 'Enter the correct model no.');
  if (model === from) return bad(res, 'The model no. is the same');
  { const miss = rateMissing(model, 'any'); if (miss) return bad(res, miss); }
  const inGodown = db().assembly.filter((m) => m.unitId === unitId && m.model === from && m.status === 'done' && m.location === 'godown');
  if (!inGodown.length) return bad(res, 'No machine of this model in that godown');
  // only the login that made the entry (or the admin) can correct it
  // "Which ones": one group of the line (e.g. assembled by a team leader, or old stock by a unit)
  const entry = str(req.body.entry, 300);
  const entryAt = str(req.body.entryAt, 40);
  const group = entry ? inGodown.filter((m) => ASM.stockEntry(db(), m) === entry && (!entryAt || ASM.stockEntryAt(m) === entryAt)) : inGodown;
  if (!group.length) return bad(res, 'Those machines are no longer in this godown – refresh the page');
  const list = group.filter((m) => ASM.canEditModel(db(), req.user, m));
  if (!list.length) return bad(res, 'Only the login that made this entry (or the admin) can correct the model no.');
  const qty = Math.max(1, Math.min(list.length, parseInt(req.body.qty, 10) || list.length));
  const by = role === 'admin' ? 'admin' : role === 'unit' ? (req.user.account.name || req.user.account.username) + ' (unit)' : req.user.account.name || '';
  const at = new Date().toISOString();
  for (const m of list.slice(0, qty)) {
    (m.modelEdits = m.modelEdits || []).push({ from, to: model, by, at });
    m.model = model;
    if (m.source !== 'stock') m.incentive = asmIncentive(model, m.leaderId); // assembly incentive follows the right model
  }
  store.save();
  res.json({ ok: true, changed: qty });
});
// Old stock entered by mistake (e.g. 4 entered, only 3 there): take the extra ones out of the godown.
// Old stock: the admin or the login that made the entry; assembled / transferred machines: admin only.
// Kept on record as cancelled (an assembled machine then counts no incentive).
app.post('/api/godown/remove', (req, res) => {
  const role = req.user && req.user.role;
  if (!['admin', 'dispatch', 'unit', 'staff'].includes(role)) return res.status(403).json({ error: 'Not allowed' });
  const unitId = str(req.body.unitId) || (role === 'unit' ? req.user.id : '');
  const from = str(req.body.from, 120);
  const entry = str(req.body.entry, 300);
  const entryAt = str(req.body.entryAt, 40);
  const reason = str(req.body.reason, 150);
  if (!reason) return bad(res, 'Write why they are removed (e.g. entered 4, only 3 in godown)');
  const group = db().assembly.filter((m) => m.unitId === unitId && m.model === from && m.status === 'done' && m.location === 'godown'
    && (!entry || (ASM.stockEntry(db(), m) === entry && (!entryAt || ASM.stockEntryAt(m) === entryAt))));
  const stockOnly = role === 'admin' ? group : group.filter((m) => m.source === 'stock');
  if (!stockOnly.length) return bad(res, group.length ? 'Only old stock entries can be removed here (assembled machines: ask the admin)' : 'Those machines are no longer in this godown – refresh the page');
  const list = stockOnly.filter((m) => ASM.canEditModel(db(), req.user, m)).sort((a, b) => Number(!!a.bookedParty) - Number(!!b.bookedParty)); // unbooked first
  if (!list.length) return bad(res, 'Only the login that made this entry (or the admin) can remove it');
  const qty = Math.max(1, Math.min(list.length, parseInt(req.body.qty, 10) || 1));
  const by = role === 'admin' ? 'admin' : role === 'unit' ? (req.user.account.name || req.user.account.username) + ' (unit)' : req.user.account.name || '';
  const at = new Date().toISOString();
  for (const m of list.slice(0, qty)) {
    if (m.source !== 'stock' && m.leaderId) {
      // an assembled machine: it only leaves the godown list – the team leader keeps the assembly
      // and the incentive (it was really assembled)
      m.location = 'removed'; m.removedAt = at; m.removedBy = by; m.removeReason = reason;
    } else { m.status = 'cancelled'; m.cancelledAt = at; m.cancelledBy = by; m.cancelReason = 'Removed from stock: ' + reason; }
  }
  store.save();
  res.json({ ok: true, removed: qty });
});
// Change a booking in a godown: rename the client, move to another client, book free stock or
// make booked machines free again. Admin, Dispatch logins, or the login that made the entry.
app.post('/api/godown/booking', (req, res) => {
  const role = req.user && req.user.role;
  if (!['admin', 'dispatch', 'unit', 'staff'].includes(role)) return res.status(403).json({ error: 'Not allowed' });
  const unitId = str(req.body.unitId) || (role === 'unit' ? req.user.id : '');
  const model = str(req.body.model, 120);
  const fromParty = str(req.body.fromParty, 120); // '' = free stock
  const toParty = str(req.body.toParty, 120); // '' = not booked
  if (fromParty === toParty) return bad(res, fromParty ? 'The client name is the same' : 'Enter the client name to book these machines for');
  const group = db().assembly.filter((m) => m.unitId === unitId && m.model === model && m.status === 'done' && m.location === 'godown' && (m.bookedParty || '') === fromParty);
  if (!group.length) return bad(res, 'Those machines are no longer in this godown – refresh the page');
  const list = group.filter((m) => role === 'admin' || role === 'dispatch' || ASM.canEditModel(db(), req.user, m));
  if (!list.length) return bad(res, 'Only the admin, a Dispatch login or the login that made the entry can change this booking');
  const qty = Math.max(1, Math.min(list.length, parseInt(req.body.qty, 10) || list.length));
  const by = role === 'admin' ? 'admin' : role === 'unit' ? (req.user.account.name || req.user.account.username) + ' (unit)' : req.user.account.name || '';
  const at = new Date().toISOString();
  for (const m of list.slice(0, qty)) {
    (m.bookingEdits = m.bookingEdits || []).push({ from: fromParty, to: toParty, by, at });
    if (toParty) m.bookedParty = toParty; else delete m.bookedParty;
  }
  store.save();
  res.json({ ok: true, changed: qty });
});
admin.post('/godown/stock', (req, res) => send(res, addOldStock(req.body, 'admin', 'admin')));
// A unit adds old stock to its own godown only.
unit.post('/assembly/old-stock', (req, res) => bad(res, 'Stock is added by a team leader from their own login (or the Dispatch login)'));

// Dispatch logins (admin)
admin.post('/dispatchers', (req, res) => {
  const name = str(req.body.name, 80);
  const username = norm(req.body.username);
  const password = String(req.body.password || '');
  if (!name) return bad(res, 'Name is required');
  if (!/^[a-z0-9._@-]{3,40}$/.test(username)) return bad(res, 'Login ID must be 3-40 letters/numbers (no spaces)');
  if (db().dispatchers.some((d) => !d.deleted && d.username === username)) return bad(res, 'This login ID is already used');
  if (password.length < 4) return bad(res, 'Password must be at least 4 characters');
  db().dispatchers.push({ id: newId('dsp'), name, username, passHash: auth.hashPassword(password), active: true });
  store.save();
  res.json({ ok: true });
});
admin.put('/dispatchers/:id', (req, res) => {
  const d = db().dispatchers.find((x) => x.id === req.params.id && !x.deleted);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) d.name = str(req.body.name, 80) || d.name;
  if (req.body.active !== undefined) d.active = !!req.body.active;
  if (req.body.incentiveCut !== undefined) d.incentiveCut = Math.max(0, Math.min(100, Number(req.body.incentiveCut) || 0));
  if (req.body.password) { if (String(req.body.password).length < 4) return bad(res, 'Password must be at least 4 characters'); d.passHash = auth.hashPassword(String(req.body.password)); }
  store.save();
  res.json({ ok: true });
});
admin.delete('/dispatchers/:id', (req, res) => {
  const d = db().dispatchers.find((x) => x.id === req.params.id && !x.deleted);
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.deleted = true;
  d.active = false;
  store.save();
  res.json({ ok: true });
});

// Assembled machines that were taken out of the godown list before were cancelled, which also
// took the team leader's assembly and incentive away: give them back (they stay out of the godown).
{
  let n = 0;
  for (const m of db().assembly) {
    if (m.status === 'cancelled' && m.source !== 'stock' && m.leaderId && m.completedAt && String(m.cancelReason || '').startsWith('Removed from stock: ')) {
      m.status = 'done'; m.location = 'removed';
      m.removedAt = m.cancelledAt; m.removedBy = m.cancelledBy; m.removeReason = m.cancelReason.replace('Removed from stock: ', '');
      delete m.cancelledAt; delete m.cancelledBy; delete m.cancelReason;
      n++;
    }
  }
  if (n) { console.log(`Restored ${n} assembled machine(s) taken out of the godown list`); store.save(); }
}

// ---------- Fab → Painting → Assembly ----------
const FAB = require('./lib/fab');
const fabAssign = () => FAB.assignWaiting(db(), db().settings.timezone);
function fabView(m) {
  return {
    id: m.id, model: m.model, status: m.status, unitId: m.unitId || null, unitName: unitName(m.unitId), leader: personBrief(m.leaderId), helper: personBrief(m.helperId),
    createdAt: m.createdAt, createdBy: m.createdBy || '', assignedAt: m.assignedAt || null, startedAt: m.startedAt || null,
    completedAt: m.completedAt || null, note: m.note || '', cancelReason: m.cancelReason || '', edits: m.edits || [],
  };
}
// Fab contractor rate per model (exact model name, like the assembly incentive).
const fabRates = () => (FAB.settings(db()).contractorRates || []);
const fabRateOf = (model) => { const r = fabRates().find((x) => ASM.sameRate(x.model, model)); return r ? Math.max(0, Number(r.rate) || 0) : null; };
function fabRateMissing(model) {
  if (!model || fabRateOf(model) !== null) return '';
  return `No fab contractor rate is set for model "${model}". Pick the exact model name from the list – fab entry is allowed only for models that have a fab rate. The fab manager (💰 Fab rates) or the admin (🏭 Fab & Painting) must add its rate first.`;
}
// Fab done while the model had no rate, or before the leader was set as Contractor: ₹0 was saved.
// Fill it in once the rate / type exist (last 2 months; an amount already earned is never changed).
function refreshFabAmounts() {
  const since = new Date(Date.now() - 62 * 86400000).toISOString();
  let n = 0;
  for (const m of db().fab) {
    if (m.status !== 'done' || m.contractorAmount || (m.completedAt || '') < since) continue;
    const leader = db().people.find((p) => p.id === m.leaderId);
    const rate = fabRateOf(m.model);
    if (leader && leader.payType === 'contractor' && rate > 0) { m.fabRate = rate; m.contractorAmount = rate; m.rateAddedLater = true; n++; }
  }
  return n;
}
// Fab board for a month: machines done per fab leader and the contractor amount.
function fabBoard(month) {
  const done = db().fab.filter((m) => m.status === 'done' && (m.completedAt || '').slice(0, 7) === month);
  return db().people.filter((p) => p.role === 'fableader' && !p.deleted).map((p) => {
    const mine = done.filter((m) => m.leaderId === p.id);
    return { id: p.id, name: p.name, unitName: unitName(p.unitId), payType: p.payType || '', done: mine.length, amount: mine.reduce((t, m) => t + (m.contractorAmount || 0), 0) };
  }).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));
}
function fabAdd(body, by, creator) {
  const unit = liveUnit(str(body.unitId));
  if (!unit) return { error: 'Choose the unit – fab is shared only between that unit\'s fab leaders' };
  const model = canonModel(body.model);
  if (!model) return { error: 'Enter the model no.' };
  { const miss = fabRateMissing(model); if (miss) return { error: miss }; }
  const qty = parseInt(body.qty, 10);
  if (!(qty >= 1 && qty <= 50)) return { error: 'Quantity must be 1 to 50' };
  const now = new Date().toISOString();
  for (let i = 0; i < qty; i++) db().fab.push({ id: newId('fab'), unitId: unit.id, model, status: 'waiting', createdAt: now, createdBy: by, creator, note: str(body.note, 200) });
  fabAssign();
  store.save();
  return { value: { id: '' } };
}
function fabStart(m, by) {
  if (m.status !== 'assigned') return { error: m.status === 'waiting' ? 'No fab team leader yet' : 'Already started or finished' };
  m.status = 'started'; m.startedAt = new Date().toISOString(); m.startedBy = by;
  store.save();
  return { value: m };
}
// Fab done → the machine is waiting to come into Painting.
function fabDone(m, body, by) {
  if (!FAB.PENDING.includes(m.status)) return { error: 'This machine is not in fab' };
  const t = asmTimes(m, body, true);
  if (t.error) return t;
  m.status = 'done'; m.startedAt = t.value.started; m.completedAt = t.value.completed; m.doneBy = by;
  { // contractor fab leader: paid the model's fab rate per machine (fixed when it is done)
    const leader = db().people.find((p) => p.id === m.leaderId);
    const rate = fabRateOf(m.model) || 0;
    m.fabRate = rate;
    m.contractorAmount = leader && leader.payType === 'contractor' ? rate : 0;
  }
  if (body.startedAt || body.completedAt) m.timesEditedBy = by;
  db().painting.push({ id: newId('pnt'), fabId: m.id, unitId: m.unitId || null, model: m.model, status: 'coming', fromFab: true, createdAt: m.completedAt });
  fabAssign();
  store.save();
  return { value: m };
}
const fabFind = (req, res, ok) => {
  const m = db().fab.find((x) => x.id === req.params.id && (!ok || ok(x)));
  if (!m) res.status(404).json({ error: 'Machine not found' });
  return m;
};
function fabSummary() {
  const open = db().fab.filter((m) => FAB.OPEN.includes(m.status));
  return open.map(fabView);
}
const fabLeaders = () => db().people.filter((p) => p.role === 'fableader' && p.active && !p.deleted).map((p) => ({ id: p.id, name: p.name, unitId: p.unitId, unitName: unitName(p.unitId), pending: FAB.pendingOf(db(), p.id) }));

// ---------- 🔩 Bending (before fab) ----------
// Same as fab: machines per unit, shared fairly between the unit's bending leaders (no helper).
// Bending done → the machine goes into Fab for the same unit.
const bendAssign = () => FAB.assignWaiting(db(), db().settings.timezone, 'bend');
const bendRates = () => (FAB.settings(db(), 'bend').contractorRates || []);
const bendRateOf = (model) => { const r = bendRates().find((x) => ASM.sameRate(x.model, model)); return r ? Math.max(0, Number(r.rate) || 0) : null; };
// incentive for the company (payroll) employee who did the bending
const bendPayrollOf = (model, key = 'payroll') => { const r = bendRates().find((x) => ASM.sameRate(x.model, model)); return r ? Math.max(0, Number(r[key]) || 0) : 0; };
// done before the rate existed: fill in (last 2 months; not for company bending)
function refreshBendAmounts() {
  const since = new Date(Date.now() - 62 * 86400000).toISOString();
  for (const m of db().bend) {
    if (m.status !== 'done' || (m.completedAt || '') < since) continue;
    if (m.byCompany) {
      if (!m.companyAmount) m.companyAmount = bendPayrollOf(m.model);
      if (m.companyLeader && !m.companyLeaderAmount) m.companyLeaderAmount = bendPayrollOf(m.model, 'payrollLeader');
      continue;
    }
    if (!m.leaderId || m.bendAmount) continue;
    const r = bendRateOf(m.model);
    if (r > 0) { m.bendRate = r; m.bendAmount = r; }
  }
}
function bendBoard(month) {
  const done = db().bend.filter((m) => m.status === 'done' && (m.completedAt || '').slice(0, 7) === month);
  return db().people.filter((p) => p.role === 'bendleader' && !p.deleted).map((p) => {
    const mine = done.filter((m) => m.leaderId === p.id);
    return { id: p.id, name: p.name, unitName: unitName(p.unitId), done: mine.length, byCompany: mine.filter((m) => m.byCompany).length, amount: mine.reduce((t, m) => t + (m.bendAmount || 0), 0) };
  }).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));
}
// Company bending employees are people (role bendcompany, payroll) with their own login to see
// their bending incentive. Names from the earlier plain list become such people (no login yet).
function migrateCompanyWorkers() {
  const set = db().settings.bend;
  if (!set || !Array.isArray(set.companyWorkers)) return;
  for (const n of set.companyWorkers) {
    if (db().people.some((p) => p.role === 'bendcompany' && !p.deleted && p.name.toUpperCase() === String(n).toUpperCase())) continue;
    db().people.push({ id: newId('per'), name: String(n), phone: '', username: '', role: 'bendcompany', unitId: '', backup: false, active: true, incentiveCut: 0, payType: 'payroll', passHash: null, baseline: 0, createdAt: today() });
  }
  delete set.companyWorkers;
  store.save();
}
const companyPeople = (unitId) => db().people.filter((p) => p.role === 'bendcompany' && !p.deleted && (!unitId || !p.unitId || p.unitId === unitId));
const findCompanyPerson = (name) => db().people.find((p) => p.role === 'bendcompany' && !p.deleted && p.name.trim().toUpperCase() === String(name || '').trim().toUpperCase());
// is this machine bent by that company employee (by id, or by name for older entries)
const sameCo = (id, name, p) => (id ? id === p.id : (name || '').trim().toUpperCase() === p.name.trim().toUpperCase());
// 'leader' / 'person' when this company employee was the company team leader / person of the machine
const coRole = (m, p) => (!m.byCompany ? null : m.companyLeader && sameCo(m.companyLeaderId, m.companyLeader, p) ? 'leader' : sameCo(m.companyWorkerId, m.companyWorker, p) ? 'person' : null);
const coMine = (m, p) => !!coRole(m, p);
// names offered in the Start by company box
const bendWorkers = (unitId) => [...new Set(companyPeople(unitId).filter((p) => p.active).map((p) => p.name))].sort();
const coPersonView = (p) => ({ id: p.id, name: p.name, phone: p.phone || '', username: p.username || '', unitId: p.unitId || '', unitName: unitName(p.unitId), active: !!p.active, canLogin: !!p.passHash });
// company (payroll) employees who did bending: machines and their bending incentive
function bendCompanyBoard(month) {
  const g = {};
  for (const m of db().bend) {
    if (m.status !== 'done' || !m.byCompany || (m.completedAt || '').slice(0, 7) !== month) continue;
    const add = (id, name, role, amt) => {
      const k = id || (name || '?').trim().toUpperCase();
      const x = (g[k] ||= { name: name || '(name not entered)', unitName: unitName(m.unitId), asLeader: 0, asPerson: 0, leaderAmount: 0, personAmount: 0, amount: 0 });
      if (role === 'leader') { x.asLeader++; x.leaderAmount += amt; } else { x.asPerson++; x.personAmount += amt; }
      x.amount += amt;
    };
    if (m.companyLeader) add(m.companyLeaderId, m.companyLeader, 'leader', m.companyLeaderAmount || 0);
    add(m.companyWorkerId, m.companyWorker, 'person', m.companyAmount || 0);
  }
  return Object.values(g).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));
}
function bendAdd(body, by, creator) {
  const unit = liveUnit(str(body.unitId));
  if (!unit) return { error: 'Choose the unit – bending is shared only between that unit\'s bending leaders' };
  const model = canonModel(body.model);
  if (!model) return { error: 'Enter the model no.' };
  const qty = parseInt(body.qty, 10);
  if (!(qty >= 1 && qty <= 50)) return { error: 'Quantity must be 1 to 50' };
  const now = new Date().toISOString();
  for (let i = 0; i < qty; i++) db().bend.push({ id: newId('bnd'), unitId: unit.id, model, status: 'waiting', createdAt: now, createdBy: by, creator, note: str(body.note, 200) });
  bendAssign();
  store.save();
  return { value: { id: '' } };
}
function bendDone(m, body, by) {
  if (!FAB.PENDING.includes(m.status)) return { error: 'This machine is not in bending' };
  const t = asmTimes(m, body, true);
  if (t.error) return t;
  m.status = 'done'; m.startedAt = t.value.started; m.completedAt = t.value.completed; m.doneBy = by;
  // bending leader earns the model's bending rate – not when the company did the bending
  m.bendRate = bendRateOf(m.model) || 0;
  m.bendAmount = m.byCompany || !m.leaderId ? 0 : m.bendRate;
  if (m.byCompany) { // incentive to the company person and the company team leader
    m.companyAmount = bendPayrollOf(m.model);
    if (m.companyLeader) m.companyLeaderAmount = bendPayrollOf(m.model, 'payrollLeader');
  }
  // into Fab for the same unit (shared between its fab leaders as usual)
  const f = { id: newId('fab'), unitId: m.unitId, model: m.model, status: 'waiting', source: 'bend', bendId: m.id, createdAt: m.completedAt, createdBy: `${by} (bending done)`, creator: { role: 'bend', id: m.leaderId } };
  // same person in fab: the fab leader of this unit with the same name as the bending leader
  const bl = db().people.find((p) => p.id === m.leaderId);
  const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const fl = bl && db().people.find((p) => p.role === 'fableader' && p.active && !p.deleted && p.unitId === m.unitId && sameName(p.name, bl.name));
  if (fl) { f.leaderId = fl.id; f.status = 'assigned'; f.assignedAt = new Date().toISOString(); }
  db().fab.push(f);
  m.fabId = f.id;
  bendAssign();
  fabAssign();
  store.save();
  return { value: m };
}
const bendFind = (req, res, ok) => {
  const m = db().bend.find((x) => x.id === req.params.id && (!ok || ok(x)));
  if (!m) res.status(404).json({ error: 'Machine not found' });
  return m;
};
const bendPeople = (unitId, role) => db().people.filter((p) => p.role === role && p.active && !p.deleted && (!unitId || p.unitId === unitId)).map((p) => ({ id: p.id, name: p.name, unitId: p.unitId, unitName: unitName(p.unitId), pending: FAB.pendingOf(db(), p.id, 'bend'), canLogin: !!p.passHash }));
function bendSetLeader(m, body, by) {
  if (!FAB.OPEN.includes(m.status)) return { error: 'Only machines not finished can be changed' };
  const leaderId = str(body.leaderId);
  if (leaderId && !db().people.some((p) => p.id === leaderId && p.role === 'bendleader' && !p.deleted && p.active && (!m.unitId || p.unitId === m.unitId))) return { error: 'Choose a bending leader of this unit' };
  (m.edits = m.edits || []).push({ at: new Date().toISOString(), by, from: { leaderId: m.leaderId }, to: { leaderId } });
  m.leaderId = leaderId || null;
  if (m.leaderId && m.status === 'waiting') { m.status = 'assigned'; m.assignedAt = new Date().toISOString(); }
  if (!m.leaderId) { m.status = 'waiting'; m.assignedAt = null; m.startedAt = null; }
  m.manual = true;
  store.save();
  return { value: m };
}
function bendMove(body, by, unitId) {
  const from = str(body.fromLeaderId);
  const to = str(body.toLeaderId);
  const model = str(body.model, 120);
  const toP = db().people.find((p) => p.id === to && p.role === 'bendleader' && p.active && !p.deleted);
  if (!toP || to === from) return { error: 'Choose the bending leader to move them to' };
  const list = db().bend.filter((m) => (from ? m.leaderId === from && m.status === 'assigned' : !m.leaderId && m.status === 'waiting') && m.model === model && (!unitId || m.unitId === unitId));
  if (!list.length) return { error: 'No machine of this model is waiting to start with that bending leader' };
  if (list.some((m) => m.unitId && toP.unitId !== m.unitId)) return { error: 'Choose a bending leader of the same unit' };
  const qty = Math.max(1, Math.min(list.length, parseInt(body.qty, 10) || 1));
  const at = new Date().toISOString();
  for (const m of list.slice(0, qty)) { (m.edits = m.edits || []).push({ at, by, from: { leaderId: m.leaderId }, to: { leaderId: to } }); m.leaderId = to; m.status = 'assigned'; m.assignedAt = at; m.manual = true; }
  store.save();
  return { value: { id: '', moved: qty } };
}
// company: the bending is done by the company / payroll people – no bending rate for the leader.
function bendStart(m, by, company, worker, leader) {
  if (m.status !== 'assigned') return { error: m.status === 'waiting' ? 'No bending leader yet' : 'Already started or finished' };
  const name = str(worker, 80);
  const lead = str(leader, 80);
  if (company && !name) return { error: 'Write the name of the company person who does the bending' };
  if (company && !lead) return { error: 'Write the name of the company team leader' };
  if (company && lead.toUpperCase() === name.toUpperCase()) return { error: 'The company team leader and the person must be different' };
  m.status = 'started'; m.startedAt = new Date().toISOString(); m.startedBy = by; m.byCompany = !!company;
  if (company) {
    const cp = findCompanyPerson(name); m.companyWorker = cp ? cp.name : name; m.companyWorkerId = cp ? cp.id : null;
    const cl = findCompanyPerson(lead); m.companyLeader = cl ? cl.name : lead; m.companyLeaderId = cl ? cl.id : null;
  }
  store.save();
  return { value: m };
}
const bendView = (m) => ({ ...fabView(m), helper: null, byCompany: !!m.byCompany, companyWorker: m.companyWorker || '', companyLeader: m.companyLeader || '', bendAmount: m.bendAmount || 0 });
const isBend = (p) => ['bendleader', 'bendmanager'].includes(p.role);
app.get('/api/staff/bend', need('staff'), (req, res) => {
  migrateCompanyWorkers();
  const p = req.user.account;
  const month = monthOf(req.query.month);
  if (p.role === 'bendcompany') {
    // company bending employee: own bending this month and the incentive
    const done = db().bend.filter((m) => m.status === 'done' && coMine(m, p) && (m.completedAt || '').slice(0, 7) === month).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    return res.json({ isCompany: true, month, unitName: unitName(p.unitId),
      working: db().bend.filter((m) => m.status === 'started' && coMine(m, p)).map(bendView),
      done: done.map((m) => { const role = coRole(m, p); return { ...bendView(m), myRole: role, myAmount: role === 'leader' ? m.companyLeaderAmount || 0 : m.companyAmount || 0 }; }),
      myAmount: done.reduce((t, m) => t + (coRole(m, p) === 'leader' ? m.companyLeaderAmount || 0 : m.companyAmount || 0), 0) });
  }
  if (!isBend(p)) return bad(res, 'Only for the bending section');
  const manager = p.role === 'bendmanager';
  const mine = (m) => (manager ? m.unitId === p.unitId : m.leaderId === p.id);
  res.json({
    isLeader: p.role === 'bendleader', isManager: manager, unitId: p.unitId,
    units: db().units.filter((u) => u.active && !u.deleted).map((u) => ({ id: u.id, name: u.name })),
    items: db().bend.filter((m) => FAB.OPEN.includes(m.status) && (mine(m) || (m.creator && m.creator.role === 'staff' && m.creator.id === p.id))).map(bendView),
    unitLeaders: bendPeople(p.unitId, 'bendleader'),
    maxPending: FAB.settings(db(), 'bend').maxPending,
    month,
    done: db().bend.filter((m) => m.status === 'done' && mine(m) && (m.completedAt || '').slice(0, 7) === month).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map(bendView),
    workers: bendWorkers(p.unitId),
    companyPeople: manager ? companyPeople(p.unitId).map(coPersonView) : [],
    myAmount: p.role === 'bendleader' ? db().bend.filter((m) => m.status === 'done' && m.leaderId === p.id && (m.completedAt || '').slice(0, 7) === month).reduce((t, m) => t + (m.bendAmount || 0), 0) : null,
  });
});
app.post('/api/staff/bend', need('staff'), (req, res) => {
  const p = req.user.account;
  if (!isBend(p)) return bad(res, 'Only bending leaders / bending admins can enter machines');
  send(res, bendAdd({ ...req.body, unitId: str(req.body.unitId) || p.unitId }, p.name, { role: 'staff', id: p.id }));
});
// the bending leader for own machines; the bending admin for any machine of the unit
const bendMayWork = (req) => (x) => x.leaderId === req.user.id || (req.user.account.role === 'bendmanager' && x.unitId === req.user.account.unitId);
app.post('/api/staff/bend/:id/start', need('staff'), (req, res) => { const m = bendFind(req, res, bendMayWork(req)); if (m) send(res, bendStart(m, req.user.account.name, req.body.company, req.body.worker, req.body.leader)); });
app.post('/api/staff/bend/:id/done', need('staff'), (req, res) => { const m = bendFind(req, res, bendMayWork(req)); if (m) send(res, bendDone(m, req.body, req.user.account.name)); });
app.post('/api/staff/bend/:id/assign', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'bendmanager') return bad(res, 'Only the bending admin can give machines to bending leaders');
  const m = bendFind(req, res, (x) => x.unitId === p.unitId);
  if (m) send(res, bendSetLeader(m, req.body, p.name + ' (bending admin)'));
});
app.post('/api/staff/bend/move', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'bendmanager') return bad(res, 'Only the bending admin can move machines');
  const r = bendMove(req.body, p.name + ' (bending admin)', p.unitId);
  if (r.error) return bad(res, r.error);
  res.json({ ok: true, ...r.value });
});
// the bending admin adds / edits company bending employees of the unit (with their login PIN)
function staffCoSave(req, res, existing) {
  const p = req.user.account;
  if (p.role !== 'bendmanager') return bad(res, 'Only the bending admin can add company employees');
  const r = readPerson({ ...req.body, role: 'bendcompany', unitId: p.unitId, payType: 'payroll', backup: false, incentiveCut: 0, active: req.body.active !== false }, existing);
  if (r.error) return bad(res, r.error);
  if (findCompanyPerson(r.value.name) && findCompanyPerson(r.value.name) !== existing) return bad(res, 'A company employee with this name already exists');
  if (existing) Object.assign(existing, r.value);
  else db().people.push((existing = { id: newId('per'), ...r.value, passHash: null, baseline: 0, createdAt: today(), addedBy: p.name + ' (bending admin)' }));
  if (r.password) existing.passHash = auth.hashPassword(r.password);
  if (req.body.removeLogin) existing.passHash = null;
  store.save();
  res.json({ ok: true, id: existing.id });
}
app.post('/api/staff/bend/workers', need('staff'), (req, res) => staffCoSave(req, res, null));
app.put('/api/staff/bend/workers/:id', need('staff'), (req, res) => {
  const w = db().people.find((x) => x.id === req.params.id && x.role === 'bendcompany' && !x.deleted && (!x.unitId || x.unitId === req.user.account.unitId));
  if (!w) return res.status(404).json({ error: 'Not found' });
  staffCoSave(req, res, w);
});
admin.get('/bend', (req, res) => {
  migrateCompanyWorkers();
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  res.json({
    items: db().bend.filter((m) => FAB.OPEN.includes(m.status)).map(bendView),
    done: db().bend.filter((m) => m.status === 'done' && (m.completedAt || '') >= since).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map(bendView),
    leaders: bendPeople(null, 'bendleader'),
    settings: FAB.settings(db(), 'bend'),
    month: monthOf(req.query.month),
    board: bendBoard(monthOf(req.query.month)),
    companyBoard: bendCompanyBoard(monthOf(req.query.month)),
    workers: bendWorkers(),
  });
});
admin.post('/bend', (req, res) => send(res, bendAdd(req.body, 'admin', { role: 'admin', id: 'admin' })));
admin.post('/bend/move', (req, res) => { const r = bendMove(req.body, 'admin'); if (r.error) return bad(res, r.error); res.json({ ok: true, ...r.value }); });
admin.post('/bend/:id/start', (req, res) => { const m = bendFind(req, res); if (m) send(res, bendStart(m, 'admin', req.body.company, req.body.worker, req.body.leader)); });
admin.post('/bend/:id/done', (req, res) => { const m = bendFind(req, res); if (m) send(res, bendDone(m, req.body, 'admin')); });
admin.post('/bend/:id/assign', (req, res) => { const m = bendFind(req, res); if (m) send(res, bendSetLeader(m, req.body, 'admin')); });
admin.post('/bend/:id/cancel', (req, res) => {
  const m = bendFind(req, res);
  if (!m) return;
  if (!FAB.OPEN.includes(m.status)) return bad(res, 'Only machines not finished can be cancelled');
  m.status = 'cancelled'; m.cancelledAt = new Date().toISOString(); m.cancelReason = str(req.body.reason, 150);
  bendAssign();
  store.save();
  res.json({ ok: true });
});
admin.put('/bend/settings', (req, res) => {
  { const dup = Array.isArray(req.body.contractorRates) && duplicateIn(req.body.contractorRates, 'bending rate'); if (dup) return bad(res, dup); }
  const cur = FAB.settings(db(), 'bend');
  db().settings.bend = {
    ...cur,
    maxPending: req.body.maxPending !== undefined ? Math.max(1, Math.min(100, parseInt(req.body.maxPending, 10) || 10)) : cur.maxPending,
    contractorRates: Array.isArray(req.body.contractorRates) ? readFabRates(req.body.contractorRates, cur, '') : cur.contractorRates || [],
  };
  refreshBendAmounts();
  bendAssign();
  store.save();
  res.json({ ok: true });
});

// Painting: what is coming from fab, what is in painting, and the last 30 days of in / out.
function paintingView() {
  const P = db().painting;
  // where each machine came from, when, and who made the entry
  const entry = (x) => {
    const f = x.fabId ? db().fab.find((m) => m.id === x.fabId) : null;
    const fromFab = f ? `from fab · ${unitName(f.unitId) ? unitName(f.unitId) + ' – ' : ''}${personName(f.leaderId) || '?'} (fab done by ${f.doneBy || '?'})` : '';
    if (x.status === 'coming') return { text: `🏭 ${fromFab || 'from fab'}`, at: String(x.createdAt || '').slice(0, 16) };
    return { text: x.fromFab ? `⬇ In by ${x.inBy || '?'} · ${fromFab || 'from fab'}` : `⬇ Added directly by ${x.inBy || '?'} (not from fab)${x.note ? ' – ' + x.note : ''}`, at: String(x.inAt || '').slice(0, 16) };
  };
  const group = (list) => Object.values(list.reduce((o, x) => {
    const gm = (o[x.model] ||= { model: x.model, qty: 0, oldest: x.inAt || x.createdAt, units: {}, entries: {} });
    const e = entry(x); const k = e.text + '|' + e.at; (gm.entries[k] ||= { ...e, qty: 0 }).qty++;
    gm.qty++; if (x.unitId) gm.units[x.unitId] = (gm.units[x.unitId] || 0) + 1; const t = x.inAt || x.createdAt; if (t < o[x.model].oldest) o[x.model].oldest = t; return o; }, {}))
    .map((g) => ({ ...g, entries: Object.values(g.entries).sort((a, b) => b.at.localeCompare(a.at)) }))
    .sort((a, b) => a.model.localeCompare(b.model));
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const hist = [];
  for (const x of P) {
    if (x.inAt && x.inAt >= since) hist.push({ at: x.inAt, kind: 'in', model: x.model, by: x.inBy || '', note: x.fromFab ? 'from fab' : 'added directly' });
    if (x.outAt && x.outAt >= since) hist.push({ at: x.outAt, kind: 'out', model: x.model, by: x.outBy || '', note: 'to ' + unitName(x.toUnitId) + ' assembly' });
  }
  const g = {};
  for (const h of hist) { const k = [h.at.slice(0, 16), h.kind, h.model, h.by, h.note].join('|'); (g[k] ||= { ...h, qty: 0 }).qty++; }
  return {
    coming: group(P.filter((x) => x.status === 'coming')),
    inPainting: group(P.filter((x) => x.status === 'in')),
    history: Object.values(g).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
    units: db().units.filter((u) => u.active && !u.deleted).map((u) => ({ id: u.id, name: u.name })),
  };
}
const painterName = (req) => (req.user.role === 'admin' ? 'admin' : req.user.account.name);
function paintIn(body, by) {
  const model = str(body.model, 120);
  const qty = parseInt(body.qty, 10);
  const list = db().painting.filter((x) => x.status === 'coming' && x.model === model).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  if (!(qty >= 1)) return { error: 'Enter the quantity' };
  if (qty > list.length) return { error: `Only ${list.length} coming from fab` };
  if (rateMissing(model)) return { error: `Model "${model}" has no assembly incentive rate – correct the model no. first (✎ Correct)` };
  const at = new Date().toISOString();
  for (const x of list.slice(0, qty)) { x.status = 'in'; x.inAt = at; x.inBy = by; }
  store.save();
  return { value: { id: '' } };
}
// A machine that did not come through fab (e.g. bought / old) put straight into painting.
function paintAdd(body, by) {
  const model = canonModel(body.model);
  if (!model) return { error: 'Enter the model no.' };
  { const miss = rateMissing(model); if (miss) return { error: miss }; } // only models with an assembly incentive rate
  const qty = parseInt(body.qty, 10);
  if (!(qty >= 1 && qty <= 50)) return { error: 'Quantity must be 1 to 50' };
  const at = new Date().toISOString();
  for (let i = 0; i < qty; i++) db().painting.push({ id: newId('pnt'), model, status: 'in', fromFab: false, createdAt: at, inAt: at, inBy: by, note: str(body.note, 200) });
  store.save();
  return { value: { id: '' } };
}
// Painted → arrives at the chosen unit ("arrived from painting"); a team leader of that unit
// presses Allocate to share them fairly between its team leaders.
function paintOut(body, by, creator) {
  const model = str(body.model, 120);
  const qty = parseInt(body.qty, 10);
  const unit = liveUnit(str(body.toUnitId));
  if (!unit) return { error: 'Choose the unit the machines go to for assembly' };
  const list = db().painting.filter((x) => x.status === 'in' && x.model === model).sort((a, b) => (a.inAt || '').localeCompare(b.inAt || ''));
  if (!(qty >= 1)) return { error: 'Enter the quantity' };
  if (qty > list.length) return { error: `Only ${list.length} in painting` };
  if (rateMissing(model)) return { error: `Model "${model}" has no assembly incentive rate – correct the model no. first (✎ Correct)` };
  const at = new Date().toISOString();
  for (const x of list.slice(0, qty)) {
    const m = { id: newId('asm'), unitId: unit.id, model, status: 'arrived', arrivedAt: at, source: 'paint', paintId: x.id, createdAt: at, createdBy: by, creator, entryBy: `${by} (painting)`, note: str(body.note, 200) };
    db().assembly.push(m);
    Object.assign(x, { status: 'out', outAt: at, outBy: by, toUnitId: unit.id, asmId: m.id });
  }
  asmAssign();
  store.save();
  return { value: { id: '' } };
}
// Machines that arrived at a unit from painting and are not given out yet, per model.
function arrivedOf(unitId) {
  const g = {};
  for (const m of db().assembly) {
    if (m.status !== 'arrived' || m.unitId !== unitId) continue;
    const x = (g[m.model] ||= { model: m.model, qty: 0, oldest: m.arrivedAt, entries: {} });
    x.qty++; if ((m.arrivedAt || '') < x.oldest) x.oldest = m.arrivedAt;
    // who pressed ⬆ Out in painting (name + login) and when
    const login = m.creator && m.creator.role === 'admin' ? 'Admin' : m.creator && m.creator.role === 'painting' ? 'Painting login' : '';
    const text = `⬆ out of painting by ${m.createdBy === 'admin' ? 'Admin' : `${m.createdBy || '?'}${login ? ` (${login})` : ''}`}`;
    const at = String(m.arrivedAt || '').slice(0, 16);
    (x.entries[text + '|' + at] ||= { text, at, qty: 0 }).qty++;
  }
  return Object.values(g).map((x) => ({ ...x, entries: Object.values(x.entries).sort((a, b) => b.at.localeCompare(a.at)) })).sort((a, b) => a.model.localeCompare(b.model));
}
// ✎ Correct a wrong model no. on painting lines (coming / in) or on machines arrived at a unit.
function correctModel(list, newModelRaw, qty, by) {
  if (!list.length) return { error: 'Those machines are no longer there – refresh the page' };
  const newModel = canonModel(newModelRaw);
  if (!newModel) return { error: 'Enter the correct model no.' };
  { const miss = rateMissing(newModel); if (miss) return { error: miss }; }
  if (newModel === list[0].model) return { error: 'The model no. is the same' };
  const n = Math.max(1, Math.min(list.length, parseInt(qty, 10) || list.length));
  const at = new Date().toISOString();
  for (const x of list.slice(0, n)) {
    (x.edits = x.edits || []).push({ at, by, model: { from: x.model, to: newModel } });
    x.model = newModel;
    // keep the painting record and the assembly machine in step
    const other = x.asmId ? db().assembly.find((m) => m.id === x.asmId) : x.paintId ? db().painting.find((p) => p.id === x.paintId) : null;
    if (other) other.model = newModel;
  }
  store.save();
  return { value: { id: '', changed: n, model: newModel } };
}
app.post('/api/painting/correct', (req, res, next) => (req.user && ['painting', 'admin'].includes(req.user.role) ? next() : res.status(401).json({ error: 'Please log in' })), (req, res) => {
  const status = req.body.status === 'coming' ? 'coming' : 'in';
  const list = db().painting.filter((x) => x.status === status && x.model === str(req.body.model, 120));
  send(res, correctModel(list, req.body.newModel, req.body.qty, painterName(req) + (req.user.role === 'admin' ? '' : ' (painting)')));
});
const arrivedList = (unitId, model) => db().assembly.filter((m) => m.status === 'arrived' && m.unitId === unitId && m.model === model);
app.post('/api/staff/assembly/arrived/correct', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'leader') return bad(res, 'Only team leaders can correct');
  send(res, correctModel(arrivedList(p.unitId, str(req.body.model, 120)), req.body.newModel, req.body.qty, p.name));
});
admin.post('/assembly/arrived/correct', (req, res) => send(res, correctModel(arrivedList(str(req.body.unitId), str(req.body.model, 120)), req.body.newModel, req.body.qty, 'admin')));
// "Allocate": share the arrived machines fairly between the unit's team leaders (as before).
function allocateArrived(unitId, model, by) {
  const all = db().assembly.filter((m) => m.status === 'arrived' && m.unitId === unitId && (!model || m.model === model));
  if (!all.length) return { error: 'Nothing to allocate' };
  const list = all.filter((m) => !rateMissing(m.model)); // wrong model no. (no rate) must be corrected first
  if (!list.length) return { error: `Model "${all[0].model}" has no assembly incentive rate – press ✎ Correct to fix the model no. first` };
  const at = new Date().toISOString();
  for (const m of list) { m.status = 'waiting'; m.allocatedAt = at; m.allocatedBy = by; }
  asmAssign();
  store.save();
  const given = list.filter((m) => m.status !== 'waiting').length;
  return { value: { id: '', allocated: list.length, given } };
}
app.post('/api/staff/assembly/allocate', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'leader') return bad(res, 'Only team leaders can allocate');
  const r = allocateArrived(p.unitId, str(req.body.model, 120), p.name);
  if (r.error) return bad(res, r.error);
  res.json({ ok: true, ...r.value });
});
admin.post('/assembly/allocate', (req, res) => {
  const r = allocateArrived(str(req.body.unitId), str(req.body.model, 120), 'admin');
  if (r.error) return bad(res, r.error);
  res.json({ ok: true, ...r.value });
});
if (refreshFabAmounts()) store.save(); // on start
const paintOk = (req, res, next) => (req.user && ['painting', 'admin'].includes(req.user.role) ? next() : res.status(401).json({ error: 'Please log in' }));
const paintCreator = (req) => (req.user.role === 'admin' ? { role: 'admin', id: 'admin' } : { role: 'painting', id: req.user.id });
app.get('/api/painting/home', paintOk, (req, res) => res.json(paintingView()));
app.post('/api/painting/in', paintOk, (req, res) => send(res, paintIn(req.body, painterName(req))));
app.post('/api/painting/add', paintOk, (req, res) => send(res, paintAdd(req.body, painterName(req))));
app.post('/api/painting/out', paintOk, (req, res) => send(res, paintOut(req.body, painterName(req), paintCreator(req))));

// Fab team leader / fab helper (staff login)
const isFab = (p) => ['fableader', 'fabhelper', 'fabmanager'].includes(p.role);
app.get('/api/staff/fab', need('staff'), (req, res) => {
  const p = req.user.account;
  if (!isFab(p)) return bad(res, 'Only for the fab section');
  const month = monthOf(req.query.month);
  const mine = (m) => m.leaderId === p.id || m.helperId === p.id;
  const manager = p.role === 'fabmanager'; // distributes the unit's fab machines between its fab leaders
  res.json({
    isLeader: p.role === 'fableader',
    isManager: manager,
    items: db().fab.filter((m) => FAB.OPEN.includes(m.status) && (manager ? m.unitId === p.unitId : mine(m) || (m.creator && m.creator.role === 'staff' && m.creator.id === p.id))).map(fabView),
    unitLeaders: unitFabPeople(p.unitId, 'fableader'),
    unitHelpers: unitFabPeople(p.unitId, 'fabhelper'),
    leaders: fabLeaders(),
    maxPending: FAB.settings(db()).maxPending,
    unitId: p.unitId,
    units: db().units.filter((u) => u.active && !u.deleted).map((u) => ({ id: u.id, name: u.name })),
    month,
    myAmount: p.role === 'fableader' && p.payType === 'contractor' ? db().fab.filter((m) => m.status === 'done' && m.leaderId === p.id && (m.completedAt || '').slice(0, 7) === month).reduce((t, m) => t + (m.contractorAmount || 0), 0) : null,
    done: db().fab.filter((m) => m.status === 'done' && (manager ? m.unitId === p.unitId : mine(m)) && (m.completedAt || '').slice(0, 7) === month).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map(fabView),
  });
});
app.post('/api/staff/fab', need('staff'), (req, res) => {
  const p = req.user.account;
  if (!['fableader', 'fabmanager'].includes(p.role)) return bad(res, 'Only fab team leaders / fab managers can enter machines');
  send(res, fabAdd({ ...req.body, unitId: str(req.body.unitId) || p.unitId }, p.name, { role: 'staff', id: p.id }));
});
// Fab manager: see the fab rates and add a rate for a NEW model (changing a rate is admin only).
app.get('/api/staff/fab/rates', need('staff'), (req, res) => {
  if (req.user.account.role !== 'fabmanager') return bad(res, 'Only the fab manager');
  res.json({ rates: fabRates(), me: req.user.account.name });
});
app.post('/api/staff/fab/rates', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'fabmanager') return bad(res, 'Only the fab manager can add fab rates');
  const model = canonModel(req.body.model);
  if (!model) return bad(res, 'Enter the model no.');
  if (fabRates().some((x) => ASM.sameRate(x.model, model))) return bad(res, 'This model already has a fab rate – only the admin can change it');
  const rate = Math.max(0, Math.min(100000, Math.round(Number(req.body.rate) || 0)));
  if (!rate) return bad(res, 'Enter the rate ₹');
  const cur = FAB.settings(db());
  db().settings.fab = { ...cur, contractorRates: [...(cur.contractorRates || []), { model, rate, addedBy: p.name, addedAt: new Date().toISOString() }] };
  refreshFabAmounts();
  store.save();
  res.json({ ok: true, model });
});
// Fab manager corrects a rate THEY added (model name and/or rate). Open fab machines of their unit
// entered under the old name are renamed too, so they keep matching the rate.
app.put('/api/staff/fab/rates', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'fabmanager') return bad(res, 'Only the fab manager');
  const cur = FAB.settings(db());
  const list = (cur.contractorRates || []).slice();
  const i = list.findIndex((x) => x.model === str(req.body.oldModel, 120));
  if (i < 0) return bad(res, 'Rate not found – refresh the page');
  if (list[i].addedBy !== p.name) return bad(res, 'Only rates you added can be changed here – ask the admin');
  const model = canonModel(req.body.model);
  if (!model) return bad(res, 'Enter the model no.');
  const rate = Math.max(0, Math.min(100000, Math.round(Number(req.body.rate) || 0)));
  if (!rate) return bad(res, 'Enter the rate ₹');
  const old = list[i].model;
  // the correct model already has a rate: drop this wrong entry (the existing rate stays) and move its machines
  const dup = list.findIndex((x, k) => k !== i && ASM.sameRate(x.model, model));
  if (dup >= 0) list.splice(i, 1);
  else list[i] = { ...list[i], model, rate, editedBy: p.name, editedAt: new Date().toISOString() };
  db().settings.fab = { ...cur, contractorRates: list };
  let renamed = 0;
  if (old !== model) for (const m of db().fab) if (m.model === old && m.unitId === p.unitId && FAB.OPEN.includes(m.status)) { (m.edits = m.edits || []).push({ at: new Date().toISOString(), by: p.name + ' (fab manager)', model: { from: old, to: model } }); m.model = model; renamed++; }
  refreshFabAmounts();
  store.save();
  res.json({ ok: true, model, renamed, merged: dup >= 0 });
});
app.post('/api/staff/fab/:id/assign', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'fabmanager') return bad(res, 'Only the fab manager can give machines to fab leaders');
  const m = fabFind(req, res, (x) => x.unitId === p.unitId);
  if (m) send(res, fabSetPeople(m, req.body, p.name + ' (fab manager)'));
});
// the fab leader for own machines; the fab manager for any machine of the unit
const fabMayWork = (req) => (x) => x.leaderId === req.user.id || (req.user.account.role === 'fabmanager' && (!req.user.account.unitId || x.unitId === req.user.account.unitId));
app.post('/api/staff/fab/:id/start', need('staff'), (req, res) => { const m = fabFind(req, res, fabMayWork(req)); if (m) send(res, fabStart(m, req.user.account.name)); });
app.post('/api/staff/fab/:id/done', need('staff'), (req, res) => { const m = fabFind(req, res, fabMayWork(req)); if (m) send(res, fabDone(m, req.body, req.user.account.name)); });

// Fab (admin)
admin.get('/fab', (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  res.json({
    items: fabSummary(),
    done: db().fab.filter((m) => m.status === 'done' && (m.completedAt || '') >= since).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map(fabView),
    leaders: fabLeaders(),
    helpers: db().people.filter((p) => p.role === 'fabhelper' && p.active && !p.deleted).map((p) => ({ id: p.id, name: p.name, unitId: p.unitId, unitName: unitName(p.unitId) })),
    settings: FAB.settings(db()),
    month: monthOf(req.query.month),
    board: fabBoard(monthOf(req.query.month)),
    painting: paintingView(),
    painters: db().painters.filter((d) => !d.deleted).map((d) => ({ id: d.id, name: d.name, username: d.username, active: !!d.active })),
  });
});
admin.post('/fab', (req, res) => send(res, fabAdd(req.body, 'admin', { role: 'admin', id: 'admin' })));
admin.post('/fab/:id/start', (req, res) => { const m = fabFind(req, res); if (m) send(res, fabStart(m, 'admin')); });
admin.post('/fab/:id/done', (req, res) => { const m = fabFind(req, res); if (m) send(res, fabDone(m, req.body, 'admin')); });
// Give a fab machine to a fab leader / helper by hand (admin, or the unit manager for its unit).
// Leader and helper must be of the machine's unit.
function fabSetPeople(m, body, by) {
  if (!FAB.PENDING.includes(m.status) && m.status !== 'waiting') return { error: 'Only machines not finished can be changed' };
  const leaderId = str(body.leaderId);
  const helperId = str(body.helperId);
  const ok = (id, role) => db().people.some((p) => p.id === id && p.role === role && !p.deleted && p.active && (!m.unitId || p.unitId === m.unitId));
  if (leaderId && !ok(leaderId, 'fableader')) return { error: 'Choose a fab team leader of this unit' };
  if (helperId && !ok(helperId, 'fabhelper')) return { error: 'Choose a fab helper of this unit' };
  (m.edits = m.edits || []).push({ at: new Date().toISOString(), by, from: { leaderId: m.leaderId, helperId: m.helperId }, to: { leaderId, helperId } });
  m.leaderId = leaderId || null; m.helperId = helperId || null;
  if (m.leaderId && m.status === 'waiting') { m.status = 'assigned'; m.assignedAt = new Date().toISOString(); }
  if (!m.leaderId) { m.status = 'waiting'; m.assignedAt = null; m.startedAt = null; }
  m.manual = true;
  store.save();
  return { value: m };
}
// ⇄ Move: not-started fab machines of one model from one fab leader to another (same unit).
function fabMove(body, by, unitId) {
  const from = str(body.fromLeaderId);
  const to = str(body.toLeaderId);
  const model = str(body.model, 120);
  if (body.toBend) {
    // ⇄ Move back to Bending: the machines leave fab (not shown there any more) and go to the
    // unit's bending again, shared fairly between its bending leaders
    const list = db().fab.filter((m) => (from ? m.leaderId === from && m.status === 'assigned' : !m.leaderId && m.status === 'waiting') && m.model === model && (!unitId || m.unitId === unitId));
    if (!list.length) return { error: 'No machine of this model is waiting to start with that fab leader' };
    const qty = Math.max(1, Math.min(list.length, parseInt(body.qty, 10) || 1));
    const at = new Date().toISOString();
    for (const m of list.slice(0, qty)) {
      m.status = 'cancelled'; m.cancelledAt = at; m.cancelledBy = by; m.cancelReason = 'Moved to bending'; m.movedToBend = true;
      db().bend.push({ id: newId('bnd'), unitId: m.unitId, model: m.model, status: 'waiting', createdAt: at, createdBy: `${by} (moved from fab)`, creator: { role: 'fab', id: m.leaderId }, fromFabId: m.id, note: '' });
      m.toBendId = db().bend[db().bend.length - 1].id;
    }
    bendAssign();
    fabAssign();
    store.save();
    return { value: { id: '', moved: qty } };
  }
  if (!to || to === from) return { error: 'Choose the fab leader to move them to' };
  const toP = db().people.find((p) => p.id === to && p.role === 'fableader' && p.active && !p.deleted);
  if (!toP) return { error: 'Choose a fab team leader' };
  const list = db().fab.filter((m) => (from ? m.leaderId === from && m.status === 'assigned' : !m.leaderId && m.status === 'waiting') && m.model === model && (!unitId || m.unitId === unitId));
  if (!list.length) return { error: 'No machine of this model is waiting to start with that fab leader' };
  if (list.some((m) => m.unitId && toP.unitId !== m.unitId)) return { error: 'Choose a fab leader of the same unit' };
  const qty = Math.max(1, Math.min(list.length, parseInt(body.qty, 10) || 1));
  const at = new Date().toISOString();
  for (const m of list.slice(0, qty)) {
    (m.edits = m.edits || []).push({ at, by, from: { leaderId: m.leaderId, helperId: m.helperId }, to: { leaderId: to } });
    m.leaderId = to; m.status = 'assigned'; m.assignedAt = at; m.manual = true;
    m.helperId = null; // a helper of the new leader's unit is picked again
  }
  fabAssign();
  store.save();
  return { value: { id: '', moved: qty } };
}
// Admin corrects a fab order line (fab leader + model): wrong model no., or too many entered.
admin.post(['/fab/correct', '/bend/correct'], (req, res) => {
  const isBend = req.path.startsWith('/bend');
  const leaderId = str(req.body.leaderId);
  const model = str(req.body.model, 120);
  const unitId = str(req.body.unitId);
  const list = db()[isBend ? 'bend' : 'fab'].filter((m) => (m.leaderId || '') === leaderId && m.model === model && FAB.OPEN.includes(m.status) && (!unitId || m.unitId === unitId))
    .sort((a, b) => (a.status === 'started') - (b.status === 'started')); // not started first
  if (!list.length) return bad(res, 'Those machines are no longer open – refresh the page');
  const qty = Math.max(1, Math.min(list.length, parseInt(req.body.qty, 10) || 1));
  const at = new Date().toISOString();
  if (req.body.action === 'remove') {
    const reason = str(req.body.reason, 150);
    if (!reason) return bad(res, 'Write why they are removed');
    for (const m of list.slice(0, qty)) { m.status = 'cancelled'; m.cancelledAt = at; m.cancelledBy = 'admin'; m.cancelReason = reason; }
    if (isBend) bendAssign(); else fabAssign();
    store.save();
    return res.json({ ok: true, changed: qty });
  }
  const newModel = canonModel(req.body.newModel);
  if (!newModel) return bad(res, 'Enter the correct model no.');
  if (newModel === model) return bad(res, 'The model no. is the same');
  if (!isBend) { const miss = fabRateMissing(newModel); if (miss) return bad(res, miss); }
  for (const m of list.slice(0, qty)) { (m.edits = m.edits || []).push({ at, by: 'admin', model: { from: m.model, to: newModel } }); m.model = newModel; }
  store.save();
  res.json({ ok: true, changed: qty, model: newModel });
});
admin.post('/fab/move', (req, res) => { const r = fabMove(req.body, 'admin'); if (r.error) return bad(res, r.error); res.json({ ok: true, ...r.value }); });
unit.post('/fab/move', (req, res) => { const r = fabMove(req.body, (req.user.account.name || req.user.account.username) + ' (unit)', req.user.id); if (r.error) return bad(res, r.error); res.json({ ok: true, ...r.value }); });
app.post('/api/staff/fab/move', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'fabmanager') return bad(res, 'Only the fab manager can move machines');
  const r = fabMove(req.body, p.name + ' (fab manager)', p.unitId);
  if (r.error) return bad(res, r.error);
  res.json({ ok: true, ...r.value });
});
admin.post('/fab/:id/assign', (req, res) => { const m = fabFind(req, res); if (m) send(res, fabSetPeople(m, req.body, 'admin')); });
// Unit login: its own fab – enter machines and share them between its fab leaders.
const unitFabPeople = (unitId, role) => db().people.filter((p) => p.role === role && p.active && !p.deleted && p.unitId === unitId).map((p) => ({ id: p.id, name: p.name, unitName: unitName(p.unitId), pending: FAB.pendingOf(db(), p.id) }));
unit.get('/fab', (req, res) => {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  res.json({
    items: db().fab.filter((m) => m.unitId === req.user.id && FAB.OPEN.includes(m.status)).map(fabView),
    done: db().fab.filter((m) => m.unitId === req.user.id && m.status === 'done' && (m.completedAt || '') >= since).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).map(fabView),
    leaders: unitFabPeople(req.user.id, 'fableader'),
    helpers: unitFabPeople(req.user.id, 'fabhelper'),
    maxPending: FAB.settings(db()).maxPending,
  });
});
unit.post('/fab', (req, res) => {
  const a = req.user.account;
  send(res, fabAdd({ ...req.body, unitId: req.user.id }, (a.name || a.username) + ' (unit)', { role: 'unit', id: req.user.id }));
});
unit.post('/fab/:id/assign', (req, res) => {
  const m = fabFind(req, res, (x) => x.unitId === req.user.id);
  if (m) send(res, fabSetPeople(m, req.body, (req.user.account.name || req.user.account.username) + ' (unit)'));
});
admin.post('/fab/:id/cancel', (req, res) => {
  const m = fabFind(req, res);
  if (!m) return;
  if (!FAB.OPEN.includes(m.status)) return bad(res, 'Only machines not finished can be cancelled');
  m.status = 'cancelled'; m.cancelledAt = new Date().toISOString(); m.cancelReason = str(req.body.reason, 150);
  fabAssign();
  store.save();
  res.json({ ok: true });
});
// The whole fab rate list from the editor (admin or fab manager). New rows remember who added them.
function readFabRates(rows, cur, by) {
  const money = (v) => Math.max(0, Math.min(100000, Math.round(Number(v) || 0)));
  const out = [];
  for (const x of rows) {
    const model = canonModel(x && x.model);
    if (!model || out.some((o) => ASM.sameRate(o.model, model))) continue; // no empty / double rows
    const old = (cur.contractorRates || []).find((o) => ASM.sameRate(o.model, model));
    const keep = (k) => (x && x[k] !== undefined && x[k] !== '' ? { [k]: money(x[k]) } : old && old[k] ? { [k]: old[k] } : {});
    out.push({ model, rate: money(x && x.rate), ...keep('payroll'), ...keep('payrollLeader'), ...(old && old.addedBy ? { addedBy: old.addedBy, addedAt: old.addedAt } : !old && by ? { addedBy: by, addedAt: new Date().toISOString() } : {}) });
  }
  return out.slice(0, 300);
}
app.put('/api/staff/fab/rates/all', need('staff'), (req, res) => {
  const p = req.user.account;
  if (p.role !== 'fabmanager') return bad(res, 'Only the fab manager');
  if (!Array.isArray(req.body.contractorRates)) return bad(res, 'Nothing to save');
  { const dup = duplicateIn(req.body.contractorRates, 'fab rate'); if (dup) return bad(res, dup); }
  const cur = FAB.settings(db());
  db().settings.fab = { ...cur, contractorRates: readFabRates(req.body.contractorRates, cur, p.name) };
  refreshFabAmounts();
  store.save();
  res.json({ ok: true });
});
admin.put('/fab/settings', (req, res) => {
  { const dup = Array.isArray(req.body.contractorRates) && duplicateIn(req.body.contractorRates, 'fab rate'); if (dup) return bad(res, dup); }
  const cur = FAB.settings(db());
  db().settings.fab = {
    ...cur,
    maxPending: req.body.maxPending !== undefined ? Math.max(1, Math.min(100, parseInt(req.body.maxPending, 10) || 10)) : cur.maxPending,
    contractorRates: Array.isArray(req.body.contractorRates) ? readFabRates(req.body.contractorRates, cur, '') : cur.contractorRates || [],
  };
  refreshFabAmounts();
  fabAssign();
  store.save();
  res.json({ ok: true });
});
// Painting logins (admin)
admin.post('/painters', (req, res) => {
  const name = str(req.body.name, 80);
  const username = norm(req.body.username);
  const password = String(req.body.password || '');
  if (!name) return bad(res, 'Name is required');
  if (!/^[a-z0-9._@-]{3,40}$/.test(username)) return bad(res, 'Login ID must be 3-40 letters/numbers (no spaces)');
  if (db().painters.some((d) => !d.deleted && d.username === username)) return bad(res, 'This login ID is already used');
  if (password.length < 4) return bad(res, 'Password must be at least 4 characters');
  db().painters.push({ id: newId('pnr'), name, username, passHash: auth.hashPassword(password), active: true });
  store.save();
  res.json({ ok: true });
});
admin.put('/painters/:id', (req, res) => {
  const d = db().painters.find((x) => x.id === req.params.id && !x.deleted);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (req.body.active !== undefined) d.active = !!req.body.active;
  if (req.body.password) { if (String(req.body.password).length < 4) return bad(res, 'Password must be at least 4 characters'); d.passHash = auth.hashPassword(String(req.body.password)); }
  store.save();
  res.json({ ok: true });
});
admin.delete('/painters/:id', (req, res) => {
  const d = db().painters.find((x) => x.id === req.params.id && !x.deleted);
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.deleted = true; d.active = false;
  store.save();
  res.json({ ok: true });
});

app.use('/api/admin', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// The page asks for app.js / style.css with ?v=<version>, so phones always load the newest code after a deploy.
const INDEX_HTML = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('/app.js"', `/app.js?v=${VERSION}"`).replace('/style.css"', `/style.css?v=${VERSION}"`);
app.get(/.*/, (req, res) => { res.setHeader('Cache-Control', 'no-cache, no-store'); res.type('html').send(INDEX_HTML); });

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.set('trust proxy', 1);
  app.listen(PORT, () => console.log(`Delivery team allocation running on http://localhost:${PORT}`));
  // Keep the client / machine lists fresh: on start, then every 3 hours.
  const auto = () => syncSheet().then((r) => r.error && db().sheet.scriptUrl + db().sheet.sheetLink && console.log('Sheet sync:', r.error));
  setTimeout(auto, 5000);
  setInterval(auto, 3 * 60 * 60 * 1000);
}

module.exports = app;
