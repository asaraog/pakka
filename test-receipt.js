/* Payment screenshots. Stubs the Graph media endpoints and the vision model, so
   this runs offline with no keys.

   What is being proved: a customer's screenshot - the habit that already exists -
   settles the booking, and every way it can fail leaves the owner with a
   pre-filled tap rather than an open question. */

process.env.WA_VERIFY_TOKEN = 'verify';
process.env.DB_PATH = ':memory:';
process.env.PORT = '3997';
process.env.SARVAM_KEY = 'test-key';
process.env.SARVAM_DOC_URL = 'https://sarvam.test/doc-ai/v1/job';
process.env.SARVAM_POLL_MS = '0';   // no waiting in tests

const http = require('node:http');
const PHONE_ID = '000000000000000';

const sent = [];
let visionSays = null;          // what the stubbed model returns for the next image
let visionCalls = 0;

global.fetch = async (url, opt) => {
  const u = String(url);

  /* Sarvam Document AI is a three-call job: submit, poll, collect. Stubbed as
     "completed on the first poll" - the polling loop itself is not what these
     tests are about, and a real delay would make them slow for nothing. */
  if (u.includes('sarvam.test')) {
    if (u.endsWith('/extract')) {
      visionCalls++;
      return { ok: true, text: async () => JSON.stringify({ job_id: 'JOB1', status: 'pending' }) };
    }
    if (u.endsWith('/status'))  return { ok: true, json: async () => ({ status: 'completed' }) };
    if (u.endsWith('/results')) return { ok: true, json: async () => ({ result: visionSays }) };
  }
  if (u.includes('media.test')) {                       // the binary
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  }
  if (/graph\.facebook\.com\/v\d+\.\d+\/MEDIA/.test(u)) { // the media metadata
    return { ok: true, text: async () => JSON.stringify({
      url: 'https://media.test/x.jpg', mime_type: 'image/jpeg' }) };
  }

  const b = JSON.parse(opt.body);
  if (b.status !== 'read') sent.push({
    to: b.to,
    text: b.text?.body || b.interactive?.body?.text,
    buttons: b.interactive?.action?.buttons?.map(x => x.reply.title)
  });
  return { ok: true, text: async () => '{}' };
};

require('./server.js');
const store = require('./store');
const receipt = require('./receipt');
const VENUES = require('./venues');
const V = VENUES[0];

const OWNER = '9198XXXXXXXX';

function send(path, body, headers) {
  return new Promise(res => {
    const req = http.request({
      host: '127.0.0.1', port: 3997, path, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {})
    }, r => { r.resume(); r.on('end', () => setTimeout(res, 60)); });
    req.end(JSON.stringify(body));
  });
}
const env = m => ({ entry: [{ changes: [{ value: {
  metadata: { phone_number_id: PHONE_ID },
  contacts: [{ profile: { name: 'टेस्ट टीम' } }], messages: [m] } }] }] });
const post = b => send('/webhook', b);
const msg = (from, text) => post(env({ from, id: 'm' + Math.random(), type: 'text', text: { body: text } }));
const btn = (from, id, title) => post(env({ from, id: 'm' + Math.random(), type: 'interactive',
  interactive: { button_reply: { id, title: title || '✓ हाँ, बुक करें' } } }));
const image = from => post(env({ from, id: 'm' + Math.random(), type: 'image',
  image: { id: 'MEDIA' + Math.floor(Math.random() * 1e6) } }));

const to = who => sent.filter(s => s.to === who).pop() || {};

let n = 0, p = 0;
const ck = (name, cond, extra) => { n++; if (cond) { p++; console.log('PASS ' + name); }
  else console.log('FAIL ' + name + (extra ? '  ' + extra : '')); };

// Put one customer's booking into 'hold' and hand back the row.
// Each caller passes a DIFFERENT time - cricket has only two grounds, so three
// customers at one slot is a genuine no-vacancy, not a bug.
async function holdFor(cust, text) {
  await msg(cust, text);
  await btn(cust, 'ok');
  const pend = store.pending('CHAMPION');
  await btn(OWNER, 'ok:' + pend[0].ref);
  return pend;
}

