// Fair helper / installation person allocation for machine deliveries.
//
// A unit books a delivery: date, time (full day / morning / afternoon), how many helpers
// (usually 2-3) and whether an installation person is needed. People are pooled from ALL
// units, so the work is shared equally no matter which unit a person belongs to.
//
// For every delivery the open places are matched to free people with the Hungarian
// algorithm (optimal assignment). The cost, in order of importance:
//   1. fill every place (installation person first, then helper 1, 2, 3 ...),
//   2. use regular people first; "emergency backup" people only when regulars run short,
//   3. give the work to whoever has done the fewest deliveries so far (equal duty),
//   4. send people to the units they have served least (shuffle across units),
//   5. prefer whoever has rested longest, then a small per-delivery shuffle for ties.
// A person never works two deliveries at the same time on one day (a full-day delivery
// blocks the whole day; a morning and an afternoon delivery can share people).
// People on leave, inactive people and people the unit sent back are never picked.
//
// Once a team is made it stays the same: later changes (a new delivery, leave, someone
// absent) only fill the gaps. The admin can re-balance from a date if wanted.

const { diffDays } = require('./dates');

const ROLES = ['helper', 'installer', 'both'];
const SESSIONS = ['FULL', 'AM', 'PM'];
const SESSION_ORDER = { FULL: 0, AM: 1, PM: 2 };
const MAX_HELPERS = 8;
const EXTRA_SLOT = 100; // emergency extras requested by a unit use slots 100, 101, ...
const MAX_EXTRAS = 5;

const COST_FORBIDDEN = 1e14;
const COST_UNFILLED = 1e11;
const W_UNFILLED_INSTALLER = 1e10;
const W_UNFILLED_HELPER = 1e8; // per helper position: helper 1 is kept before helper 3
const W_BACKUP = 1e9;
const W_DUTY = 1e6;
const MAX_DUTY_GAP = 300;
const W_PAIR = 1e3;
const W_FLEX = 300; // a "helper + installer" person used as a helper when a pure helper is free
const W_REST = 10; // per rest day (capped)
const MAX_REST = 30;

// ---------- helpers ----------

const canDo = (person, role) => person.role === role || person.role === 'both';

function conflicts(a, b) {
  return a === 'FULL' || b === 'FULL' || a === b;
}

function onLeave(db, personId, date) {
  return db.leaves.some((l) => l.personId === personId && l.from <= date && date <= l.to);
}

