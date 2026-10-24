const test = require('node:test');
const assert = require('node:assert');
const sh = require('../lib/sheets');

const party = [
  ['NEW SINCE', 'PARTY', 'ENTRY BY', 'PARTY ADD', 'PARTY ADD2', 'CITY', 'CELL NO', 'EMAILID', 'CELLNO2', 'EMAILID2', 'GST NO', 'REMARKS'],
  ['8/10/2021 10:02:00', '3d Vision Cad-cam Services', '', 'RAM NAGAR', '', 'RAM NAGAR', '224014080', '3dvision@gmail.com', '', '', '', ''],
  ['8/13/2021 10:02:00', 'JEWELEX INDIA', 'SATISH', 'Plot No. 56B,\nSeepz', '', 'ANDHERI', '9819660049', '', '', '', '27AABCJ4523H2ZP', ''],
  ['8/16/2021 10:02:00', 'A.MAHENDRA JEWELLERS', '', 'MUMBAI', '', 'MUMBAI', '9820281945', '', '', '', '', ''],
  ['8/16/2021 10:02:00', 'A. Mahendra Jewellers', '', '', '', '', '', 'a@b.com', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', ''],
];

test('reads the Party tab by header names and merges duplicates', () => {
  const c = sh.parseParties(party);
  assert.equal(c.length, 3);
  const j = c.find((x) => x.name === 'JEWELEX INDIA');
  assert.equal(j.address, 'Plot No. 56B, Seepz');
  assert.equal(j.city, 'ANDHERI');
  assert.equal(j.phone, '9819660049');
  assert.equal(j.gst, '27AABCJ4523H2ZP');
  const m = c.find((x) => x.name.startsWith('A.MAHENDRA'));
  assert.equal(m.email, 'a@b.com'); // filled from the duplicate row
});

test('search by name, phone and city', () => {
  const c = sh.parseParties(party);
  assert.equal(sh.searchClients(c, 'jewelex')[0].name, 'JEWELEX INDIA');
  assert.equal(sh.searchClients(c, '96600')[0].name, 'JEWELEX INDIA');
  assert.equal(sh.searchClients(c, 'mahendra').length, 1);
  assert.equal(sh.searchClients(c, '').length, 0);
});

test('reads the Machines tab with machine + model or model only', () => {
  const m = sh.parseMachines([['SR', 'MACHINE', 'MODEL', 'RATE'], ['1', 'Screw Compressor', 'TP150CH', '1'], ['2', 'Dryer', 'RD20', ''], ['3', 'Screw Compressor', 'TP150CH', '']]);
  assert.deepEqual(m.map((x) => x.label), ['Dryer – RD20', 'Screw Compressor – TP150CH']);
  assert.deepEqual(sh.parseMachines([['MODEL'], ['TP150'], ['TP200']]).map((x) => x.label), ['TP150', 'TP200']);
});

test('CSV parser handles quotes and new lines', () => {
  assert.deepEqual(sh.parseCSV('a,"b, c","d ""x""\ny"\n1,2,3'), [['a', 'b, c', 'd "x"\ny'], ['1', '2', '3']]);
});

test('sheet id from link', () => {
  assert.equal(sh.sheetIdFrom('https://docs.google.com/spreadsheets/d/1yC2zt31TfHyXrGk970gFJMigbU2Dpn0MH19rxXaopnM/edit?gid=1'), '1yC2zt31TfHyXrGk970gFJMigbU2Dpn0MH19rxXaopnM');
});
