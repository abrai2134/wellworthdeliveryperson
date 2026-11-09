const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/assembly');
const { defaults } = require('../lib/store');

function setup() {
  const db = defaults();
  db.assembly = [];
  db.units.push({ id: 'u1', name: 'Unit 1', active: true }, { id: 'u2', name: 'Unit 2', active: true });
  for (let i = 1; i <= 3; i++) db.people.push({ id: 'L' + i, name: 'Leader ' + i, role: 'leader', unitId: 'u1', active: true });
  db.people.push({ id: 'L9', name: 'Leader other unit', role: 'leader', unitId: 'u2', active: true });
  db.people.push({ id: 'i1', name: 'Inst 1', role: 'installer', unitId: 'u1', active: true }, { id: 'i2', name: 'Inst 2', role: 'installer', unitId: 'u1', active: true });
  db.people.push({ id: 'h1', name: 'Help 1', role: 'helper', unitId: 'u1', active: true }, { id: 'h2', name: 'Help 2', role: 'helper', unitId: 'u1', active: true });
  return db;
}
let n = 0;
const add = (db, qty, unitId = 'u1', model = 'FT224BK') => {
  for (let i = 0; i < qty; i++) db.assembly.push({ id: 'm' + ++n, unitId, model, status: 'waiting', createdAt: String(n).padStart(6, '0') });
  A.assignWaiting(db, 'Asia/Kolkata');
};
const finish = (db, leaderId, k = 1) => {
  db.assembly.filter((m) => m.leaderId === leaderId && m.status === 'assigned').slice(0, k).forEach((m) => {
    m.status = 'done'; m.startedAt = '2026-11-08T04:00:00Z'; m.completedAt = '2026-11-08T08:00:00Z'; m.incentive = A.incentiveFor(db, m.model);
  });
  A.assignWaiting(db, 'Asia/Kolkata');
};

test('machines are shared equally between the unit\'s team leaders, with 1 installer + 1 helper', () => {
  const db = setup();
  add(db, 9);
  const c = {};
  for (const m of db.assembly) c[m.leaderId] = (c[m.leaderId] || 0) + 1;
  assert.deepEqual(c, { L1: 3, L2: 3, L3: 3 });
  assert.ok(db.assembly.every((m) => ['i1', 'i2'].includes(m.installerId) && ['h1', 'h2'].includes(m.helperId)));
  const ic = db.assembly.filter((m) => m.installerId === 'i1').length;
  assert.ok(Math.abs(ic - (9 - ic)) <= 1); // installers rotated
});

test('no new machine above the pending limit; it waits and goes out when work is finished', () => {
  const db = setup();
  db.settings.assembly = { maxPending: 2 };
  add(db, 7); // 3 leaders x 2 = 6 given, 1 waiting
  assert.equal(db.assembly.filter((m) => m.status === 'waiting').length, 1);
  assert.ok(['L1', 'L2', 'L3'].every((id) => A.pendingOf(db, id) === 2));
  finish(db, 'L2');
  assert.equal(db.assembly.filter((m) => m.status === 'waiting').length, 0);
  assert.equal(A.pendingOf(db, 'L2'), 2); // L2 got the waiting machine
});

test('incentive per model and scoreboard', () => {
  const db = setup();
  db.settings.assembly = { maxPending: 6, defaultLeader: 100, defaultInstaller: 50, incentives: [{ model: 'TP150~C2', leader: 300, installer: 150 }] };
  add(db, 3, 'u1', 'TP150~C2');
  finish(db, 'L1');
  const b = A.board(db, '2026-11');
  const l1 = b.leaders.find((r) => r.id === 'L1');
  assert.equal(l1.done, 1);
  assert.equal(l1.incentive, 300);
  assert.equal(l1.avgMinutes, 240);
  assert.equal(b.installers[0].incentive, 150);
  assert.equal(A.incentiveFor(db, 'other').leader, 100);
});

test('a new team leader starts level', () => {
  const db = setup();
  add(db, 6);
  const p = { id: 'L4', name: 'New', role: 'leader', unitId: 'u1', active: true };
  db.people.push(p);
  A.alignLeader(db, p);
  add(db, 4);
  const c = {};
  for (const m of db.assembly) c[m.leaderId] = (c[m.leaderId] || 0) + 1;
  assert.ok(c.L4 <= 2, JSON.stringify(c)); // not flooded with all 4
});

