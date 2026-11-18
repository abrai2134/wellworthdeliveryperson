const test = require('node:test');
const assert = require('node:assert');
const FAB = require('../lib/fab');
const S = require('../lib/scheduler');
const { defaults } = require('../lib/store');

test('fab machines are shared between fab leaders, each with a fab helper, up to the pending limit', () => {
  const db = defaults();
  db.units.push({ id: 'u1', name: 'U1', active: true });
  db.people.push(
    { id: 'F1', name: 'Fab 1', role: 'fableader', unitId: 'u1', active: true },
    { id: 'F2', name: 'Fab 2', role: 'fableader', unitId: 'u1', active: true },
    { id: 'H1', name: 'Help 1', role: 'fabhelper', unitId: 'u1', active: true },
    { id: 'H2', name: 'Help 2', role: 'fabhelper', unitId: 'u1', active: true },
  );
  db.settings.fab = { maxPending: 2 };
  for (let i = 0; i < 5; i++) db.fab.push({ id: 'f' + i, model: 'X', status: 'waiting', createdAt: String(i) });
  FAB.assignWaiting(db, 'Asia/Kolkata');
  assert.equal(FAB.pendingOf(db, 'F1'), 2);
  assert.equal(FAB.pendingOf(db, 'F2'), 2);
  assert.equal(db.fab.filter((m) => m.status === 'waiting').length, 1); // both leaders full
  assert.ok(db.fab.filter((m) => m.status === 'assigned').every((m) => ['H1', 'H2'].includes(m.helperId)));
});

test('fab people are never picked for deliveries or loading', () => {
  assert.ok(S.ROLES.includes('fableader') && S.ROLES.includes('fabhelper'));
});

test('fab machines go only to fab leaders and helpers of their own unit', () => {
  const db = defaults();
  db.units.push({ id: 'u1', name: '814', active: true }, { id: 'u2', name: '816', active: true });
  db.people.push(
    { id: 'A', name: 'Fab 814', role: 'fableader', unitId: 'u1', active: true },
    { id: 'B', name: 'Fab 816', role: 'fableader', unitId: 'u2', active: true },
    { id: 'HA', name: 'Help 814', role: 'fabhelper', unitId: 'u1', active: true },
    { id: 'HB', name: 'Help 816', role: 'fabhelper', unitId: 'u2', active: true },
  );
  for (let i = 0; i < 4; i++) db.fab.push({ id: 'x' + i, unitId: 'u2', model: 'X', status: 'waiting', createdAt: String(i) });
  FAB.assignWaiting(db, 'Asia/Kolkata');
  assert.ok(db.fab.every((m) => m.leaderId === 'B' && m.helperId === 'HB'));
});

test('bending machines go only to bending leaders of their unit (no helper)', () => {
  const db = defaults();
  db.units.push({ id: 'u1', name: '814', active: true }, { id: 'u2', name: '816', active: true });
  db.people.push(
    { id: 'B1', name: 'Bend 814', role: 'bendleader', unitId: 'u1', active: true },
    { id: 'B2', name: 'Bend 816', role: 'bendleader', unitId: 'u2', active: true },
    { id: 'H1', name: 'Fab help', role: 'fabhelper', unitId: 'u2', active: true },
  );
  for (let i = 0; i < 3; i++) db.bend.push({ id: 'b' + i, unitId: 'u2', model: 'X', status: 'waiting', createdAt: String(i) });
  FAB.assignWaiting(db, 'Asia/Kolkata', 'bend');
  assert.ok(db.bend.every((m) => m.leaderId === 'B2' && !m.helperId));
  assert.equal(FAB.pendingOf(db, 'B2', 'bend'), 3);
});
