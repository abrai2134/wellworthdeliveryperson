// Fab section: machines are shared fairly between the fab team leaders, each machine with one
// fab helper. When fab is done the machine goes to Painting; from Painting it goes to a unit's
// assembly (server.js).
const { todayIn } = require('./dates');

const OPEN = ['waiting', 'assigned', 'started'];
const PENDING = ['assigned', 'started'];

// The same allocation is used for Fab (db.fab, fab leaders + fab helpers) and Bending
// (db.bend, bending leaders, no helper). `k` picks the section.
const KINDS = {
  fab: { coll: 'fab', leader: 'fableader', helper: 'fabhelper', set: 'fab' },
  bend: { coll: 'bend', leader: 'bendleader', helper: null, set: 'bend' },
};
function settings(db, k = 'fab') {
  return { maxPending: 10, ...(db.settings[KINDS[k].set] || {}) };
}

function onLeave(db, personId, date) {
  return db.leaves.some((l) => l.personId === personId && l.from <= date && date <= l.to);
}

const fabPeople = (db, role) => db.people.filter((p) => p.role === role && p.active && !p.deleted);

const coll = (db, k) => db[KINDS[k].coll] || (db[KINDS[k].coll] = []);
function pendingOf(db, leaderId, k = 'fab') {
  return coll(db, k).filter((m) => m.leaderId === leaderId && PENDING.includes(m.status)).length;
}
function totalOf(db, leaderId, k = 'fab') {
  return coll(db, k).filter((m) => m.leaderId === leaderId && m.status !== 'cancelled').length;
}
function helperLoad(db, helperId, k = 'fab') {
  return coll(db, k).filter((m) => m.helperId === helperId && m.status !== 'cancelled').length;
}

// Small stable number to break ties differently for each machine.
function tie(a, b) {
  let h = 2166136261;
  for (const ch of a + '|' + b) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 1000;
}

// Only fab people of the machine's unit (machines entered before units were used: anyone).
const sameUnit = (p, m) => !m.unitId || p.unitId === m.unitId;

function pickHelper(db, m, date, k = 'fab') {
  if (!KINDS[k].helper) return;
  const pool = fabPeople(db, KINDS[k].helper).filter((p) => !onLeave(db, p.id, date) && sameUnit(p, m));
  pool.sort((a, b) => helperLoad(db, a.id, k) - helperLoad(db, b.id, k) || tie(a.id, m.id) - tie(b.id, m.id));
  if (!m.helperId && pool[0]) m.helperId = pool[0].id;
}

// Give waiting machines to the fab leader with the fewest open machines (oldest machines first).
function assignWaiting(db, timezone, k = 'fab') {
  if (k === 'fab' && arguments.length < 3) assignWaiting(db, timezone, 'bend'); // bending too
  const K = KINDS[k];
  const list = coll(db, k);
  const date = todayIn(timezone);
  for (const m of list) {
    if (m.status !== 'assigned' || !m.leaderId) continue;
    const l = db.people.find((p) => p.id === m.leaderId);
    if (!l || l.deleted || !l.active || l.role !== K.leader || !sameUnit(l, m)) { m.leaderId = null; m.status = 'waiting'; m.assignedAt = null; }
  }
  const max = Math.max(1, Number(settings(db, k).maxPending) || 10);
  const waiting = list.filter((m) => m.status === 'waiting').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const m of waiting) {
    const free = fabPeople(db, K.leader).filter((p) => sameUnit(p, m) && !onLeave(db, p.id, date) && pendingOf(db, p.id, k) < max);
    if (!free.length) continue;
    free.sort((a, b) => pendingOf(db, a.id, k) - pendingOf(db, b.id, k) || totalOf(db, a.id, k) - totalOf(db, b.id, k) || tie(a.id, m.id) - tie(b.id, m.id));
    m.leaderId = free[0].id;
    m.status = 'assigned';
    m.assignedAt = new Date().toISOString();
    pickHelper(db, m, date, k);
  }
  for (const m of list) if (PENDING.includes(m.status) && !m.helperId) pickHelper(db, m, date, k);
}

module.exports = { KINDS, OPEN, PENDING, settings, pendingOf, assignWaiting };
