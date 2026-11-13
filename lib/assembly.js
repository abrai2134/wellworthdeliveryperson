// Machine assembly at the units.
//
// Each machine to assemble is one record. It goes to a team leader of that unit:
//   - the leader with the fewest machines so far gets it (equal shares; a new leader starts
//     level with the others through `assemblyBaseline`),
//   - a leader who already has `maxPending` machines not finished gets no new machine; the
//     machine waits and is given out as soon as a leader is free again,
// and gets 1 installation person + 1 helper of the unit, rotated by how often each has
// assembled. A team leader can also ask for a model; those machines are given to that
// leader only after the admin approves.
//
// status: waiting (no leader yet) | assigned | started | done | cancelled

const { todayIn } = require('./dates');

const DEFAULT_SETTINGS = { maxPending: 6, defaultLeader: 0, defaultInstaller: 0, defaultDispatch: 0, divertPenalty: 100, maxInstallerPending: 10, incentives: [], dispatchIncentives: [],
  // Monthly bonus to a dispatch person for machines sent to the bonus unit(s) (Shilphata): the slab
  // reached by the month's count (1–10 ₹100, 11–20 ₹175, 21–30 ₹225, 31+ ₹300).
  // Shown only to admin / dispatch logins.
  unitDispatchSlabs: [{ from: 1, amount: 100 }, { from: 11, amount: 175 }, { from: 21, amount: 225 }, { from: 31, amount: 300 }],
  // Units whose incoming transfers count for that bonus. null = the unit named "Shilphata".
  unitDispatchUnits: null };
// The first slab table (before the 50% cut) – replaced by the new one if it was never changed.
const OLD_UNIT_SLABS = [{ from: 1, amount: 200 }, { from: 11, amount: 350 }, { from: 21, amount: 450 }, { from: 31, amount: 600 }];

// Units that earn the transfer bonus.
function bonusUnits(db) {
  const list = settings(db).unitDispatchUnits;
  if (Array.isArray(list)) return list;
  return db.units.filter((u) => !u.deleted && String(u.name || '').toUpperCase().replace(/[^A-Z]/g, '').includes('SHILPHATA')).map((u) => u.id);
}

function unitDispatchBonus(slabs, count) {
  let amount = 0;
  for (const s of (slabs || []).slice().sort((a, b) => a.from - b.from)) if (count >= s.from) amount = s.amount;
  return count > 0 ? amount : 0;
}
const OPEN = ['waiting', 'assigned', 'started'];
const PENDING = ['assigned', 'started'];

const key = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Model no. without the description in brackets: "FT~24BK (DUAL SUCTION POINT)" -> "FT24BK".
const baseKey = (v) => key(String(v || '').split('(')[0]);
// Same model? "FT24BK", "ft~24bk" and "FT~24BK (DUAL SUCTION POINT)" all match.
// Incentive needs the exact model name of the rate list: only capitals and spaces are ignored
// ("TP150~CH3" ≠ "TP~150CH3", "FT24BK" ≠ "FT~24BK (DUAL SUCTION POINT)").
const exactKey = (v) => String(v || '').toUpperCase().replace(/\s+/g, '');
const sameRate = (a, b) => exactKey(a) !== '' && exactKey(a) === exactKey(b);
const sameModel = (a, b) => key(a) === key(b) || (baseKey(a) !== '' && baseKey(a) === baseKey(b));

function settings(db) {
  return { ...DEFAULT_SETTINGS, ...(db.settings.assembly || {}) };
}

function onLeave(db, personId, date) {
  return db.leaves.some((l) => l.personId === personId && l.from <= date && date <= l.to);
}

function leadersOf(db, unitId) {
  return db.people.filter((p) => p.role === 'leader' && p.active && !p.deleted && p.unitId === unitId);
}

function pendingOf(db, leaderId) {
  return db.assembly.filter((m) => m.leaderId === leaderId && PENDING.includes(m.status)).length;
}

function machinesOf(db, leader) {
  return (leader.assemblyBaseline || 0) + db.assembly.filter((m) => m.leaderId === leader.id && m.status !== 'cancelled').length;
}

