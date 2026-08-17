/* Your venue.

   THE WHOLE FILE IS A FALLBACK. In production your venue comes from the
   VENUES_JSON environment variable, and nothing below is used.

   That split is deliberate. Everything describing a venue is either private or
   identifying - the owner's personal WhatsApp number, their UPI id - and a fork
   of a public repo is public. Keeping it in an environment variable means the
   repo holds code only, so anyone can fork this without publishing their phone
   number by accident.

     VENUES_JSON   the whole array, as JSON. `node onboard.js` prints it ready
                   to paste into Render -> Environment.

   With VENUES_JSON unset you get the sample below, which is enough to run the
   tests and see the bot answer. It cannot send anything: there is no token in
   it, and there must never be one.

   Inbound messages are routed by waPhoneId, which Meta puts in every webhook,
   so `code` is only used for the optional wa.me deep link. */

/* Three places a venue can come from, in order:

     1. VENUES_JSON        an environment variable. Production. Nothing private
                           enters the repo, so a public fork leaks nothing.
     2. venues.local.js    a file you write by hand, gitignored. Same shape as
                           the sample below, and it is JavaScript, so you can
                           comment it however you like. JSON cannot carry
                           comments, which is the whole reason this exists.
     3. the sample below   committed, no token, runs the tests. */

/* venues.local.js is optional and gitignored. require() throwing MODULE_NOT_FOUND
   is the normal case; anything else is a real error in a file you wrote, so it
   is reported rather than swallowed. */
let local;
function tryLocal() {
  try {
    return require('./venues.local.js');
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' || !/venues\.local/.test(e.message)) {
      console.error('venues.local.js exists but could not be loaded: ' + e.message);
      process.exit(1);
    }
    return null;
  }
}

/* A bad paste should stop the server, loudly, at boot. Falling back to the
   sample would leave a venue silently answering with someone else's prices. */
if (process.env.VENUES_JSON) {
  let parsed;
  try {
    parsed = JSON.parse(process.env.VENUES_JSON);
  } catch (e) {
    console.error('VENUES_JSON is not valid JSON: ' + e.message);
    console.error('Re-run `node onboard.js` and paste its output exactly.');
    process.exit(1);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    console.error('VENUES_JSON must be a non-empty array of venues.');
    process.exit(1);
  }
  const bad = parsed.find(v => !v.waPhoneId || !v.waToken || !v.ownerPhone || !v.vpa);
  if (bad) {
    console.error('venue "' + (bad.code || '?') + '" is missing one of: waPhoneId, waToken, ownerPhone, vpa');
    process.exit(1);
  }
  module.exports = parsed;
} else if ((local = tryLocal())) {
  module.exports = local;
} else {

module.exports = [
  {
    code: 'CHAMPION',
    waPhoneId: process.env.WA_PHONE_ID || '000000000000000',
    wabaId: process.env.WABA_ID || '',   // used by onboard.js to subscribe our app
    // NEVER put a real token here. This file is meant to be safe to commit,
    // even to a public repo. Set WA_TOKEN in your host's environment instead.
    waToken: process.env.WA_TOKEN || '',
    name: 'चैंपियन स्पोर्ट्स एरिना',
    nameEn: 'Champion Sports Arena',
    ownerPhone: process.env.OWNER_PHONE || '9198XXXXXXXX',   // owner's WhatsApp, digits only with country code
    vpa: 'championarena@okhdfcbank',   // the venue's OWN existing UPI id
    payeeName: 'Champion Sports Arena',

    /* Sarvam AI, per venue. Needs SARVAM_KEY set on the server; `ai: false`
       switches this venue back to pure-regex. What it adds:
         customer side - messy/conversational messages get understood or answered
         owner side    - ask your business questions in Hindi ("इस हफ्ते कमाई?")
       It interprets and reports only: bookings still confirm through the same
       approval buttons, prices come from this file, money is never touched. */
    ai: true,

    open: 6, close: 23,
    off: -1,                           // weekly closed day, -1 for never
    peakFrom: 17, peakTo: 23, peakMult: 1.5,
    depositPct: 0.3, depositMin: 200, depositMax: 500,
    grounds: [
      { id: 'g1', hi: 'ग्राउंड 1' },
      { id: 'g2', hi: 'ग्राउंड 2' },
      { id: 'c1', hi: 'बैडमिंटन कोर्ट' }
    ],
    // which grounds each sport can use; omit to allow all
    services: [
      { id: 'cricket', hi: 'बॉक्स क्रिकेट', price: 1200, mins: 60, grounds: ['g1', 'g2'] },
      { id: 'football', hi: 'फुटबॉल', price: 1200, mins: 60, grounds: ['g1', 'g2'] },
      { id: 'badminton', hi: 'बैडमिंटन', price: 400, mins: 60, grounds: ['c1'] },
      { id: 'pickle', hi: 'पिकलबॉल', price: 600, mins: 60, grounds: ['c1'] }
    ]
  }
];

}
