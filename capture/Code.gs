/**
 * Lead capture for gtm-scoring-console.
 *
 * Receives a scored lead record from the site, appends it as a row, and
 * emails a notification. Setup instructions are in capture/README.md.
 *
 * The web app URL is public (it is in the page source), so every request is
 * treated as untrusted: the body is size-capped and parsed strictly, every
 * field is allow-listed, length-capped and cleaned, numbers are coerced to real
 * numbers (so nothing can arrive as a spreadsheet formula), and submissions are
 * rate-limited so a flood cannot fill the sheet or burn the daily mail quota.
 * Failures return a short error code, never an internal message.
 */

var SHEET_NAME = 'leads';
var NOTIFY_EMAIL = 'chetan00yadav@gmail.com';
var NOTIFY = true;

var COLUMNS = [
  'received_at', 'lead_id', 'name', 'email', 'company', 'seniority',
  'company_size', 'intent', 'role_track', 'score', 'probability',
  'engagement', 'source', 'device', 'note'
];

var LIMITS = {
  bodyBytes: 8000,     // a real record is well under 2 KB
  rowsPerHour: 20,     // across all visitors
  perLeadPer6h: 3,     // one lead_id can retry a failed send, not hammer
  mailsPerDay: 40,     // keeps well inside the 100/day consumer Gmail quota
  maxRows: 5000        // hard stop so the sheet cannot grow without bound
};

// Longest value kept for each text field. Matches the limits the page applies.
var FIELD_MAX = {
  lead_id: 32, name: 60, company: 60, email: 120, seniority: 40, size: 20,
  intent: 40, track: 60, source: 80, device: 12, note: 800
};

/** Thrown for requests we refuse; `code` is all the caller ever sees. */
function Reject(code) { this.code = code; }

function doPost(e) {
  try {
    // Cheap checks first, so junk never queues for the lock.
    var data = parse_(e);

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) throw new Reject('busy');
    try {
      return record_(data);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    if (err instanceof Reject) return fail_(err.code);
    console.error(err);                 // details stay in the script log
    return fail_('server_error');
  }
}

/** Lets you confirm the deployment is alive by opening the URL in a browser. */
function doGet() {
  return json_({ ok: true, service: 'gtm-scoring-console capture' });
}

/** Applies the limits, writes the row, then (best effort) sends the email. */
function record_(data) {
  var cache = CacheService.getScriptCache();
  var now = new Date().toISOString();
  var hourKey = 'rows:' + now.slice(0, 13);
  var leadKey = 'lead:' + data.lead_id;
  var mailKey = 'mail:' + now.slice(0, 10);

  if (count_(cache, hourKey) >= LIMITS.rowsPerHour) throw new Reject('rate_limited');
  if (count_(cache, leadKey) >= LIMITS.perLeadPer6h) throw new Reject('rate_limited');

  var sheet = getSheet_();
  if (sheet.getLastRow() > LIMITS.maxRows) throw new Reject('full');

  sheet.appendRow([
    new Date(),
    cell_(data.lead_id), cell_(data.name), cell_(data.email), cell_(data.company),
    cell_(data.seniority), cell_(data.size), cell_(data.intent), cell_(data.track),
    data.score, data.probability, data.engagement,
    cell_(data.source), cell_(data.device), cell_(data.note)
  ]);
  bump_(cache, hourKey, 3700);
  bump_(cache, leadKey, 21600);

  // The row is already safe; a mail failure (or hitting the cap) must not fail the request.
  if (NOTIFY && count_(cache, mailKey) < LIMITS.mailsPerDay) {
    try { notify_(data); } catch (mailErr) { console.error(mailErr); }
    bump_(cache, mailKey, 90000);
  }
  return json_({ ok: true });
}

/** Parses and cleans the request body, or throws a Reject. */
function parse_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (typeof raw !== 'string' || !raw) throw new Reject('bad_request');
  if (byteLength_(raw) > LIMITS.bodyBytes) throw new Reject('too_large');

  var obj;
  try { obj = JSON.parse(raw); } catch (x) { throw new Reject('bad_request'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Reject('bad_request');
  return clean_(obj);
}

/** Keeps only the known fields, as bounded text or bounded numbers. */
function clean_(o) {
  // An identifier is checked exactly as sent; trimming it could merge two different ids.
  if (typeof o.lead_id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(o.lead_id)) throw new Reject('bad_request');

  var out = {};
  Object.keys(FIELD_MAX).forEach(function (k) {
    out[k] = text_(o[k], FIELD_MAX[k], k === 'note');
  });
  out.score = num_(o.score, 0, 100, 0);
  out.probability = num_(o.probability, 0, 1, 3);
  out.engagement = num_(o.engagement, 0, 1, 2);

  if (out.email && !isEmail_(out.email)) out.email = '';
  return out;
}

/** A string or number becomes cleaned, trimmed, length-capped text; anything else becomes ''. */
function text_(v, max, multiline) {
  if (typeof v === 'number' && isFinite(v)) v = String(v);
  if (typeof v !== 'string') return '';
  var s = v.replace(/\r\n?/g, '\n')
           .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, '')
           .replace(/\t/g, ' ');
  if (!multiline) s = s.replace(/\n+/g, ' ');
  return s.trim().slice(0, max);
}

/** A real, clamped, rounded number, or '' when the value is not numeric. */
function num_(v, min, max, digits) {
  var n = typeof v === 'number' ? v
        : (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) ? parseFloat(v)
        : NaN;
  if (!isFinite(n)) return '';
  n = Math.min(max, Math.max(min, n));
  var f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function notify_(data) {
  var who = data.name || 'Anonymous';
  var where = data.company;
  var score = data.score === '' ? '?' : data.score;

  var body = [
    who + (where ? ' at ' + where : ''),
    'Scored ' + score + '/100  (p = ' + data.probability + ')',
    '',
    'Reading for:  ' + data.track,
    'Seniority:    ' + data.seniority,
    'Company size: ' + data.size,
    'Intent:       ' + data.intent,
    'Email:        ' + (data.email || 'not given'),
    '',
    'What they wrote:',
    data.note || '(nothing)',
    '',
    '---',
    'Engagement depth ' + data.engagement + ' · ' + data.source +
      ' · ' + data.device + ' · ' + data.lead_id
  ].join('\n');

  var options = { name: 'GTM Scoring Console' };
  if (data.email) options.replyTo = data.email;

  MailApp.sendEmail(
    NOTIFY_EMAIL,
    'Lead ' + score + '/100 — ' + who + (where ? ' @ ' + where : ''),
    body,
    options
  );
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  // Self-heals the header row when the columns change.
  var header = sheet.getRange(1, 1, 1, COLUMNS.length).getValues()[0];
  if (header.join('|') !== COLUMNS.join('|')) {
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function isEmail_(v) {
  return !!v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim());
}

/** Leading '=', '+', '-' or '@' would otherwise be read as a formula. */
function cell_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** Counters live in the script cache; an evicted counter only ever loosens a limit. */
function count_(cache, key) {
  return parseInt(cache.get(key) || '0', 10) || 0;
}
function bump_(cache, key, ttlSeconds) {
  cache.put(key, String(count_(cache, key) + 1), ttlSeconds);
}

/** UTF-8 size of a string, without needing a Blob. */
function byteLength_(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }   // surrogate pair
    else n += 3;
  }
  return n;
}

function fail_(code) { return json_({ ok: false, error: code }); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