// Machines a leader has finished – used to start a new leader level with the others
// (machines still open are shared again by `rebalance`).
function committedOf(db, leader) {
  return (leader.assemblyBaseline || 0) + db.assembly.filter((m) => m.leaderId === leader.id && m.status === 'done').length;
}

// A new (or returning) team leader starts level with the least-loaded leader of the unit
// (counting finished machines; machines not started yet get shared again).
function alignLeader(db, leader) {
  const others = leadersOf(db, leader.unitId).filter((p) => p.id !== leader.id);
  const min = others.length ? Math.min(...others.map((p) => committedOf(db, p))) : 0;
  const own = db.assembly.filter((m) => m.leaderId === leader.id && m.status !== 'cancelled').length;
  leader.assemblyBaseline = Math.max(leader.assemblyBaseline || 0, min - own);
}

// Small stable number to break ties differently for each machine.
function tie(a, b) {
  let h = 2166136261;
  for (const ch of a + '|' + b) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 1000;
}

function crewCount(db, personId) {
  return db.assembly.filter((m) => m.status !== 'cancelled' && (m.installerId === personId || m.helperId === personId)).length;
}

// 1 installation person + 1 helper of the unit, whoever has assembled least.
// Machines an installation person has that are not assembled yet.
function installerOpen(db, personId) {
  return db.assembly.filter((m) => m.installerId === personId && PENDING.includes(m.status)).length;
}

function pickCrew(db, m, date) {
  const pool = db.people.filter((p) => p.active && !p.deleted && !p.backup && p.role !== 'leader' && p.unitId === m.unitId && !onLeave(db, p.id, date));
  const best = (list) => list.sort((a, b) => crewCount(db, a.id) - crewCount(db, b.id) || tie(a.id, m.id) - tie(b.id, m.id))[0] || null;
  const maxInst = Math.max(1, Number(settings(db).maxInstallerPending) || 10);
  // skip installation persons who already have the maximum pending
  const inst = best(pool.filter((p) => (p.role === 'installer' || p.role === 'both') && installerOpen(db, p.id) < maxInst));
  const help = best(pool.filter((p) => (p.role === 'helper' || p.role === 'both') && (!inst || p.id !== inst.id)));
  if (!m.installerId && inst) m.installerId = inst.id;
  if (!m.helperId && help) m.helperId = help.id;
}

// Give waiting machines to free team leaders (oldest machines first). The leader whose team has
// the fewest machines open (not started + assembling) gets the next one – a team that has finished
// its work should not sit idle. Total machines given is only the tie-break.
function assignWaiting(db, timezone) {
  const date = todayIn(timezone);
  // A leader who was removed / made inactive / moved: their unfinished machines go back to the pool.
  for (const m of db.assembly) {
    if (!PENDING.includes(m.status) || !m.leaderId) continue;
    const l = db.people.find((p) => p.id === m.leaderId);
    if (!l || l.deleted || !l.active || l.role !== 'leader' || l.unitId !== m.unitId) {
      m.leaderId = null;
      m.status = 'waiting';
      m.startedAt = null;
      m.assignedAt = null;
    }
  }
  const max = Math.max(1, Number(settings(db).maxPending) || 6);
  const waiting = db.assembly.filter((m) => m.status === 'waiting').sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  for (const m of waiting) {
    const free = leadersOf(db, m.unitId).filter((p) => !onLeave(db, p.id, date) && pendingOf(db, p.id) < max);
    if (!free.length) continue;
    free.sort((a, b) => pendingOf(db, a.id) - pendingOf(db, b.id) || machinesOf(db, a) - machinesOf(db, b) || tie(a.id, m.id) - tie(b.id, m.id));
    m.leaderId = free[0].id;
    m.status = 'assigned';
    m.assignedAt = new Date().toISOString();
    pickCrew(db, m, date);
  }
  // Machines left without an installation person / helper (everyone was full): fill them now.
  for (const m of db.assembly) if (PENDING.includes(m.status) && (!m.installerId || !m.helperId)) pickCrew(db, m, date);
  rebalance(db, date, max);
}

