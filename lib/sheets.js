// Reads the client list ("Party" tab) and machine list ("Machines" tab) from a Google Sheet.
//
// Two ways to connect (set by the admin in "Clients & machines"):
//  1. Apps Script web app (recommended – the sheet stays private). The script returns the
//     requested tabs as JSON only when called with the secret key.
//  2. Sheet link, when the sheet is shared as "Anyone with the link can view".
// Columns are found by their header names, so extra or moved columns are fine.

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const key = (v) => clean(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

// Index of the first header matching one of `names` (exact, ignoring spaces/case).
function col(header, names) {
  const h = header.map(key);
  for (const n of names) {
    const i = h.indexOf(key(n));
    if (i >= 0) return i;
  }
  return -1;
}

function headerRow(rows, mustHave) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (col(rows[i], mustHave) >= 0) return i;
  }
  return -1;
}

const phoneOf = (v) => clean(v).replace(/\.0$/, '');

function parseParties(rows) {
  const h = headerRow(rows, ['PARTY', 'PARTY NAME', 'CLIENT', 'CUSTOMER', 'NAME']);
  if (h < 0) throw new Error('Party tab: could not find a "PARTY" column');
  const head = rows[h];
  const c = {
    name: col(head, ['PARTY', 'PARTY NAME', 'CLIENT', 'CUSTOMER', 'NAME']),
    add: col(head, ['PARTY ADD', 'ADDRESS', 'PARTY ADDRESS', 'ADD']),
    add2: col(head, ['PARTY ADD2', 'ADDRESS2', 'ADD2']),
    city: col(head, ['CITY']),
    phone: col(head, ['CELL NO', 'MOBILE', 'PHONE', 'CELL', 'WHATSAPP NO', 'CONTACT']),
    phone2: col(head, ['CELLNO2', 'CELL NO2', 'MOBILE2', 'PHONE2']),
    email: col(head, ['EMAILID', 'EMAIL', 'EMAIL ID']),
    gst: col(head, ['GST NO', 'GST', 'GSTIN']),
  };
  const get = (r, i) => (i >= 0 ? clean(r[i]) : '');
  const byName = new Map();
  for (const r of rows.slice(h + 1)) {
    const name = get(r, c.name);
    if (!name) continue;
    const p = {
      name,
      address: [get(r, c.add), get(r, c.add2)].filter(Boolean).join(', '),
      city: get(r, c.city),
      phone: phoneOf(get(r, c.phone)),
      phone2: phoneOf(get(r, c.phone2)),
      email: get(r, c.email),
      gst: get(r, c.gst),
    };
    const k = key(name);
    const old = byName.get(k);
    if (!old) byName.set(k, p);
    else for (const f of Object.keys(p)) if (!old[f] && p[f]) old[f] = p[f]; // fill gaps from duplicates
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseMachines(rows) {
  const h = headerRow(rows, ['MODEL', 'MACHINE', 'MODEL NO', 'ITEM', 'PRODUCT', 'NAME']);
  if (h < 0) throw new Error('Machines tab: could not find a "MACHINE" or "MODEL" column');
  const head = rows[h];
  const m = col(head, ['MACHINE', 'MACHINE NAME', 'ITEM', 'PRODUCT', 'NAME']);
  const mo = col(head, ['MODEL', 'MODEL NO', 'MODEL NAME']);
  const seen = new Set();
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const machine = m >= 0 ? clean(r[m]) : '';
    const model = mo >= 0 ? clean(r[mo]) : '';
    const label = machine && model && key(machine) !== key(model) ? `${machine} – ${model}` : model || machine;
    if (!label || seen.has(key(label))) continue;
    seen.add(key(label));
    out.push({ machine, model, label });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function sheetIdFrom(link) {
  const m = String(link || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : /^[a-zA-Z0-9_-]{20,}$/.test(String(link || '')) ? link : '';
}

async function fetchTabs(cfg, fetchFn = fetch) {
  const tabs = [cfg.partyTab || 'Party', cfg.machineTab || 'Machines'];
  let raw;
  if (cfg.scriptUrl) {
    const url = new URL(cfg.scriptUrl);
    url.searchParams.set('key', cfg.key || '');
    url.searchParams.set('tabs', tabs.join(','));
    const res = await fetchFn(url, { redirect: 'follow' });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Apps Script did not return data – check the web app URL and that access is "Anyone"'); }
    if (data.error) throw new Error('Apps Script: ' + data.error);
    raw = tabs.map((t) => data[t]);
  } else {
    const id = sheetIdFrom(cfg.sheetLink);
    if (!id) throw new Error('Add the Apps Script URL or the Google Sheet link first');
    raw = await Promise.all(tabs.map(async (t) => {
      const res = await fetchFn(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(t)}`);
      const text = await res.text();
      if (!res.ok || /^\s*</.test(text)) throw new Error('Could not read the sheet – share it as "Anyone with the link can view" or use the Apps Script way');
      return parseCSV(text);
    }));
  }
  if (!raw[0]) throw new Error(`Tab "${tabs[0]}" not found in the sheet`);
  const clients = parseParties(raw[0]);
  const machines = raw[1] ? parseMachines(raw[1]) : [];
  return { clients, machines, missingMachineTab: !raw[1] };
}

// Search clients by name, phone or city; best matches first.
function searchClients(clients, q, limit = 10) {
  const k = key(q);
  const digits = String(q || '').replace(/\D/g, '');
  if (!k) return [];
  const scored = [];
  for (const c of clients) {
    const n = key(c.name);
    let s = -1;
    if (n.startsWith(k)) s = 0;
    else if (n.includes(k)) s = 1;
    else if (digits.length >= 4 && (c.phone.replace(/\D/g, '').includes(digits) || c.phone2.replace(/\D/g, '').includes(digits))) s = 2;
    else if (key(c.city).startsWith(k)) s = 3;
    if (s >= 0) scored.push([s, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, limit).map((x) => x[1]);
}

module.exports = { parseCSV, parseParties, parseMachines, fetchTabs, searchClients, sheetIdFrom };
