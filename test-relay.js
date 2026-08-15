/* The relay, end to end plus the parsing underneath it.

   What is being proved: an owner on a SECOND number can still say something of
   their own to a customer, the wrong customer never receives it, and the 24-hour
   service window is reported rather than hidden. */

process.env.WA_VERIFY_TOKEN = 'verify';
process.env.DB_PATH = ':memory:';
process.env.PORT = '3997';

const http = require('node:http');
const PHONE_ID = '000000000000000';

const sent = [];
global.fetch = async (url, opt) => {
  const b = JSON.parse(opt.body);
  if (b.status !== 'read') sent.push({ to: b.to, text: b.text?.body || b.interactive?.body?.text });
  return { ok: true, text: async () => '{}' };
};

require('./server.js');
const store = require('./store');
const relay = require('./relay');

const OWNER = '9198XXXXXXXX';
const RAHUL = '919999900021', RAHUL2 = '919999900022', SITA = '919999900023';

function send(path, body, headers) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise(res => {
    const req = http.request({
      host: '127.0.0.1', port: 3997, path, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {})
    }, r => { r.resume(); r.on('end', () => setTimeout(res, 60)); });
    req.end(raw);
  });
}
const env = (m, name) => ({ entry: [{ changes: [{ value: {
  metadata: { phone_number_id: PHONE_ID },
  contacts: [{ profile: { name: name || 'ग्राहक' } }], messages: [m] } }] }] });
const msg = (from, text, name) =>
  env({ from, id: 'm' + Math.random(), type: 'text', text: { body: text } }, name);
const post = (from, text, name) => send('/webhook', msg(from, text, name));

const to = who => sent.filter(s => s.to === who).pop() || {};
const countTo = who => sent.filter(s => s.to === who).length;

let n = 0, p = 0;
const ck = (name, cond, extra) => { n++; if (cond) { p++; console.log('PASS ' + name); }
  else console.log('FAIL ' + name + (extra ? '  ' + extra : '')); };

(async () => {
  await new Promise(r => setTimeout(r, 300));

  console.log('--- parsing ---');
  const P = relay.parse('राहुल को बोल दो कि लाइट ठीक हो गई');
  ck('hindi: name extracted', P && P.name === 'राहुल', P && P.name);
  ck('hindi: message extracted', P && P.message === 'लाइट ठीक हो गई', P && P.message);
  ck('hindi: कह दो', (relay.parse('सीता को कह दो कल आना') || {}).message === 'कल आना');
  ck('hindi: बता दो', (relay.parse('सीता को बता दो रेट बढ़ गया') || {}).message === 'रेट बढ़ गया');
  ck('hindi: से कहो', (relay.parse('सीता से कहो ठीक है') || {}).message === 'ठीक है');
  ck('english: tell', (relay.parse('tell rahul the lights are fixed') || {}).message === 'the lights are fixed');
  ck('english: msg', (relay.parse('msg sita see you tomorrow') || {}).name === 'sita');

  /* The dangerous direction: ordinary owner traffic must never be read as a
     relay, or the owner's private words end up on a customer's phone. */
  ck('not a relay: "आज"', relay.parse('आज') === null);
  ck('not a relay: a business question',
    relay.parse('इस हफ्ते कितनी कमाई हुई') === null);
  ck('not a relay: a payment forward',
    relay.parse('Rs.500 credited to your A/c XX1234 by UPI ref 123456789012') === null);
  ck('not a relay: money talk with भेज दो',
    relay.parse('राहुल को ₹500 भेज दो') === null);
  ck('not a relay: name but no message', relay.parse('राहुल को बोल दो') === null);

  console.log('--- relaying to a real customer ---');
  await post(RAHUL, 'नमस्ते', 'राहुल');
  const before = countTo(RAHUL);
  await post(OWNER, 'राहुल को बोल दो कि लाइट ठीक हो गई');
  ck('customer got exactly the owner\'s words', to(RAHUL).text === 'लाइट ठीक हो गई', to(RAHUL).text);
  ck('customer got exactly one message', countTo(RAHUL) === before + 1);
  ck('owner told it went', /भेज दिया/.test(to(OWNER).text || ''), to(OWNER).text);

  console.log('--- unknown name ---');
  const sitaBefore = countTo(SITA);
  await post(OWNER, 'गीता को बोल दो कि आ जाओ');
  ck('nobody is messaged', countTo(SITA) === sitaBefore);
  ck('owner told the name is unknown', /नहीं मिला/.test(to(OWNER).text || ''), to(OWNER).text);

  console.log('--- two people with the same name ---');
  await post(RAHUL2, 'हैलो', 'राहुल');
  const r1 = countTo(RAHUL), r2 = countTo(RAHUL2);
  await post(OWNER, 'राहुल को बोल दो कि कल मत आना');
  ck('NEITHER Rahul is messaged', countTo(RAHUL) === r1 && countTo(RAHUL2) === r2,
    `${countTo(RAHUL)}/${r1} ${countTo(RAHUL2)}/${r2}`);
  ck('owner is asked which one', /2 ग्राहक/.test(to(OWNER).text || ''), to(OWNER).text);

  console.log('--- disambiguating by number ---');
  await post(OWNER, `${RAHUL2} को बोल दो कि कल मत आना`);
  ck('the named number gets it', to(RAHUL2).text === 'कल मत आना', to(RAHUL2).text);
  ck('the other Rahul does not', countTo(RAHUL) === r1, String(countTo(RAHUL)));

  console.log('--- the 24-hour window ---');
  await post(SITA, 'नमस्ते', 'सीता');
  // Reach into the contact and age it past the window.
  const c = store.contact(SITA);
  c.last = new Date(Date.now() - 25 * 3600e3).toISOString();
  const sBefore = countTo(SITA);
  await post(OWNER, 'सीता को बोल दो कि रेट बढ़ गया');
  ck('nothing is sent outside the window', countTo(SITA) === sBefore, String(countTo(SITA)));
  ck('owner is told why, not left guessing',
    /24 घंटे/.test(to(OWNER).text || ''), to(OWNER).text);

  console.log('--- window helpers ---');
  const now = new Date('2026-08-14T12:00:00Z');
  const at = h => ({ last: new Date(now.getTime() - h * 3600e3).toISOString() });
  ck('fresh contact is inside', relay.inWindow(at(1), now) === true);
  ck('23h is inside', relay.inWindow(at(23), now) === true);
  ck('25h is outside', relay.inWindow(at(25), now) === false);
  ck('never-messaged is outside', relay.inWindow(null, now) === false);
  ck('hoursLeft counts down', Math.round(relay.hoursLeft(at(20), now)) === 4,
    String(relay.hoursLeft(at(20), now)));

  console.log('--- owner traffic still works ---');
  await post(OWNER, 'आज');
  ck('"आज" still returns the day list',
    /बुकिंग|कोई/.test(to(OWNER).text || ''), to(OWNER).text);

  console.log('\n' + p + '/' + n + ' passed');
  process.exit(p === n ? 0 : 1);
})();