// Move machines that were given but not started yet from the leader with the most open machines
// to the one with the fewest (e.g. a new leader, or a team that finished its work), until the
// open counts differ by at most 1.
function rebalance(db, date, max) {
  for (const unitId of [...new Set(db.assembly.filter((m) => m.status === 'assigned').map((m) => m.unitId))]) {
    for (let guard = 0; guard < 200; guard++) {
      const ls = leadersOf(db, unitId).filter((p) => !onLeave(db, p.id, date));
      if (ls.length < 2) break;
      ls.sort((a, b) => pendingOf(db, a.id) - pendingOf(db, b.id) || machinesOf(db, a) - machinesOf(db, b));
      const low = ls[0];
      const high = ls[ls.length - 1];
      if (pendingOf(db, high.id) - pendingOf(db, low.id) <= 1 || pendingOf(db, low.id) >= max) break;
      const movable = db.assembly
        .filter((m) => m.leaderId === high.id && m.status === 'assigned' && !m.manual && m.source !== 'request')
        .sort((a, b) => (b.assignedAt || '').localeCompare(a.assignedAt || ''))[0];
      if (!movable) break;
      movable.leaderId = low.id;
      movable.assignedAt = new Date().toISOString();
    }
  }
}

function incentiveFor(db, model) {
  const s = settings(db);
  const hit = (s.incentives || []).find((x) => sameRate(x.model, model));
  return {
    // no exact rate in the list -> no incentive
    leader: Math.max(0, Number(hit ? hit.leader : 0) || 0),
    installer: Math.max(0, Number(hit ? hit.installer : 0) || 0),
    // paid to the dispatch person when the machine is dispatched to a client (own list)
    dispatch: dispatchRate(s, model),
  };
}

// Dispatch scoreboard: each dispatch person's machines sent to clients / other units and the
// dispatch incentive they earned in a month (paid to the person who dispatched).
function dispatchBoard(db, month) {
  const rows = db.dispatchers.filter((d) => !d.deleted).map((d) => ({ id: d.id, name: d.name, toClient: 0, toUnit: 0, toBonusUnit: 0, incentive: 0 }));
  const bonusTo = new Set(bonusUnits(db));
  const row = (id) => rows.find((r) => r.id === id);
  for (const m of db.assembly) {
    if (m.location === 'dispatched' && (m.dispatchedAt || '').slice(0, 7) === month && m.dispatchIncentive && m.dispatchIncentive.dispatcherId) {
      const r = row(m.dispatchIncentive.dispatcherId);
      if (r) { r.toClient++; r.incentive += m.dispatchIncentive.amount || 0; }
    }
    for (const t of m.transfers || []) if ((t.at || '').slice(0, 7) === month && t.dispatcherId) { const r = row(t.dispatcherId); if (r) { r.toUnit++; if (bonusTo.has(t.to)) r.toBonusUnit++; } }
  }
  const slabs = settings(db).unitDispatchSlabs;
  for (const r of rows) { r.clientIncentive = r.incentive; r.unitBonus = unitDispatchBonus(slabs, r.toBonusUnit); r.incentive += r.unitBonus; }
  return rows.sort((a, b) => b.toClient - a.toClient || b.toUnit - a.toUnit || a.name.localeCompare(b.name));
}

// Machines in the godown, per unit and model (oldest first inside each group).
// Who put a machine into this godown, and from which login – shown on the godown stock list.
function stockEntry(db, m) {
  const unitName = (id) => (db.units.find((u) => u.id === id) || {}).name || '';
  const t = (m.transfers || []).filter((x) => x.to === m.unitId).slice(-1)[0];
  if (t) return `🔁 transfer from ${unitName(t.from) || 'other unit'} · ${t.dispatcherId ? `${t.by || '?'} (Dispatch login)` : t.by === 'admin' ? 'Admin' : t.by || '?'}`;
  if (m.source === 'stock') {
    const by = String(m.createdBy || '').replace(/ \(unit\)$/, '');
    const role = m.createdRole || (m.createdBy === 'admin' ? 'admin' : / \(unit\)$/.test(m.createdBy || '') ? 'unit' : db.dispatchers.some((d) => d.name === m.createdBy) ? 'dispatch' : '');
    const login = { admin: 'Admin login', unit: 'Unit login', dispatch: 'Dispatch login' }[role];
    return `📦 old stock · ${role === 'admin' ? 'Admin' : by || '?'}${login && role !== 'admin' ? ` (${login})` : ''}`;
  }
  const leader = (db.people.find((p) => p.id === m.leaderId) || {}).name;
  return `🛠️ assembled · ${leader || '?'} (Team leader)${m.source === 'old' && m.createdBy === 'admin' ? ' – entered by Admin' : ''}`;
}

