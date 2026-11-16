// Fab section: machines are shared fairly between the fab team leaders, each machine with one
// fab helper. When fab is done the machine goes to Painting; from Painting it goes to a unit's
// assembly (server.js).
const { todayIn } = require('./dates');

const OPEN = ['waiting', 'assigned', 'started'];
const PENDING = ['assigned', 'started'];

function settings(db) {
  return { maxPending: 10, ...(db.settings.fab || {}) };
}

function onLeave(db, personId, date) {
  return db.leaves.some((l) => l.personId === personId && l.from <= date && date <= l.to);
}

const fabPeople = (db, role) => db.people.filter((p) => p.role === role && p.active && !p.deleted);

function pendingOf(db, leaderId) {
  return db.fab.filter((m) => m.leaderId === leaderId && PENDING.includes(m.status)).length;
}
function totalOf(db, leaderId) {
  return db.fab.filter((m) => m.leaderId === leaderId && m.status !== 'cancelled').length;
}
function helperLoad(db, helperId) {
  return db.fab.filter((m) => m.helperId === helperId && m.status !== 'cancelled').length;
}

// Small stable number to break ties differently for each machine.
function tie(a, b) {
  let h = 2166136261;
  for (const ch of a + '|' + b) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 1000;
}

// Only fab people of the machine's unit (machines entered before units were used: anyone).
const sameUnit = (p, m) => !m.unitId || p.unitId === m.unitId;

function pickHelper(db, m, date) {
  const pool = fabPeople(db, 'fabhelper').filter((p) => !onLeave(db, p.id, date) && sameUnit(p, m));
  pool.sort((a, b) => helperLoad(db, a.id) - helperLoad(db, b.id) || tie(a.id, m.id) - tie(b.id, m.id));
  if (!m.helperId && pool[0]) m.helperId = pool[0].id;
}

// Give waiting machines to the fab leader with the fewest open machines (oldest machines first).
function assignWaiting(db, timezone) {
  const date = todayIn(timezone);
  for (const m of db.fab) {
    if (m.status !== 'assigned' || !m.leaderId) continue;
    const l = db.people.find((p) => p.id === m.leaderId);
    if (!l || l.deleted || !l.active || l.role !== 'fableader' || !sameUnit(l, m)) { m.leaderId = null; m.status = 'waiting'; m.assignedAt = null; }
  }
  const max = Math.max(1, Number(settings(db).maxPending) || 10);
  const waiting = db.fab.filter((m) => m.status === 'waiting').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const m of waiting) {
    const free = fabPeople(db, 'fableader').filter((p) => sameUnit(p, m) && !onLeave(db, p.id, date) && pendingOf(db, p.id) < max);
    if (!free.length) continue;
    free.sort((a, b) => pendingOf(db, a.id) - pendingOf(db, b.id) || totalOf(db, a.id) - totalOf(db, b.id) || tie(a.id, m.id) - tie(b.id, m.id));
    m.leaderId = free[0].id;
    m.status = 'assigned';
    m.assignedAt = new Date().toISOString();
    pickHelper(db, m, date);
  }
  for (const m of db.fab) if (PENDING.includes(m.status) && !m.helperId) pickHelper(db, m, date);
}

module.exports = { OPEN, PENDING, settings, pendingOf, assignWaiting };
