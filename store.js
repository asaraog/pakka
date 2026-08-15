/* Persistence: one JSON file, written atomically.
   Deliberately not SQLite. For a pilot at this size a file has no native
   dependencies, no Node-version constraints, can be opened and read by a human,
   and is backed up by copying it. Swap for Postgres when a second process needs
   to write, not before. */
const fs = require('node:fs');
const path = require('node:path');

const FILE = process.env.DB_PATH || 'baari.json';
const MEM = FILE === ':memory:';

let db = { bookings: [], sessions: {}, seq: 0 };
if (!MEM && fs.existsSync(FILE)) {
  try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { console.error('could not read %s, starting empty', FILE); }
}

let dirty = false, timer = null;
function save() {
  if (MEM) return;
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null; dirty = false;
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, FILE);               // atomic: never a half-written file
  }, 200);
}
process.on('exit', () => { if (dirty && !MEM) fs.writeFileSync(FILE, JSON.stringify(db, null, 1)); });

const LIVE = new Set(['pending', 'hold', 'paid', 'done']);
const ref = () => 'BA' + (++db.seq).toString(36).toUpperCase().padStart(4, '0');

const store = {
  getSession(customer) {
    const s = db.sessions[customer];
    return s ? { venue: s.venue, draft: s.draft || {} } : null;
  },
  setSession(customer, venue, draft) {
    db.sessions[customer] = { venue, draft: draft || {}, updated: new Date().toISOString() };
    save();
  },

  // is any of `times` already taken on this ground?
  takenAt(venue, date, ground, times) {
    if (!times.length) return true;
    return db.bookings.some(b =>
      b.venue === venue && b.date === date && b.ground === ground &&
      LIVE.has(b.status) && times.includes(b.time));
  },
  dayBookings(venue, date) {
    return db.bookings
      .filter(b => b.venue === venue && b.date === date && LIVE.has(b.status))
      .sort((a, b) => a.time.localeCompare(b.time));
  },

  create(b) {
    const row = Object.assign({ ref: ref(), status: 'pending', standing: 0, created: new Date().toISOString() }, b);
    db.bookings.push(row); save();
    return row;
  },
  byRef(r) { return db.bookings.find(b => b.ref === r); },
  setStatus(r, status) {
    const b = this.byRef(r);
    if (!b) return b;
    b.status = status;
    // When the advance was requested. Payment signals are matched inside a window
    // from this moment, so it has to be recorded, not inferred from `created`.
    if (status === 'hold' && !b.held) b.held = new Date().toISOString();
    save();
    return b;
  },
  // bookings awaiting an advance, oldest first
  holds(venue) {
    return db.bookings.filter(b => b.venue === venue && b.status === 'hold')
      .sort((a, b) => String(a.held || a.created).localeCompare(String(b.held || b.created)));
  },
  // bank reference from the PSP webhook - the audit trail for a settled advance
  setUtr(r, utr) {
    const b = this.byRef(r);
    if (b) { b.utr = utr; save(); }
    return b;
  },
  // other weeks of a standing slot, still awaiting the same advance
  siblings(venue, b, status) {
    return db.bookings.filter(x => x.venue === venue && x.customer === b.customer &&
      x.time === b.time && x.ref !== b.ref && x.status === (status || 'hold'));
  },
  pending(venue) {
    return db.bookings.filter(b => b.venue === venue && b.status === 'pending')
      .sort((a, b) => a.created.localeCompare(b.created));
  },
  lastFor(customer) {
    const rows = db.bookings.filter(b => b.customer === customer && LIVE.has(b.status));
    return rows[rows.length - 1];
  },
  eraseCustomer(customer) {
    let n = 0;
    db.bookings.forEach(b => {
      if (b.customer === customer && ['pending', 'hold', 'paid'].includes(b.status)) {
        b.status = 'cancelled'; b.name = null; n++;
      }
    });
    delete db.sessions[customer];
    save();
    return n;
  },

  /* Who has messaged this venue, when, and under what name. Two jobs, both for
     the relay:

       1. The 24-hour service window. WhatsApp only allows free-form text to
          someone who messaged you in the last 24 hours, so we have to know when
          each customer last did. Nothing else in the system needed this, because
          every other outbound message is a reply to something.
       2. Name -> number, so the owner can type "राहुल" rather than a phone
          number they do not have in front of them.

     Kept separate from `sessions` on purpose: a session is a half-built booking
     and gets cleared, while this is a contact record and must outlive it. */
  touch(venue, customer, name) {
    if (!db.contacts) db.contacts = {};
    const c = db.contacts[customer] || {};
    c.venue = venue;
    c.last = new Date().toISOString();
    // Only overwrite with a real name: WhatsApp omits the profile on some
    // message types, and a blank must not erase what we already knew.
    if (name) c.name = name;
    db.contacts[customer] = c;
    save();
    return c;
  },
  contact(customer) { return (db.contacts || {})[customer] || null; },
  contacts(venue) {
    const all = db.contacts || {};
    return Object.keys(all)
      .filter(k => all[k].venue === venue)
      .map(k => Object.assign({ customer: k }, all[k]));
  },

  // for eyeballing during the pilot
  all() { return db.bookings; }
};

module.exports = store;
