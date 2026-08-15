/* The automatic-confirmation path. Same stubbed Graph API as test.js, plus a
   stubbed PSP, so this needs no network and no merchant account.

   What is being proved: once a venue is wired to a PSP, a booking becomes पक्का
   because money moved - not because anybody tapped anything. */

process.env.WA_VERIFY_TOKEN = 'verify';
process.env.DB_PATH = ':memory:';
process.env.PORT = '3998';
process.env.PSP_WEBHOOK_URL = 'https://example.test/psp-webhook';

const crypto = require('node:crypto');
const http = require('node:http');
const PHONE_ID = '000000000000000';
const SECRET = 'whsec-test';

// Turn the sample venue into a PSP venue before the server reads it.
const VENUES = require('./venues');
VENUES[0].psp = {
  vendor: 'cashfree',
  appId: 'test-app',
  secretKey: 'test-key',
  webhookSecret: SECRET,
  checkoutBase: 'https://pay.test/#'
};

const sent = [];
let pspCalls = 0;
global.fetch = async (url, opt) => {
  if (String(url).includes('cashfree')) {
    pspCalls++;
    return { ok: true, text: async () => JSON.stringify({ payment_session_id: 'sess_ABC' }) };
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

const OWNER = '9198XXXXXXXX', CUST = '919999900011';

function send(path, body, headers) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise(res => {
    const req = http.request({
      host: '127.0.0.1', port: 3998, path, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {})
    }, r => { r.resume(); r.on('end', () => setTimeout(res, 60)); });
    req.end(raw);
  });
}

const env = m => ({ entry: [{ changes: [{ value: {
  metadata: { phone_number_id: PHONE_ID },
  contacts: [{ profile: { name: 'टेस्ट टीम' } }], messages: [m] } }] }] });
const msg = (from, text) => env({ from, id: 'm' + Math.random(), type: 'text', text: { body: text } });
// The title matters: wa.parseWebhook feeds it to the NLU as the message text,
// which is how a customer's tap reads as "confirm".
const btn = (from, id, title) => env({ from, id: 'm' + Math.random(), type: 'interactive',
  interactive: { button_reply: { id, title: title || '✓ हाँ, बुक करें' } } });
const post = b => send('/webhook', b);

// A correctly signed Cashfree success webhook.
function hook(ref, amount, utr) {
  const body = JSON.stringify({
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    data: {
      order: { order_id: ref, order_amount: amount },
      payment: { payment_status: 'SUCCESS', bank_reference: utr || 'UTR000111' }
    }
  });
  const ts = '1760000000';
  const sig = crypto.createHmac('sha256', SECRET).update(ts + body).digest('base64');
  return send('/psp-webhook', body,
    { 'x-webhook-timestamp': ts, 'x-webhook-signature': sig });
}

const toCust = () => sent.filter(s => s.to === CUST).pop() || {};
const toOwner = () => sent.filter(s => s.to === OWNER).pop() || {};

let n = 0, p = 0;
const ck = (name, cond, extra) => { n++; if (cond) { p++; console.log('PASS ' + name); }
  else console.log('FAIL ' + name + (extra ? '  ' + extra : '')); };

