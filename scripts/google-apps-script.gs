// Paste this into your Google Sheet: Extensions → Apps Script. Change the KEY below,
// then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
// The delivery website calls it with the key to copy the "Party" and "Machines" tabs.
// Without the key nobody gets any data, and the sheet itself stays private.
const KEY = 'CHANGE-THIS-TO-A-SECRET';

function doGet(e) {
  const out = (obj) => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  if (!e || !e.parameter || e.parameter.key !== KEY) return out({ error: 'wrong key' });
  const tabs = String(e.parameter.tabs || 'Party,Machines').split(',').slice(0, 5);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = {};
  tabs.forEach((name) => {
    const sh = ss.getSheetByName(name.trim());
    data[name] = sh ? sh.getDataRange().getDisplayValues() : null;
  });
  return out(data);
}
