// Tiny JSON-file database. Fine for a few dozen units/people and years of history.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function defaults() {
  return {
    version: 1,
    secret: crypto.randomBytes(32).toString('hex'),
    settings: {
      orgName: 'Well Worth Delivery Team',
      timezone: 'Asia/Kolkata',
      defaultHelpers: 2,
      // Expense paid to each person by work time (see lib/allowance.js)
      allowance: {
        appliesTo: 'all',
        slabs: [{ fromHours: 3, amount: 40 }, { fromHours: 5, amount: 55 }, { fromHours: 6, amount: 65 }], // services
        deliverySlabs: [{ fromHours: 1, amount: 35 }, { fromHours: 3, amount: 40 }, { fromHours: 5, amount: 55 }, { fromHours: 6, amount: 65 }],
      },
    },
    admins: [],
    units: [],
    people: [], // helpers and installation persons
    clients: [], // copied from the Google Sheet "Party" tab
    machines: [], // copied from the Google Sheet "Machines" tab
    sheet: { scriptUrl: '', key: '', sheetLink: '', partyTab: 'Party', machineTab: 'Machines', lastSync: null, lastError: '' },
    leaves: [],
    deliveries: [],
    assignments: [], // { deliveryId, date, role, slot, personId|null, manual, backup, extra, ... }
  };
}

function normalize(data) {
  const base = defaults();
  const db = { ...base, ...data };
  db.settings = { ...base.settings, ...(data.settings || {}) };
  db.sheet = { ...base.sheet, ...(data.sheet || {}) };
  for (const key of ['admins', 'units', 'people', 'leaves', 'deliveries', 'assignments', 'clients', 'machines']) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
  if (!db.secret) db.secret = base.secret;
  return db;
}

class Store {
  constructor(file) {
    this.file = file;
    if (file && fs.existsSync(file)) {
      this.db = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } else {
      this.db = defaults();
      this.save();
    }
  }

  save() {
    if (!this.file) return; // in-memory (tests)
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  replace(data) {
    const secret = this.db.secret;
    this.db = normalize(data);
    this.db.secret = secret; // keep sessions signing key stable
    this.save();
  }
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

module.exports = { Store, newId, defaults, normalize };