(async () => {
  await new Promise(r => setTimeout(r, 300));

  console.log('--- scoring, no network ---');
  const good = { success: true, amount: 500, utr: '412345678901', payeeVpa: V.vpa };
  ck('right amount + right vpa passes', receipt.score(V, 500, good).ok);
  ck('wrong amount fails', !receipt.score(V, 500, { ...good, amount: 300 }).ok);
  ck('right amount to WRONG vpa fails',
    !receipt.score(V, 500, { ...good, payeeVpa: 'someoneelse@ybl' }).ok);
  ck('incomplete payment fails', !receipt.score(V, 500, { success: false }).ok);
  ck('amount alone is not enough',
    !receipt.score(V, 500, { success: true, amount: 500 }).ok);
  ck('json survives a markdown fence',
    receipt.parseJson('```json\n{"amount":500}\n```').amount === 500);

  console.log('--- even a perfect screenshot never settles ---');
  // A screenshot is the PAYER's claim about the PAYER's own payment, and apps
  // exist that manufacture them. Only the merchant-side signal settles (notify.js).
  // What a good screenshot buys is a pre-filled owner tap instead of "did money come?".
  const C1 = '919999900021';
  const [b1] = await holdFor(C1, 'कल 8 बजे बॉक्स क्रिकेट');
  ck('booking is on hold', store.byRef(b1.ref).status === 'hold');
  visionSays = { success: true, amount: store.byRef(b1.ref).deposit,
    utr: '412345678901', payeeVpa: V.vpa, app: 'PhonePe' };
  await image(C1);
  ck('vision was called', visionCalls === 1, 'calls ' + visionCalls);
  ck('a flawless screenshot still does NOT settle', store.byRef(b1.ref).status === 'hold',
    'status ' + store.byRef(b1.ref).status);
  ck('customer told the owner will check', /मालिक/.test(to(C1).text || ''), to(C1).text);
  ck('owner gets the amount and utr pre-filled',
    /412345678901/.test(to(OWNER).text || '') && (to(OWNER).buttons || []).length === 2,
    to(OWNER).text);

  console.log('--- screenshot for the wrong amount ---');
  const C2 = '919999900022';
  const [b2] = await holdFor(C2, 'कल 9 बजे बॉक्स क्रिकेट');
  visionSays = { success: true, amount: 1, utr: '99', payeeVpa: V.vpa };
  await image(C2);
  ck('booking stays on hold', store.byRef(b2.ref).status === 'hold',
    'status ' + store.byRef(b2.ref).status);
  ck('owner gets a PRE-FILLED tap, not an open question',
    /रसीद आई/.test(to(OWNER).text || '') && (to(OWNER).buttons || []).length === 2, to(OWNER).text);
  ck('owner is shown what was actually read', /₹1/.test(to(OWNER).text || ''), to(OWNER).text);

  console.log('--- paid to somebody else ---');
  const C3 = '919999900023';
  const [b3] = await holdFor(C3, 'कल 10 बजे बॉक्स क्रिकेट');
  visionSays = { success: true, amount: store.byRef(b3.ref).deposit,
    utr: '412000000000', payeeVpa: 'scammer@ybl' };
  await image(C3);
  ck('wrong payee does not settle', store.byRef(b3.ref).status === 'hold');

  console.log('--- unreadable image ---');
  const C4 = '919999900024';
  const [b4] = await holdFor(C4, 'कल 11 बजे बॉक्स क्रिकेट');
  visionSays = { success: false };
  await image(C4);
  ck('unreadable stays on hold', store.byRef(b4.ref).status === 'hold');
  ck('owner still gets a tap', (to(OWNER).buttons || []).length === 2);

  console.log('--- screenshot with no booking owing ---');
  const C5 = '919999900025';
  await image(C5);
  ck('nothing owed is handled politely', /कोई भुगतान बाकी नहीं/.test(to(C5).text || ''), to(C5).text);

  console.log('--- standing slot: receipt is read against the TOTAL ---');
  const C6 = '919999900026';
  const grp = await holdFor(C6, 'हर बुधवार 9 बजे फुटबॉल');
  ck('four weeks held', grp.length === 4, 'got ' + grp.length);
  const total = grp.reduce((t, x) => t + x.deposit, 0);
  visionSays = { success: true, amount: total, utr: '413000000000', payeeVpa: V.vpa };
  await image(C6);
  ck('all four still await the merchant signal',
    grp.every(x => store.byRef(x.ref).status === 'hold'),
    grp.map(x => store.byRef(x.ref).status).join(','));
  ck('owner is shown the full total, not one week',
    new RegExp('₹' + total).test(to(OWNER).text || ''), to(OWNER).text);

  console.log('\n' + p + '/' + n + ' passed');
  process.exit(p === n ? 0 : 1);
})();