// Which login made the entry (typed the model no.) – only that login, or the admin, may correct it.
// Returns { role: 'admin' | 'unit' | 'staff' | 'dispatch', id }.
function creatorOf(db, m) {
  if (m.creator && m.creator.role) return m.creator;
  const by = String(m.createdBy || '');
  if (m.source === 'stock') {
    const role = m.createdRole || (by === 'admin' ? 'admin' : / \(unit\)$/.test(by) ? 'unit' : 'dispatch');
    if (role === 'admin') return { role, id: 'admin' };
    if (role === 'unit') {
      const name = by.replace(/ \(unit\)$/, '');
      const u = db.units.find((x) => x.name === name || x.username === name);
      return { role, id: u ? u.id : ((m.transfers || [])[0] || {}).from || m.unitId };
    }
    const d = db.dispatchers.find((x) => x.name === by);
    return { role: 'dispatch', id: d ? d.id : '' };
  }
  if (m.source === 'request') return { role: 'staff', id: m.leaderId };
  if (m.source === 'old') return by === 'admin' ? { role: 'admin', id: 'admin' } : { role: 'staff', id: m.leaderId };
  if (by === 'admin') return { role: 'admin', id: 'admin' };
  return { role: 'unit', id: ((m.transfers || [])[0] || {}).from || m.unitId }; // entered by the unit for assembly
}
function canEditModel(db, user, m) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const c = creatorOf(db, m);
  return c.role === user.role && c.id === user.id;
}

// Has this exact model an assembly (or dispatch) rate?
function hasRate(db, model, which = 'any') {
  const s = settings(db);
  const inList = (list) => (list || []).some((x) => sameRate(x.model, model));
  return which === 'assembly' ? inList(s.incentives) : inList(s.incentives) || inList(s.dispatchIncentives);
}

function stock(db, unitId, only) {
  const unitName = (id) => (db.units.find((u) => u.id === id) || {}).name || '';
  const inGodown = db.assembly.filter((m) => m.status === 'done' && m.location === 'godown' && (!unitId || m.unitId === unitId) && (!only || only(m)));
  const byUnit = {};
  for (const m of inGodown) {
    const u = (byUnit[m.unitId] ||= { unitId: m.unitId, unitName: unitName(m.unitId), total: 0, models: {} });
    u.total++;
    (u.models[m.model] ||= []).push(m);
  }
  return Object.values(byUnit).sort((a, b) => a.unitName.localeCompare(b.unitName)).map((u) => ({
    unitId: u.unitId,
    unitName: u.unitName,
    total: u.total,
    models: Object.entries(u.models).map(([model, list]) => ({
      model,
      qty: list.length,
      oldest: list.reduce((o, m) => { const t = m.completedAt || m.godownAt; return !o || (t || '') < o ? t : o; }, null),
      oldStock: list.filter((m) => m.source === 'stock').length,
      noRate: !hasRate(db, model),
      creators: Object.values(list.reduce((o, m) => { const c = creatorOf(db, m); const k = c.role + '|' + c.id; (o[k] ||= { ...c, qty: 0 }).qty++; return o; }, {})),
      entries: Object.entries(list.reduce((o, m) => { const k = stockEntry(db, m); o[k] = (o[k] || 0) + 1; return o; }, {})).map(([text, qty]) => ({ text, qty })),
      booked: Object.entries(list.reduce((o, m) => { if (m.bookedParty) o[m.bookedParty] = (o[m.bookedParty] || 0) + 1; return o; }, {})).map(([party, qty]) => ({ party, qty })),
    })).sort((a, b) => a.model.localeCompare(b.model)),
  }));
}

