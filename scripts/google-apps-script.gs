// Delivery Team – reads the client ("Party") and machine ("Machines") tabs of your sheet.
// Make this a NEW, separate project at script.google.com → New project, so it does not
// change any other script you already use with the sheet (e.g. a quote app).
// 1. Change KEY to your own secret word and SHEET_ID to your sheet's ID
//    (the long part of the sheet link between /d/ and /edit). Save.
// 2. Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
// 3. Paste the Web app URL and the secret word in the website: Admin → Clients & machines.
// Without the key nobody gets any data, and the sheet itself stays private.
const KEY = 'CHANGE-THIS-TO-A-SECRET';
const SHEET_ID = 'PASTE-YOUR-SHEET-ID-HERE';

function doGet(e) {
  const out = (obj) => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  if (!e || !e.parameter || e.parameter.key !== KEY) return out({ error: 'wrong key' });
  const tabs = String(e.parameter.tabs || 'Party,Machines').split(',').slice(0, 5);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const data = {};
  tabs.forEach((name) => {
    const sh = ss.getSheetByName(name.trim());
    data[name] = sh ? sh.getDataRange().getDisplayValues() : null;
  });
  return out(data);
}
