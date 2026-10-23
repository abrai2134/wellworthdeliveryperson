const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/scheduler');
const { defaults } = require('../lib/store');
const { addDays } = require('../lib/dates');

// nUnits units; each has `helpers` helpers and `installers` installation persons.
function setup(nUnits, helpers, installers) {
  const db = defaults();
  for (let u = 1; u <= nUnits; u++) {
    db.units.push({ id: 'u' + u, name: 'Unit ' + u, active: true });
    for (let i = 1; i <= helpers; i++) db.people.push({ id: `h${u}_${i}`, name: `Helper ${u}-${i}`, unitId: 'u' + u, role: 'helper', active: true });
    for (let i = 1; i <= installers; i++) db.people.push({ id: `i${u}_${i}`, name: `Installer ${u}-${i}`, unitId: 'u' + u, role: 'installer', active: true });
  }
  return db;
}
let seq = 0;
function book(db, unitId, date, helpersNeeded, installation, session = 'FULL') {
  const d = { id: 'd' + ++seq, unitId, date, session, helpersNeeded, installation, status: 'planned', createdAt: String(seq).padStart(6, '0') };
  db.deliveries.push(d);
  S.repairDate(db, date);
  return d;
}
const counts = (db) => {
  const c = {};
  for (const a of db.assignments) if (a.personId) c[a.personId] = (c[a.personId] || 0) + 1;
  return c;
};
const spread = (c, ids) => { const v = ids.map((id) => c[id] || 0); return Math.max(...v) - Math.min(...v); };

test('helpers and installers from all units share the work equally', () => {
  const db = setup(3, 3, 1); // 9 helpers, 3 installers
  let date = '2026-01-01';
  for (let day = 0; day < 30; day++) {
    book(db, 'u' + ((day % 3) + 1), date, 3, true);
    if (day % 2) book(db, 'u' + (((day + 1) % 3) + 1), date, 2, false, 'PM');
    date = addDays(date, 1);
  }
  const c = counts(db);
  const helpers = db.people.filter((p) => p.role === 'helper').map((p) => p.id);
  const installers = db.people.filter((p) => p.role === 'installer').map((p) => p.id);
  assert.ok(spread(c, helpers) <= 1, 'helpers ' + JSON.stringify(c));
  assert.ok(spread(c, installers) <= 1, 'installers ' + JSON.stringify(c));
  // helpers are mixed: a unit's deliveries use helpers from other units too
  const fromOther = db.assignments.filter((a) => a.personId && a.role === 'helper' && !a.personId.startsWith('h' + a.unitId.slice(1) + '_'));
  assert.ok(fromOther.length > 0);
});

test('booking out of order is still fair', () => {
  const db = setup(2, 2, 1);
  const dates = ['2026-02-10', '2026-02-01', '2026-02-05', '2026-02-03', '2026-02-08', '2026-02-02'];
  for (const d of dates) book(db, 'u1', d, 2, false);
  const helpers = db.people.filter((p) => p.role === 'helper').map((p) => p.id);
  assert.ok(spread(counts(db), helpers) <= 1);
});

test('nobody is in two places at the same time; AM and PM can share people', () => {
  const db = setup(1, 3, 0); // only 3 helpers
  const a = book(db, 'u1', '2026-03-01', 3, false, 'AM');
  const b = book(db, 'u1', '2026-03-01', 3, false, 'PM');
  const full = book(db, 'u1', '2026-03-02', 2, false, 'FULL');
  const am = book(db, 'u1', '2026-03-02', 2, false, 'AM');
  assert.equal(S.teamOf(db, a.id).filter((x) => x.personId).length, 3);
  assert.equal(S.teamOf(db, b.id).filter((x) => x.personId).length, 3);
  const t1 = S.teamOf(db, full.id).filter((x) => x.personId).map((x) => x.personId);
  const t2 = S.teamOf(db, am.id).filter((x) => x.personId).map((x) => x.personId);
  assert.equal(t1.length, 2);
  assert.equal(t2.length, 1); // only one helper left for the morning delivery
  assert.ok(!t2.some((id) => t1.includes(id)));
});

test('backup people are used only when regular people run short', () => {
  const db = setup(1, 2, 0);
  db.people.push({ id: 'b1', name: 'Backup', unitId: 'u1', role: 'helper', backup: true, active: true });
  const d1 = book(db, 'u1', '2026-04-01', 2, false);
  assert.ok(!S.teamOf(db, d1.id).some((a) => a.personId === 'b1'));
  const d2 = book(db, 'u1', '2026-04-02', 3, false);
  assert.ok(S.teamOf(db, d2.id).some((a) => a.personId === 'b1' && a.backup));
});

test('leave, replace and emergency extra', () => {
  const db = setup(2, 2, 1);
  const d1 = book(db, 'u1', '2026-05-01', 2, true);
  const d2 = book(db, 'u2', '2026-05-01', 1, false);
  const team = S.teamOf(db, d1.id).filter((a) => a.role === 'helper').map((a) => a.personId);
  // a helper is on leave -> replaced, other team members stay
  db.leaves.push({ id: 'l1', personId: team[0], from: '2026-05-01', to: '2026-05-01' });
  S.repairDate(db, '2026-05-01');
  const after = S.teamOf(db, d1.id).filter((a) => a.role === 'helper').map((a) => a.personId);
  assert.ok(!after.includes(team[0]));
  assert.ok(after.includes(team[1]));
  // unit sends someone back
  S.replacePerson(db, d1.id, team[1]);
  assert.ok(!S.teamOf(db, d1.id).some((a) => a.personId === team[1]));
  // emergency: take the person working on delivery 2; delivery 2 is refilled if anyone is free
  const st = S.personStatus(db, d1.id);
  const busyElsewhere = st.find((x) => x.status === 'other');
  assert.ok(busyElsewhere);
  S.addExtra(db, d1.id, busyElsewhere.person.id, { reason: 'heavy machine' });
  S.repairDate(db, '2026-05-01');
  assert.ok(S.teamOf(db, d1.id).some((a) => a.extra && a.personId === busyElsewhere.person.id));
  assert.ok(!S.teamOf(db, d2.id).some((a) => a.personId === busyElsewhere.person.id));
  // never double-booked
  const ids = db.assignments.filter((a) => a.personId).map((a) => a.personId);
  assert.equal(new Set(ids).size, ids.length);
});

test('admin change swaps two people', () => {
  const db = setup(1, 4, 0);
  const d1 = book(db, 'u1', '2026-06-01', 2, false);
  const d2 = book(db, 'u1', '2026-06-01', 2, false);
  const x = S.teamOf(db, d1.id)[0];
  const y = S.teamOf(db, d2.id)[0];
  const [px, py] = [x.personId, y.personId];
  S.setManual(db, d1.id, 'helper', x.slot, py);
  assert.equal(S.teamOf(db, d1.id).find((a) => a.slot === x.slot).personId, py);
  assert.equal(S.teamOf(db, d2.id).find((a) => a.slot === y.slot).personId, px);
});
