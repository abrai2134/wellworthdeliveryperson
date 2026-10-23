// Fills an empty database with sample units, helpers and installation persons.
// Usage: npm run demo   (then npm start)
const path = require('path');
const { Store, newId } = require('../lib/store');
const { hashPassword } = require('../lib/auth');

const store = new Store(path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'db.json'));
const db = store.db;
if (db.units.length || db.people.length) {
  console.log('Database already has units/people - demo data not added.');
  process.exit(0);
}
const units = ['Vasai', 'Bhiwandi', 'Andheri', 'Thane'];
const helperNames = [
  ['Ramesh', 'Suresh', 'Imran'],
  ['Mahesh', 'Salim', 'Ganesh'],
  ['Rahul', 'Akbar', 'Vijay'],
  ['Sanjay', 'Arif', 'Deepak'],
];
const installerNames = ['Prakash', 'Javed', 'Nitin', 'Kiran'];
let n = 0;
units.forEach((name, i) => {
  const unitId = newId('unit');
  db.units.push({
    id: unitId, name: name + ' Unit', username: 'unit' + (i + 1), passHash: hashPassword('unit' + (i + 1)),
    contactName: name + ' Manager', phone: '98200000' + String(i + 1).padStart(2, '0'), address: name + ', Maharashtra', active: true,
  });
  const add = (pname, role, backup) => {
    n++;
    const phone = '99300000' + String(n).padStart(2, '0');
    db.people.push({ id: newId('per'), name: pname, phone, username: phone, passHash: hashPassword('1234'), role, unitId, backup: !!backup, active: true, baseline: 0 });
  };
  helperNames[i].forEach((h) => add(h, 'helper'));
  add(installerNames[i], 'installer');
  if (i === 0) add('Anil (backup)', 'both', true);
});
store.save();
console.log('Demo data added.');
console.log('Unit logins:   unit1 / unit1 ... unit4 / unit4');
console.log('Helper logins: 9930000001 / 1234 ... (phone number / 1234)');