// ₹ taken off a leader's incentive in a month (diverted machines).
function deductionsOf(db, leaderId, month) {
  return (db.assemblyDeductions || []).filter((x) => x.leaderId === leaderId && (x.at || '').slice(0, 7) === month).reduce((n, x) => n + (x.amount || 0), 0);
}

function dispatchRate(s, model) {
  const hit = (s.dispatchIncentives || []).find((x) => sameRate(x.model, model));
  if (hit) return Math.max(0, Number(hit.amount) || 0);
  const old = (s.incentives || []).find((x) => sameRate(x.model, model) && Number(x.dispatch) > 0); // older settings
  return Math.max(0, Number(old ? old.dispatch : 0) || 0);
}

// Scoreboard for a month ('YYYY-MM'): machines finished, pending, average time, incentive.
function board(db, month) {
  const name = (id) => (db.people.find((p) => p.id === id) || {}).name || '?';
  const unitName = (id) => (db.units.find((u) => u.id === id) || {}).name || '';
  const doneIn = db.assembly.filter((m) => m.status === 'done' && m.source !== 'stock' && (m.completedAt || '').slice(0, 7) === month); // old stock is not assembly work
  const leaders = db.people.filter((p) => p.role === 'leader' && !p.deleted && (p.active || doneIn.some((m) => m.leaderId === p.id)));
  const leaderRows = leaders.map((p) => {
    const mine = doneIn.filter((m) => m.leaderId === p.id);
    const times = mine.map((m) => Date.parse(m.completedAt) - Date.parse(m.startedAt)).filter((x) => x > 0);
    const open = db.assembly.filter((m) => m.leaderId === p.id && PENDING.includes(m.status));
    const oldest = open.reduce((o, m) => (!o || (m.assignedAt || '') < o ? m.assignedAt : o), null);
    return {
      id: p.id,
      name: p.name,
      unitName: unitName(p.unitId),
      done: mine.length,
      pending: open.length,
      oldestPending: oldest,
      avgMinutes: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length / 60000) : null,
      incentive: mine.reduce((n, m) => n + ((m.incentive && m.incentive.leader) || 0), 0),
      deduction: deductionsOf(db, p.id, month),
      diverted: (db.assemblyDeductions || []).filter((x) => x.leaderId === p.id && (x.at || '').slice(0, 7) === month).length,
      allTime: db.assembly.filter((m) => m.leaderId === p.id && m.status === 'done').length,
    };
  }).sort((a, b) => b.done - a.done || a.pending - b.pending || a.name.localeCompare(b.name));
  const instIds = [...new Set(doneIn.map((m) => m.installerId).filter(Boolean))];
  const installerRows = instIds.map((id) => {
    const mine = doneIn.filter((m) => m.installerId === id);
    return { id, name: name(id), done: mine.length, incentive: mine.reduce((n, m) => n + ((m.incentive && m.incentive.installer) || 0), 0) };
  }).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));
  const helperIds = [...new Set(doneIn.map((m) => m.helperId).filter(Boolean))];
  const helperRows = helperIds.map((id) => ({ id, name: name(id), done: doneIn.filter((m) => m.helperId === id).length })).sort((a, b) => b.done - a.done);
  return {
    month,
    leaders: leaderRows,
    installers: installerRows,
    helpers: helperRows,
    waiting: db.assembly.filter((m) => m.status === 'waiting').length,
    totalDone: doneIn.length,
  };
}

module.exports = { creatorOf, canEditModel, hasRate, exactKey, sameRate, bonusUnits, OLD_UNIT_SLABS, key, baseKey, sameModel, unitDispatchBonus, installerOpen, dispatchBoard, stock, deductionsOf, DEFAULT_SETTINGS, OPEN, PENDING, settings, leadersOf, pendingOf, machinesOf, alignLeader, assignWaiting, pickCrew, incentiveFor, board };