function availablePeople(db, date) {
  return db.people
    .filter((p) => p.active && !p.deleted && !onLeave(db, p.id, date))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function liveUnit(db, unitId) {
  return db.units.find((u) => u.id === unitId && u.active && !u.deleted);
}

// Deliveries that need people on `date`, most constrained (full day) first.
function deliveriesOn(db, date) {
  return db.deliveries
    .filter((d) => d.date === date && d.status !== 'cancelled' && liveUnit(db, d.unitId))
    .sort((a, b) => SESSION_ORDER[a.session] - SESSION_ORDER[b.session] || (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id));
}

// The places a delivery needs: installation person first (most important), then helpers.
function deliverySlots(d) {
  const slots = [];
  if (d.installation) slots.push({ role: 'installer', slot: 0 });
  const n = Math.max(0, Math.min(MAX_HELPERS, Number(d.helpersNeeded) || 0));
  for (let i = 0; i < n; i++) slots.push({ role: 'helper', slot: i });
  return slots;
}

// Small stable number 0..9 used to shuffle ties differently for every delivery.
function shuffleKey(a, b) {
  let h = 2166136261;
  for (const ch of a + '|' + b) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 10;
}

// Duty counts from every day except `date` (so deliveries can be booked in any order and
// still be shared fairly), plus who worked where and each person's last day before `date`.
function history(db, date) {
  const duty = {};
  const pair = {};
  const last = {};
  for (const a of db.assignments) {
    if (!a.personId || a.date === date) continue;
    duty[a.personId] = (duty[a.personId] || 0) + 1;
    const k = a.personId + '|' + a.unitId;
    pair[k] = (pair[k] || 0) + 1;
    if (a.date < date && (!last[a.personId] || last[a.personId] < a.date)) last[a.personId] = a.date;
  }
  return { duty, pair, last };
}

function totalDuty(db, person) {
  return (person.baseline || 0) + db.assignments.filter((a) => a.personId === person.id).length;
}

// When a person joins (or comes back), start them level with the least-used active person
// of the same kind so they are not flooded with work to "catch up".
function alignBaseline(db, person) {
  const same = db.people.filter((p) => p.id !== person.id && p.active && !p.deleted && !p.backup === !person.backup && (p.role === person.role || p.role === 'both' || person.role === 'both'));
  const minOther = same.length ? Math.min(...same.map((p) => totalDuty(db, p))) : 0;
  const own = db.assignments.filter((a) => a.personId === person.id).length;
  person.baseline = Math.max(person.baseline || 0, minOther - own);
}

// Standard O(n^2 m) Hungarian algorithm for n rows <= m columns. Returns col index per row.
function hungarian(cost) {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0].length;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const res = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

// ---------- planning ----------

// Plan every delivery on `date`. `pinned` assignments are kept when still valid
// (emergency extras first); every open place is then filled fairly.
function planDate(db, date, pinned = []) {
  db.assignments = db.assignments.filter((a) => a.date !== date);
  const dels = deliveriesOn(db, date);
  const delById = Object.fromEntries(dels.map((d) => [d.id, d]));
  const people = availablePeople(db, date);
  const personById = Object.fromEntries(people.map((p) => [p.id, p]));
  const hist = history(db, date);
  const dutyToday = {};
  const duty = (p) => (p.baseline || 0) + (hist.duty[p.id] || 0) + (dutyToday[p.id] || 0);
  const busy = {}; // personId -> sessions already taken today
  const isBusy = (personId, session) => (busy[personId] || []).some((s) => conflicts(s, session));
  const filled = new Set();
  const result = [];

  const take = (a, d, person) => {
    (busy[person.id] = busy[person.id] || []).push(d.session);
    dutyToday[person.id] = (dutyToday[person.id] || 0) + 1;
    filled.add(d.id + '|' + a.role + '|' + a.slot);
    result.push({ ...a, date, deliveryId: d.id, unitId: d.unitId, personId: person.id, backup: !!person.backup });
  };

  const ordered = [...pinned.filter((p) => p.extra), ...pinned.filter((p) => !p.extra)];
  for (const p of ordered) {
    const d = delById[p.deliveryId];
    const person = p.personId && personById[p.personId];
    if (!d || !person) continue;
    if ((d.excluded || []).includes(person.id) || isBusy(person.id, d.session)) continue;
    if (filled.has(d.id + '|' + p.role + '|' + p.slot) || !canDo(person, p.role)) continue;
    if (!p.extra && !deliverySlots(d).some((s) => s.role === p.role && s.slot === p.slot)) continue;
    if (p.extra && p.slot < EXTRA_SLOT) continue;
    take({ role: p.role, slot: p.slot, manual: !!p.manual, extra: !!p.extra, reason: p.reason || '', fromDeliveryId: p.fromDeliveryId || null, requestedBy: p.requestedBy || '' }, d, person);
  }

  for (const d of dels) {
    const open = deliverySlots(d).filter((s) => !filled.has(d.id + '|' + s.role + '|' + s.slot));
    if (!open.length) continue;
    const excluded = d.excluded || [];
    const cands = people.filter((p) => !excluded.includes(p.id) && !isBusy(p.id, d.session) && open.some((s) => canDo(p, s.role)));
    const minDuty = cands.length ? Math.min(...cands.map(duty)) : 0;
    const cost = open.map((s) => {
      const row = cands.map((p) => {
        if (!canDo(p, s.role)) return COST_FORBIDDEN;
        const last = hist.last[p.id];
        const rest = last ? Math.min(diffDays(date, last), MAX_REST) : MAX_REST;
        return (
          (p.backup ? W_BACKUP : 0) +
          Math.min(duty(p) - minDuty, MAX_DUTY_GAP) * W_DUTY +
          (hist.pair[p.id + '|' + d.unitId] || 0) * W_PAIR +
          (s.role === 'helper' && p.role === 'both' ? W_FLEX : 0) -
          rest * W_REST +
          shuffleKey(p.id, d.id)
        );
      });
      // One "nobody" column per place, so every place can always be matched.
      const unfilled = COST_UNFILLED + (s.role === 'installer' ? W_UNFILLED_INSTALLER : (MAX_HELPERS - s.slot) * W_UNFILLED_HELPER);
      for (let k = 0; k < open.length; k++) row.push(unfilled);
      return row;
    });
    const match = hungarian(cost);
    open.forEach((s, i) => {
      const j = match[i];
      const ok = j >= 0 && j < cands.length && cost[i][j] < COST_FORBIDDEN;
      const a = { role: s.role, slot: s.slot, manual: false, extra: false };
      if (ok) take(a, d, cands[j]);
      else result.push({ ...a, date, deliveryId: d.id, unitId: d.unitId, personId: null, backup: false });
    });
  }

  db.assignments.push(...result);
  return result;
}

// Fix a day with as little change as possible: keep every team member who can still go
// and only fill the gaps (new delivery, leave, someone sent back ...).
function repairDate(db, date) {
  const keep = db.assignments.filter((a) => a.date === date && a.personId);
  return planDate(db, date, keep);
}

function deliveryDates(db, from) {
  return [...new Set(db.deliveries.filter((d) => d.date >= from && d.status !== 'cancelled').map((d) => d.date))].sort();
}

function repairFrom(db, from) {
  for (const d of [...new Set([...deliveryDates(db, from), ...db.assignments.filter((a) => a.date >= from).map((a) => a.date)])].sort()) {
    repairDate(db, d);
  }
}

// Make all teams from `from` onward again for the best balance. Admin changes and
// emergency extras are kept unless keepManual is false.
function rebalanceFrom(db, from, keepManual = true) {
  const keep = db.assignments.filter((a) => a.date >= from && a.personId && (a.extra || (keepManual && a.manual)));
  db.assignments = db.assignments.filter((a) => a.date < from);
  for (const d of deliveryDates(db, from)) planDate(db, d, keep.filter((a) => a.date === d));
}

// ---------- changes on one delivery ----------

function teamOf(db, deliveryId) {
  return db.assignments.filter((a) => a.deliveryId === deliveryId);
}

// Where each available person is at the time of delivery `deliveryId`, for an emergency
// request. status: 'free' | 'other' (on another delivery, can be moved)
//   | 'mine' (already on this delivery) | 'emergency' (already an emergency extra elsewhere)
function personStatus(db, deliveryId) {
  const d = db.deliveries.find((x) => x.id === deliveryId);
  if (!d) return [];
  const sameTime = db.assignments.filter((a) => a.date === d.date && a.personId);
  const excluded = d.excluded || [];
  return availablePeople(db, d.date)
    .filter((p) => !excluded.includes(p.id))
    .map((p) => {
      const mine = sameTime.find((a) => a.personId === p.id && a.deliveryId === d.id);
      const other = sameTime.find((a) => a.personId === p.id && a.deliveryId !== d.id && conflicts(sessionOf(db, a.deliveryId), d.session));
      let status = 'free';
      if (mine) status = 'mine';
      else if (other) status = other.extra ? 'emergency' : 'other';
      return { person: p, status, deliveryId: other ? other.deliveryId : null, unitId: other ? other.unitId : null };
    });
}

function sessionOf(db, deliveryId) {
  const d = db.deliveries.find((x) => x.id === deliveryId);
  return d ? d.session : 'FULL';
}

// A unit asks for one more person on a delivery (emergency). A free person is simply
// added. A person on another delivery is moved here and that place is refilled from
// anyone free (call repairDate afterwards).
function addExtra(db, deliveryId, personId, info = {}) {
  const d = db.deliveries.find((x) => x.id === deliveryId && x.status !== 'cancelled');
  if (!d) throw new Error('Delivery not found');
  const st = personStatus(db, deliveryId).find((x) => x.person.id === personId);
  if (!st) throw new Error('That person is not available that day (inactive, on leave or sent back)');
  if (st.status === 'mine') throw new Error(`${st.person.name} is already on this delivery`);
  if (st.status === 'emergency') throw new Error(`${st.person.name} is already taken by another unit for an emergency`);
  const p = st.person;
  const role = p.role === 'both' ? (info.role === 'installer' ? 'installer' : 'helper') : p.role;
  const used = db.assignments.filter((a) => a.deliveryId === deliveryId && a.extra).map((a) => a.slot);
  if (used.length >= MAX_EXTRAS) throw new Error(`A delivery can take at most ${MAX_EXTRAS} emergency people`);
  let fromDeliveryId = null;
  if (st.status === 'other') {
    const from = db.assignments.find((a) => a.date === d.date && a.personId === personId && a.deliveryId === st.deliveryId);
    fromDeliveryId = from.deliveryId;
    from.personId = null;
    from.manual = false;
  }
  let slot = EXTRA_SLOT;
  while (used.includes(slot)) slot++;
  const a = { date: d.date, deliveryId, unitId: d.unitId, role, slot, personId, manual: true, extra: true, backup: !!p.backup, reason: info.reason || '', requestedBy: info.requestedBy || '', fromDeliveryId };
  db.assignments.push(a);
  return a;
}

function removeExtra(db, deliveryId, slot) {
  const before = db.assignments.length;
  db.assignments = db.assignments.filter((a) => !(a.deliveryId === deliveryId && a.extra && a.slot === slot));
  return db.assignments.length !== before;
}

// Someone can't come (absent / sent back): take them off this delivery for good and
// let the planner pick someone else.
function replacePerson(db, deliveryId, personId) {
  const d = db.deliveries.find((x) => x.id === deliveryId);
  if (!d) throw new Error('Delivery not found');
  if (!teamOf(db, deliveryId).some((a) => a.personId === personId)) throw new Error('That person is not on this delivery');
  d.excluded = [...new Set([...(d.excluded || []), personId])];
  db.assignments = db.assignments.filter((a) => !(a.deliveryId === deliveryId && a.personId === personId && a.extra));
  for (const a of db.assignments) if (a.deliveryId === deliveryId && a.personId === personId) { a.personId = null; a.manual = false; }
  repairDate(db, d.date);
}

// Admin picks a person for one place. If they were on another delivery at the same time,
// the two people swap (when the other person can do that job), otherwise that place is refilled.
function setManual(db, deliveryId, role, slot, personId) {
  const d = db.deliveries.find((x) => x.id === deliveryId);
  if (!d) throw new Error('Delivery not found');
  const target = db.assignments.find((a) => a.deliveryId === deliveryId && a.role === role && a.slot === slot);
  if (!target) throw new Error('No such place on that delivery');
  const person = db.people.find((p) => p.id === personId && p.active && !p.deleted);
  if (!person) throw new Error('Person not available');
  if (onLeave(db, personId, d.date)) throw new Error(`${person.name} is on leave that day`);
  if (!canDo(person, role)) throw new Error(`${person.name} is not ${role === 'installer' ? 'an installation person' : 'a helper'}`);
  const previous = target.personId;
  const prevPerson = previous && db.people.find((p) => p.id === previous);
  const others = db.assignments.filter((a) => a !== target && a.date === d.date && a.personId === personId && (a.deliveryId === deliveryId || conflicts(sessionOf(db, a.deliveryId), d.session)));
  for (const other of others) {
    const od = db.deliveries.find((x) => x.id === other.deliveryId);
    const canSwap = prevPerson && canDo(prevPerson, other.role) && !((od && od.excluded) || []).includes(previous);
    if (canSwap) {
      other.personId = previous;
      other.manual = true;
    } else if (other.extra) {
      db.assignments = db.assignments.filter((a) => a !== other);
    } else {
      other.personId = null;
      other.manual = false;
    }
  }
  d.excluded = (d.excluded || []).filter((id) => id !== personId);
  target.personId = personId;
  target.manual = true;
  target.backup = !!person.backup;
  repairDate(db, d.date);
}

module.exports = {
  ROLES,
  SESSIONS,
  MAX_HELPERS,
  EXTRA_SLOT,
  canDo,
  conflicts,
  onLeave,
  availablePeople,
  deliveriesOn,
  deliverySlots,
  history,
  totalDuty,
  alignBaseline,
  hungarian,
  planDate,
  repairDate,
  repairFrom,
  rebalanceFrom,
  teamOf,
  personStatus,
  addExtra,
  removeExtra,
  replacePerson,
  setManual,
};