test('removing a team leader sends their unfinished machines to the others', () => {
  const db = setup();
  add(db, 6);
  db.people.find((p) => p.id === 'L2').deleted = true;
  A.assignWaiting(db, 'Asia/Kolkata');
  const c = {};
  for (const m of db.assembly) c[m.leaderId] = (c[m.leaderId] || 0) + 1;
  assert.equal(c.L2, undefined);
  assert.equal((c.L1 || 0) + (c.L3 || 0), 6);
});

test('machines waiting with no leader are given out when a leader is added', () => {
  const db = setup();
  db.people = db.people.filter((p) => p.role !== 'leader');
  add(db, 4);
  assert.equal(db.assembly.filter((m) => m.status === 'waiting').length, 4);
  db.people.push({ id: 'N1', name: 'New 1', role: 'leader', unitId: 'u1', active: true }, { id: 'N2', name: 'New 2', role: 'leader', unitId: 'u1', active: true });
  A.assignWaiting(db, 'Asia/Kolkata');
  const c = {};
  for (const m of db.assembly) c[m.leaderId] = (c[m.leaderId] || 0) + 1;
  assert.deepEqual(c, { N1: 2, N2: 2 });
  assert.ok(db.assembly.every((m) => m.installerId && m.helperId));
});

test('a leader added later gets an equal share of machines not started yet', () => {
  const db = setup();
  db.people = db.people.filter((p) => p.role !== 'leader');
  add(db, 4); // nobody to give to
  const r = { id: 'R', name: 'Ravi', role: 'leader', unitId: 'u1', active: true };
  db.people.push(r); A.alignLeader(db, r); A.assignWaiting(db, 'Asia/Kolkata');
  assert.equal(A.pendingOf(db, 'R'), 4);
  db.assembly.find((m) => m.leaderId === 'R').status = 'started'; // Ravi already started one
  const so = { id: 'S', name: 'Sohail', role: 'leader', unitId: 'u1', active: true };
  db.people.push(so); A.alignLeader(db, so); A.assignWaiting(db, 'Asia/Kolkata');
  assert.equal(A.pendingOf(db, 'R'), 2);
  assert.equal(A.pendingOf(db, 'S'), 2);
  assert.ok(db.assembly.some((m) => m.leaderId === 'R' && m.status === 'started')); // started one stays
});

test('divert deduction lowers the leader\'s net incentive in the scoreboard', () => {
  const db = setup();
  db.assemblyDeductions = [{ leaderId: 'L1', amount: 100, at: '2026-11-08T10:00:00Z' }, { leaderId: 'L1', amount: 100, at: '2026-10-08T10:00:00Z' }];
  const b = A.board(db, '2026-11');
  const l1 = b.leaders.find((r) => r.id === 'L1');
  assert.equal(l1.deduction, 100);
  assert.equal(l1.diverted, 1);
});

test('an installation person is not given more than the max pending machines', () => {
  const db = setup(); // installers i1, i2
  db.settings.assembly = { maxPending: 50, maxInstallerPending: 3 };
  add(db, 8);
  const c = {};
  for (const m of db.assembly) c[m.installerId] = (c[m.installerId] || 0) + 1;
  assert.ok((c.i1 || 0) <= 3 && (c.i2 || 0) <= 3, JSON.stringify(c));
  assert.equal(db.assembly.filter((m) => !m.installerId).length, 2); // no one free under the limit
});

test('a machine left without an installation person gets one when someone finishes', () => {
  const db = setup();
  db.settings.assembly = { maxPending: 50, maxInstallerPending: 3 };
  add(db, 7);
  assert.equal(db.assembly.filter((m) => !m.installerId).length, 1);
  const done = db.assembly.find((m) => m.installerId === 'i1');
  done.status = 'done';
  A.assignWaiting(db, 'Asia/Kolkata');
  assert.equal(db.assembly.filter((m) => !m.installerId && m.status !== 'done').length, 0);
});
