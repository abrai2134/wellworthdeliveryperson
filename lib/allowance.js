// Expense allowance paid to each person on a job, by work time (Start → Completed).
// Slabs: [{ fromHours, amount }] – the highest slab whose fromHours is reached applies.
// Default: under 3 h nil, 3–5 h ₹40, 5–6 h ₹55, 6 h and more ₹65.

const DEFAULT = {
  appliesTo: 'all', // 'all' = deliveries and services, 'service' = services only
  slabs: [
    { fromHours: 3, amount: 40 },
    { fromHours: 5, amount: 55 },
    { fromHours: 6, amount: 65 },
  ],
};

function cleanSlabs(list) {
  const slabs = (Array.isArray(list) ? list : [])
    .map((s) => ({ fromHours: Math.round(Number(s && s.fromHours) * 100) / 100, amount: Math.round(Number(s && s.amount)) }))
    .filter((s) => s.fromHours > 0 && s.fromHours <= 48 && s.amount >= 0 && s.amount <= 100000)
    .sort((a, b) => a.fromHours - b.fromHours);
  const seen = new Set();
  return slabs.filter((s) => (seen.has(s.fromHours) ? false : seen.add(s.fromHours))).slice(0, 10);
}

function amountFor(minutes, slabs) {
  if (minutes == null || minutes < 0) return 0;
  let amount = 0;
  for (const s of slabs) if (minutes >= s.fromHours * 60) amount = s.amount;
  return amount;
}

// Work out the expense for a completed job. `team` = person ids on the job.
function compute(d, team, rules) {
  const r = rules || DEFAULT;
  if (r.appliesTo === 'service' && d.type !== 'service') return { applies: false };
  if (!d.startedAt || !d.completedAt) return { applies: true, minutes: null, perPerson: 0, people: team, total: 0, note: 'Start time not recorded' };
  const minutes = Math.round((new Date(d.completedAt) - new Date(d.startedAt)) / 60000);
  const perPerson = amountFor(minutes, r.slabs || []);
  return { applies: true, minutes, perPerson, people: team, total: perPerson * team.length, note: '' };
}

module.exports = { DEFAULT, cleanSlabs, amountFor, compute };