(async () => {
  await new Promise(r => setTimeout(r, 300));

  console.log('--- single booking, PSP link ---');
  await post(msg(CUST, 'कल 8 बजे बॉक्स क्रिकेट'));
  await post(btn(CUST, 'ok'));
  const pend = store.pending('CHAMPION');
  ck('booking held for owner', pend.length === 1, 'got ' + pend.length);
  const ref = pend[0].ref;

  await post(btn(OWNER, 'ok:' + ref));
  ck('PSP was asked for a collect link', pspCalls === 1, 'calls ' + pspCalls);
  ck('customer got the PSP link, not a raw upi:// intent',
    /pay\.test/.test(toCust().text || '') && !/upi:\/\//.test(toCust().text || ''), toCust().text);
  ck('customer told confirmation is automatic',
    /अपने आप/.test(toCust().text || ''), toCust().text);
  ck('owner not asked to watch for money',
    !/आया क्या/.test(toOwner().text || ''), toOwner().text);

  console.log('--- customer says "भेज दिया" ---');
  const ownerBefore = sent.filter(s => s.to === OWNER).length;
  await post(msg(CUST, 'भेज दिया'));
  ck('owner is NOT pestered to confirm',
    sent.filter(s => s.to === OWNER).length === ownerBefore, 'owner got a new message');

  console.log('--- forged webhook ---');
  await send('/psp-webhook', JSON.stringify({
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    data: { order: { order_id: ref, order_amount: 500 },
            payment: { payment_status: 'SUCCESS' } }
  }), { 'x-webhook-timestamp': '1', 'x-webhook-signature': 'not-a-signature' });
  ck('bad signature changes nothing', store.byRef(ref).status === 'hold',
    'status ' + store.byRef(ref).status);

  console.log('--- wrong amount ---');
  await hook(ref, 1, 'UTRBAD');
  ck('underpayment does not confirm', store.byRef(ref).status === 'hold',
    'status ' + store.byRef(ref).status);

  console.log('--- the real thing ---');
  const due = store.byRef(ref).deposit;
  await hook(ref, due, 'UTR777');
  ck('booking settled with no human', store.byRef(ref).status === 'paid');
  ck('bank reference stored', store.byRef(ref).utr === 'UTR777', store.byRef(ref).utr);
  ck('customer told it is confirmed', /बुकिंग पक्की/.test(toCust().text || ''), toCust().text);
  ck('owner told money arrived', /आ गया/.test(toOwner().text || ''), toOwner().text);

  console.log('--- PSP retries its webhook ---');
  const before = sent.length;
  await hook(ref, due, 'UTR777');
  ck('duplicate webhook sends nothing twice', sent.length === before,
    'extra messages: ' + (sent.length - before));

  console.log('--- standing slot: one payment, four weeks ---');
  const C2 = '919999900012';
  await post(msg(C2, 'हर बुधवार 9 बजे फुटबॉल'));
  await post(btn(C2, 'ok'));
  const grp = store.pending('CHAMPION');
  ck('four weeks pending', grp.length === 4, 'got ' + grp.length);
  await post(btn(OWNER, 'ok:' + grp[0].ref));
  const total = grp.reduce((t, x) => t + x.deposit, 0);
  await hook(grp[0].ref, total, 'UTR888');
  ck('all four weeks settle on one payment',
    grp.every(x => store.byRef(x.ref).status === 'paid'),
    grp.map(x => store.byRef(x.ref).status).join(','));

  /* PhonePe PG v2, at the vendor level. No server round-trip here on purpose: what
     is being pinned down is the shape of somebody else's API, and those are the
     assertions that must scream when PhonePe changes something under us. */
  console.log('--- phonepe PG v2 ---');
  const P = require('./psp').VENDORS.phonepe;
  const pcfg = {
    vendor: 'phonepe', clientId: 'CID', clientVersion: 1, clientSecret: 'CSEC',
    env: 'sandbox', webhookUser: 'pakka', webhookPass: 's3cret'
  };
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');

  ck('phonepe accepts its own auth header',
    P.verify('{}', { authorization: sha('pakka:s3cret') }, null, pcfg) === true);
  ck('phonepe rejects a wrong password',
    P.verify('{}', { authorization: sha('pakka:wrong') }, null, pcfg) === false);
  ck('phonepe rejects a missing header', P.verify('{}', {}, null, pcfg) === false);
  ck('phonepe rejects when no credentials are configured',
    P.verify('{}', { authorization: sha('pakka:s3cret') }, null, { vendor: 'phonepe' }) === false);

  const okHook = { event: 'checkout.order.completed', payload: {
    orderId: 'OMO123', merchantOrderId: 'REF1', state: 'COMPLETED', amount: 50000,
    paymentDetails: [{ paymentMode: 'UPI_QR', transactionId: 'OM999', state: 'COMPLETED' }] } };
  const hk = P.readHook(okHook);
  ck('phonepe paise become rupees', hk.amount === 500, String(hk.amount));
  ck('phonepe ref is merchantOrderId', hk.ref === 'REF1', hk.ref);
  ck('phonepe success is ok', hk.ok === true);
  ck('phonepe keeps the transaction id', hk.utr === 'OM999', hk.utr);

  const bend = (state) => {
    const c = JSON.parse(JSON.stringify(okHook)); c.payload.state = state; return c;
  };
  ck('phonepe pending is not ok', P.readHook(bend('PENDING')).ok === false);
  /* The docs are explicit that only payload.state decides. A callback whose event
     says completed while the state says failed must not settle a booking - that is
     the difference between a paid slot and a stolen evening. */
  ck('phonepe trusts state over event name', P.readHook(bend('FAILED')).ok === false);

  const body = P.createBody({ code: 'CHAMPION' }, { ref: 'REF1', customer: CUST }, 500);
  ck('phonepe amount is paise', body.amount === 50000, String(body.amount));
  ck('phonepe amount clears the 100 paise minimum', body.amount >= 100);
  ck('phonepe expiry within the documented 300-3600',
    body.expireAfter >= 300 && body.expireAfter <= 3600, String(body.expireAfter));
  ck('phonepe flow type', body.paymentFlow.type === 'PG_CHECKOUT');
  ck('phonepe merchantOrderId is our booking ref', body.merchantOrderId === 'REF1');

  let authCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async (url, opt) => {
    authCalls++;
    ck('phonepe auth is form-encoded',
      opt.headers['content-type'] === 'application/x-www-form-urlencoded');
    ck('phonepe sandbox auth host', String(url).includes('pg-sandbox/v1/oauth/token'), String(url));
    ck('phonepe auth sends client_credentials',
      String(opt.body).includes('grant_type=client_credentials'), String(opt.body));
    return { ok: true, text: async () => JSON.stringify({
      access_token: 'TKN', token_type: 'O-Bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600 }) };
  };
  const hdr1 = await P.headers(pcfg);
  await P.headers(pcfg);
  global.fetch = realFetch;
  ck('phonepe sends O-Bearer', hdr1.Authorization === 'O-Bearer TKN', hdr1.Authorization);
  ck('token is cached, not refetched every payment', authCalls === 1, 'auth calls ' + authCalls);

  console.log('\n' + p + '/' + n + ' passed');
  process.exit(p === n ? 0 : 1);
})();
