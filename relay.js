/* The relay: the owner speaks to a customer THROUGH the bot.

     owner -> bot:      "राहुल को बोल दो कि लाइट ठीक हो गई"
     bot   -> customer: "लाइट ठीक हो गई"

   Why this exists. The bot runs on its own number, so the owner is not in the
   customer's thread at all. Every sentence the bot has not been taught is a
   sentence the owner cannot say - which is the difference between software and
   a relationship. This closes the gap without giving anything up.

   THE ONE REAL LIMIT, and it is Meta's, not ours: free-form text may only be sent
   to someone who messaged you in the last 24 hours (the customer service window).
   Outside it a pre-approved template is required, and a template cannot carry a
   sentence the owner just made up. So the window is checked before sending and
   the owner is told plainly when it has closed. Silently dropping the message
   would be far worse - they would think it arrived.

   Nothing here sends anything. It parses, resolves and decides; server.js does
   the sending. That keeps the whole thing testable without a WhatsApp account. */

const WINDOW_HOURS = Number(process.env.RELAY_WINDOW_HOURS || 24);

// ------------------------------------------------------------------ parsing

/* Hindi puts the addressee first: NAME को VERB (कि) MESSAGE.

   Only explicit "tell X ..." forms are matched. Anything looser would start
   swallowing ordinary owner messages - and an owner whose "आज" got relayed to a
   customer would never trust the bot again.

   "भेज दो" is deliberately NOT a verb here: "राहुल को ₹500 भेज दो" is about
   money, and tier 0 has the owner forwarding payment messages to this same bot. */
const HI = new RegExp(
  '^\\s*(.{1,40}?)\\s*(?:को|से)\\s+' +
  '(?:बोल\\s*(?:दो|दीजिए|देना)|कह\\s*(?:दो|दीजिए|देना)|कहो|कहिए|' +
  'बता\\s*(?:दो|दीजिए|देना)|बताओ|बताइए|' +
  'मैसेज\\s*(?:कर\\s*(?:दो|दीजिए)|करो|कीजिए)?)' +
  '\\s*(?:कि\\s+)?([\\s\\S]+)$'
);

const EN = /^\s*(?:tell|message|msg|reply\s+to|send\s+to)\s+(.{1,40}?)\s+(?:that\s+)?([\s\S]+)$/i;

/* Returns { name, message } or null. `name` is whatever the owner called them -
   a name, a phone number, or a booking reference; resolve() sorts that out. */
function parse(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const m = HI.exec(t) || EN.exec(t);
  if (!m) return null;
  const name = m[1].trim(), message = m[2].trim();
  if (!name || !message) return null;
  return { name, message };
}

// ------------------------------------------------------------------ resolving

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/* Who did the owner mean?

   Deliberately refuses to guess. Two Rahuls means the owner is asked which one,
   because a private message delivered to the wrong customer cannot be recalled
   and is exactly the kind of thing that ends a pilot.

   Returns one of:
     { ok: true, customer, name, contact }
     { ambiguous: [contacts] }
     { none: true } */
function resolve(venueCode, store, needle) {
  const q = String(needle || '').trim();
  if (!q) return { none: true };

  // A booking reference is unambiguous, and is the escape hatch we point the
  // owner at whenever a name is not.
  if (/^[A-Za-z]{2}[0-9A-Za-z]{2,}$/.test(q)) {
    const b = store.byRef(q.toUpperCase());
    if (b) {
      const c = store.contact(b.customer);
      return { ok: true, customer: b.customer, name: (c && c.name) || b.name || q, contact: c };
    }
  }

  // A phone number typed straight in, with or without a +.
  if (/^\+?\d{10,15}$/.test(q)) {
    const customer = q.replace(/^\+/, '');
    return { ok: true, customer, name: customer, contact: store.contact(customer) };
  }

  const n = norm(q);
  const all = store.contacts(venueCode);
  // Widening rings: exact name, then any single word of it, then substring.
  // Stops at the first ring that matches, so "राहुल" does not also drag in
  // "राहुल कुमार शर्मा" when a plain "राहुल" exists.
  let hits = all.filter(c => norm(c.name) === n);
  if (!hits.length) hits = all.filter(c => norm(c.name).split(' ').includes(n));
  if (!hits.length) hits = all.filter(c => norm(c.name).includes(n));
  if (!hits.length) return { none: true };

  if (hits.length > 1) {
    // Most recent first: if the owner is going to pick, show them whoever they
    // were most likely just talking to.
    hits = hits.slice().sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
    return { ambiguous: hits };
  }
  return { ok: true, customer: hits[0].customer, name: hits[0].name, contact: hits[0] };
}

// ------------------------------------------------------------------ the window

/* Is this customer still inside WhatsApp's 24-hour service window?

   `now` is injected so this is testable without waiting a day. */
function inWindow(contact, now) {
  if (!contact || !contact.last) return false;
  const age = ((now || new Date()).getTime() - new Date(contact.last).getTime()) / 3600e3;
  return age >= 0 && age < WINDOW_HOURS;
}

// Hours until the window shuts, for telling the owner how long they have.
function hoursLeft(contact, now) {
  if (!contact || !contact.last) return 0;
  const age = ((now || new Date()).getTime() - new Date(contact.last).getTime()) / 3600e3;
  return Math.max(0, WINDOW_HOURS - age);
}

module.exports = { parse, resolve, inWindow, hoursLeft, WINDOW_HOURS };
