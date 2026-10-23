const path = require('path');
const express = require('express');
const { Store, newId } = require('./lib/store');
const auth = require('./lib/auth');
const S = require('./lib/scheduler');
const { todayIn, addDays, range, isValid } = require('./lib/dates');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const store = new Store(path.join(DATA_DIR, 'db.json'));
const db = () => store.db;

const SESSION_DAYS = 30;
const COOKIE = 'wd_session';
const BOOK_AHEAD_DAYS = 90;

// ---------- first run: create the admin account ----------
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
  store.save();
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  res.json({ orgName: db().settings.orgName, sessions: S.SESSIONS, maxHelpers: S.MAX_HELPERS });
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
  if (!account || !auth.verifyPassword(password, account.passHash)) {
    rec.count++;
    return res.status(401).json({ error: 'Wrong username or password' });
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
  return {
    id: d.id,
    unitId: d.unitId,
    unitName: unitName(d.unitId),
    date: d.date,
    session: d.session,
    customer: d.customer || '',
    customerPhone: d.customerPhone || '',
    address: d.address || '',
    machine: d.machine || '',
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

function readDelivery(body, unitId) {
  const t = today();
  const date = str(body.date);
  if (!isValid(date)) return { error: 'Choose a delivery date' };
  if (date < t) return { error: 'The date cannot be in the past' };
  if (date > addDays(t, BOOK_AHEAD_DAYS)) return { error: `You can book up to ${BOOK_AHEAD_DAYS} days ahead` };
  const session = S.SESSIONS.includes(body.session) ? body.session : 'FULL';
  const helpersNeeded = Math.max(0, Math.min(S.MAX_HELPERS, parseInt(body.helpersNeeded, 10) || 0));
  const installation = body.installation === true || body.installation === 'on' || body.installation === 'yes';
  if (!helpersNeeded && !installation) return { error: 'Ask for at least one helper or an installation person' };
  if (!liveUnit(unitId)) return { error: 'Choose a unit' };
  return {
    value: {
      unitId,
      date,
      session,
      helpersNeeded,
      installation,
      customer: str(body.customer, 120),
      customerPhone: str(body.customerPhone, 30),
      address: str(body.address, 300),
      machine: str(body.machine, 120),
      notes: str(body.notes, 500),
    },
  };
}
const liveUnit = (id) => db().units.find((u) => u.id === id && u.active && !u.deleted);

function createDelivery(body, unitId, by) {
  const r = readDelivery(body, unitId);
  if (r.error) return r;
  const d = { id: newId('dlv'), ...r.value, status: 'planned', excluded: [], createdBy: by, createdAt: new Date().toISOString() };
  db().deliveries.push(d);
  S.repairDate(db(), d.date);
  store.save();
  return { value: d };
}

function updateDelivery(d, body) {
  if (d.status === 'cancelled') return { error: 'This delivery was cancelled' };
  if (d.date < today()) return { error: 'Past deliveries cannot be changed' };
  const r = readDelivery(body, d.unitId);
  if (r.error) return r;
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
  if (d.date < today()) return { error: 'Past deliveries cannot be changed' };
  d.status = 'cancelled';
  db().assignments = db().assignments.filter((a) => a.deliveryId !== d.id);
  S.repairDate(db(), d.date); // people are free again for other deliveries that day
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
  if (!S.removeExtra(db(), d.id, Number(body.slot))) return { error: 'Nothing to cancel' };
  S.repairDate(db(), d.date);
  store.save();
  return { value: d };
}

function replace(d, body) {
  if (d.date < today()) return { error: 'Past deliveries cannot be changed' };
  try {
    S.replacePerson(db(), d.id, str(body.personId));
  } catch (e) {
    return { error: e.message };
  }
  store.save();
  return { value: d };
}

const send = (res, r) => (r.error ? bad(res, r.error) : res.json({ ok: true, id: r.value && r.value.id }));

// ---------- unit login ----------
const unit = express.Router();
unit.use(need('unit'));

unit.get('/home', (req, res) => {
  const u = req.user.account;
  const t = today();
  const deliveries = db()
    .deliveries.filter((d) => d.unitId === u.id && d.date >= addDays(t, -7) && d.status !== 'cancelled')
    .sort((a, b) => a.date.localeCompare(b.date) || a.session.localeCompare(b.session))
    .map(deliveryView);
  res.json({ today: t, unit: unitView(u), deliveries, defaultHelpers: db().settings.defaultHelpers || 2, bookAhead: BOOK_AHEAD_DAYS });
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
unit.post('/deliveries/:id/replace', (req, res) => { const d = ownDelivery(req, res); if (d) send(res, replace(d, req.body)); });

app.use('/api/unit', unit);

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
  res.json({ today: t, me: personView(p), jobs, monthDuties, leaves });
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

admin.get('/stats', (req, res) => {
  const t = today();
  const from = isValid(req.query.from) ? req.query.from : addDays(t, -29);
  const to = isValid(req.query.to) ? req.query.to : addDays(t, 30);
  const list = db().assignments.filter((a) => a.date >= from && a.date <= to);
  const people = db().people.filter((p) => !p.deleted);
  const units = db().units.filter((u) => !u.deleted);
  const rows = people.map((p) => {
    const mine = list.filter((a) => a.personId === p.id);
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
      leaveDays,
      perUnit,
    };
  });
  const deliveries = db().deliveries.filter((d) => d.date >= from && d.date <= to && d.status !== 'cancelled').length;
  const unfilled = list.filter((a) => !a.personId).length;
  res.json({ from, to, units: units.map((u) => ({ id: u.id, name: u.name })), rows, deliveries, unfilled });
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
    value: { name, phone, username, role, unitId, backup: !!body.backup, active: body.active !== false },
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
  changed();
  res.json({ ok: true });
});

admin.put('/people/:id', (req, res) => {
  const p = db().people.find((x) => x.id === req.params.id && !x.deleted);
  if (!p) return res.status(404).json({ error: 'Person not found' });
  const r = readPerson(req.body, p);
  if (r.error) return bad(res, r.error);
  const wasActive = p.active;
  Object.assign(p, r.value);
  if (r.password) p.passHash = auth.hashPassword(r.password);
  if (req.body.removeLogin) p.passHash = null;
  if (!wasActive && p.active) S.alignBaseline(db(), p);
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
admin.post('/deliveries/:id/replace', (req, res) => { const d = anyDelivery(req, res); if (d) send(res, replace(d, req.body)); });

admin.post('/deliveries/:id/assign', (req, res) => {
  const d = anyDelivery(req, res);
  if (!d) return;
  if (d.date < today()) return bad(res, 'Past deliveries cannot be changed');
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
  if (b.defaultHelpers !== undefined) s.defaultHelpers = Math.max(0, Math.min(S.MAX_HELPERS, parseInt(b.defaultHelpers, 10) || 2));
  store.save();
  res.json({ ok: true });
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

app.use('/api/admin', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.set('trust proxy', 1);
  app.listen(PORT, () => console.log(`Delivery team allocation running on http://localhost:${PORT}`));
}

module.exports = app;
