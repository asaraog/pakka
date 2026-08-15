/* Merchant-side payment signals: coverage across the apps and banks a real
   merchant might be on, plus the provider-callback adapters.

   The corpus below is the actual point of this file. "30+ apps" is a payer-side
   number; what matters is the handful of shapes a MERCHANT's phone or provider
   produces. One generic parser plus an expected amount covers them. */

process.env.WA_VERIFY_TOKEN = 'verify';
process.env.DB_PATH = ':memory:';
process.env.PORT = '3996';

const http = require('node:http');
const PHONE_ID = '000000000000000';
const TOKEN = 'tok-test';

const sent = [];
global.fetch = async (url, opt) => {
  const b = JSON.parse(opt.body);
  if (b.status !== 'read') sent.push({ to: b.to, text: b.text?.body || b.interactive?.body?.text,
    buttons: b.interactive?.action?.buttons?.map(x => x.reply.title) });
  return { ok: true, text: async () => '{}' };
};

const VENUES = require('./venues');
VENUES[0].notify = { token: TOKEN, source: 'device' };

require('./server.js');
const store = require('./store');
const N = require('./notify');
const V = VENUES[0];
const OWNER = '9198XXXXXXXX';

function send(path, body, headers) {
  return new Promise(res => {
    const req = http.request({ host: '127.0.0.1', port: 3996, path, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) },
      r => { r.resume(); r.on('end', () => setTimeout(res, 60)); });
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
const to = who => sent.filter(s => s.to === who).pop() || {};

let n = 0, p = 0;
const ck = (name, cond, extra) => { n++; if (cond) { p++; console.log('PASS ' + name); }
  else console.log('FAIL ' + name + (extra ? '  ' + extra : '')); };

// ---- the corpus. Real shapes, from the merchant's side. ----

/* VERIFIED entries are real formats taken from public sources - the avinal/IVY
   gist of collected bank SMS (gist.github.com/avinal/4079e1752e5b987530315b4802e51287)
   and the banking-sms-json-parser-v8 model card - with only the redacted
   x's/names/amounts filled in. RECON entries are reconstructions still awaiting a
   real capture: ONBOARDING RULE - every new merchant forwards their last three
   payment messages, which get pasted here and run before their bot goes live. */
const CREDITS = [
  // VERIFIED formats
  ['SBI IMPS credit',
    'Dear Customer, Your a/c no. XXXXXXXX3450 is credited by Rs.500.00 on 12-08-26 by a/c linked to mobile 9XXXXXX999-RAHUL KUMAR (IMPS Ref no 412345678901).If not done by you, call 1800111109. -SBI', 500],
  ['SBI transfer credit',
    'Dear Customer, Your A/C XXXXX123456 has a credit by Transfer of Rs 500.00 on 12/08/26 by Bank. Avl Bal Rs 8420.00.-SBI', 500],
  ['SBI deposit credit',
    'Your A/C XXXXX983974 Credited INR 500.00 on 12/08/26 -Deposit by transfer from RAHUL KUMAR. Avl Bal INR 8000.00-SBI', 500],
  ['Paytm Payments Bank',
    'Rs.500.00 received from Rahul Kumar in your Paytm Payments Bank a/c 91XX01234. UPI Ref: 412345678901. Check your Avl Bal: https://m.paytm.me/pbCheckBal', 500],
  ['SBI NEFT credit',
    'Rs.1250 credited to your SBI Bank a/c XX5678 via NEFT from beneficiary COMPANY LTD.', 1250],
  // RECON - replace with each merchant's real capture at onboarding
  ['Google Pay (recon)',   'Rahul Kumar sent you ₹500', 500],
  ['PhonePe (recon)',      '₹500 received from Rahul Kumar', 500],
  ['BHIM (recon)',         'Rs.500 credited to your account', 500],
  ['Amazon Pay (recon)',   'You have received ₹500 from Rahul', 500],
  ['HDFC (recon)',         'Rs.500.00 credited to a/c XXXXXX1234 on 12-08-26 by UPI ref no 412345678901', 500],
  // ICICI names BOTH sides - "Acct ... credited ...; <payer> debited". The
  // two-sided format is the trap: first verb is the holder's side and must win.
  ['ICICI UPI credit (two-sided)',
    'ICICI Bank Acct XX823 credited with Rs 500.00 on 12-Aug-26; RAHUL KUMAR debited. UPI:412345678901. Call 18002662 for dispute.', 500],
  ['ICICI NEFT credit',
    'ICICI Bank: Your A/c XX1608 credited with Rs.500.00 on 12-08-26. NEFT Ref: 869375626357', 500],
  ['Kotak credit',
    'Rs.500.00 credited to Kotak A/c XX3757 on 12-08-26 from rahul@icici. Ref: 770221145150', 500],
  ['SBI UPI credit',
    'SBI: Rs.500.00 credited to a/c XX4810 on 12-08-26. UPI from rahul@okicici. Ref: 201270775138', 500],
  ['Axis (recon)',         'INR 500.00 credited to A/c no. XX1234 on 12-08-26. Info- UPI/P2A/412345678901/RAHUL', 500],
  ['IDFC (recon)',         'INR 500.00 has been credited to your IDFC FIRST Bank Account XXXX1234', 500],
  ['Hindi',                '₹500 प्राप्त हुए', 500],
  ['lakh grouping',        'Rs.1,250.00 credited to a/c XX1234 by UPI', 1250],
  ['rupees word',          '500 rupees received from Rahul', 500]
];

const DEBITS = [
  // VERIFIED formats - a merchant's phone sees these too, and none may settle
  ['HDFC UPI sent',
    'Sent Rs.1500.00 from HDFC Bank AC XX1234 to john@okicici on 12-08-26.UPI Ref 123456789012.'],
  ['SBI UPI debit',
    'Dear SBI User, your A/c X1234-debited by Rs500.0 on 12Aug26 transfer to Merchant Ref No 412345678901. If not done by u, fwd this SMS to 9223008333'],
  ['SBI INB debit',
    'Dear Customer, Thx for INB txn of Rs.500.00 frm A/c x0000 to ICICI Bank. Ref XXXXXX123456 on 12Aug26.'],
  ['Paytm sent',
    'Rs.500.00 sent to merchant@bankid from BANKNAME a/c 91XX1234. UPI Ref:412345678901.'],
  ['Paytm paid',
    'Paid Rs.500.00 via a/c 91XX1234 to Merchant Name on 12-08-2026. Ref No: 4123456789 :PPBL'],
  ['ICICI card bill paid by merchant',
    'Dear Customer, Payment of INR 500.00 has been received towards your ICICI Bank Credit Card XX1234 on 12-AUG-26 through UPI. Thank you.'],
  ['ICICI UPI debit (two-sided)',
    'ICICI Bank Acct XX6291 debited for Rs 500.00 on 12/08/2026; JioCinema credited. UPI:538312603649. Call 18002662 for dispute.'],
  ['SBI IMPS debit (two-sided)',
    'Dear Customer, Your a/c no. XXXXXXXX0000 is debited for Rs.500.00 on 12-08-26 and a/c XXXXXXX000 credited (IMPS Ref no 412345678901).If not done by you, call 1800111109 -SBI'],
  // RECON
  ['GPay paid (recon)',    'You paid ₹500 to Champion Arena'],
  ['bank debit (recon)',   'Rs.500.00 debited from a/c XXXXXX1234 on 12-08-26'],
  ['PhonePe sent (recon)', '₹500 sent to Sharma Sports'],
  ['Hindi debit',          '₹500 भेजे गए']
];

(async () => {
  await new Promise(r => setTimeout(r, 300));

  console.log('--- credits parse across apps and banks ---');
  for (const [name, text, want] of CREDITS) {
    const r = N.parse(text);
    ck(name, r.direction === 'credit' && r.amounts.some(a => a === want),
      `dir=${r.direction} amts=${JSON.stringify(r.amounts)}`);
  }

  console.log('--- debits never look like credits ---');
  for (const [name, text] of DEBITS) {
    ck(name, N.parse(text).direction !== 'credit', N.parse(text).direction);
  }

  console.log('--- account numbers are not amounts ---');
  ck('a/c XXXXXX1234 ignored',
    !N.parse('Rs.500 credited to a/c XXXXXX1234').amounts.includes(1234));
  ck('utr is not read as an amount',
    !N.parse('Rs.500 credited by UPI ref no 412345678901').amounts.includes(412345678901));
  ck('"credit card" does not flip a debit',
    N.parse('Rs.500 debited from your credit card').direction !== 'credit');

  console.log('--- utr extraction ---');
  ck('UPI ref no', N.utrOf('by UPI ref no 412345678901') === '412345678901');
  ck('UPI/ slash form', N.utrOf('Info- UPI/P2A/412345678901/RAHUL') === '412345678901');
  ck('bare 12 digits', N.utrOf('txn 412345678901 done') === '412345678901');
  ck('no utr is null', N.utrOf('Rs.500 received') === null);

  console.log('--- provider callback adapters ---');
  // The documented S2S shape: base64 response, paise, paymentState, utr in paymentModes.
  const ppBody = { response: Buffer.from(JSON.stringify({
    success: true, code: 'PAYMENT_SUCCESS', message: 'Your payment is successful.',
    data: {
      transactionId: 'T2508121812', merchantId: 'MERCHANTUAT',
      providerReferenceId: 'P2508121812', amount: 50000,
      paymentState: 'COMPLETED', payResponseCode: 'SUCCESS',
      paymentModes: [{ mode: 'ACCOUNT', amount: 50000, utr: '412345678901' }],
      transactionContext: { qrCodeId: 'QR1', storeId: 'S1', terminalId: 'T1' }
    }
  })).toString('base64') };
  const pp = N.normalise('phonepe', ppBody);
  ck('phonepe paise -> rupees', pp && pp.amount === 500, JSON.stringify(pp));
  ck('phonepe reads as credit', pp && pp.direction === 'credit');
  ck('phonepe utr comes from paymentModes', pp && pp.utr === '412345678901', pp && pp.utr);

  const crypto = require('node:crypto');
  const salt = 'salt-test';
  const xv = crypto.createHash('sha256').update(ppBody.response + salt).digest('hex') + '###1';
  const ppOk = N.normalise('phonepe', ppBody, { saltKey: salt, saltIndex: 1 }, { 'x-verify': xv });
  ck('phonepe X-VERIFY accepted when correct', ppOk && ppOk.amount === 500);
  ck('phonepe X-VERIFY rejected when wrong',
    N.normalise('phonepe', ppBody, { saltKey: salt }, { 'x-verify': 'garbage###1' }) === null);
  ck('phonepe failed payment is not a credit',
    N.normalise('phonepe', { response: Buffer.from(JSON.stringify({
      success: false, code: 'PAYMENT_ERROR',
      data: { amount: 50000, paymentState: 'FAILED' } })).toString('base64') })
      .direction !== 'credit');

  const pt = N.normalise('paytm', { STATUS: 'TXN_SUCCESS', TXNAMOUNT: '500.00', BANKTXNID: 'B9' });
  ck('paytm amount + utr', pt && pt.amount === 500 && pt.utr === 'B9', JSON.stringify(pt));
  ck('paytm failure is not a credit',
    N.normalise('paytm', { STATUS: 'TXN_FAILURE', TXNAMOUNT: '500.00' }).direction !== 'credit');

  const gen = N.normalise('generic', { data: { amt: 50000, st: 'COMPLETED', rrn: 'R7' } },
    { label: 'icici', map: { amount: 'data.amt', paise: true, status: 'data.st',
                             successWhen: 'COMPLETED', utr: 'data.rrn' } });
  ck('generic field map works', gen && gen.amount === 500 && gen.utr === 'R7', JSON.stringify(gen));
  ck('generic wrong status is not a credit',
    N.normalise('generic', { data: { amt: 50000, st: 'FAILED' } },
      { map: { amount: 'data.amt', paise: true, status: 'data.st', successWhen: 'COMPLETED' } })
      .direction !== 'credit');

  console.log('--- end to end ---');
  const C1 = '919999900031';
  await msg(C1, 'कल 8 बजे बॉक्स क्रिकेट');
  await btn(C1, 'ok');
  const b1 = store.pending('CHAMPION')[0];
  await btn(OWNER, 'ok:' + b1.ref);
  ck('on hold', store.byRef(b1.ref).status === 'hold');

  await send('/notify', { text: 'You received ₹500 from Rahul Kumar' }, { 'x-pakka-token': 'wrong' });
  ck('bad token settles nothing', store.byRef(b1.ref).status === 'hold');

  await send('/notify', { text: 'You paid ₹500 to Champion Arena' }, { 'x-pakka-token': TOKEN });
  ck('a debit settles nothing', store.byRef(b1.ref).status === 'hold');

  await send('/notify', { text: 'You received ₹300 from Rahul' }, { 'x-pakka-token': TOKEN });
  ck('wrong amount settles nothing', store.byRef(b1.ref).status === 'hold');

  await send('/notify', { title: 'PhonePe', text: 'You received ₹500 from Rahul Kumar' },
    { 'x-pakka-token': TOKEN });
  ck('the real credit settles it, no human', store.byRef(b1.ref).status === 'paid');
  ck('customer told', /बुकिंग पक्की/.test(to(C1).text || ''), to(C1).text);

  console.log('--- ambiguity refuses to guess ---');
  // Both must be PEAK hours so both owe the same advance - that is the whole
  // point of the test. ("10 बजे" parses to 10am and would owe ₹350.)
  const A = '919999900032', B = '919999900033';
  for (const [who, when] of [[A, 'कल 8 बजे बॉक्स क्रिकेट'], [B, 'कल 9 बजे बॉक्स क्रिकेट']]) {
    await msg(who, when);
    await btn(who, 'ok');
    const row = store.pending('CHAMPION')[0];
    await btn(OWNER, 'ok:' + row.ref);
  }
  const two = store.holds('CHAMPION');
  ck('two bookings on hold', two.length === 2, 'got ' + two.length);
  ck('and both owe the same amount',
    two.length === 2 && two[0].deposit === two[1].deposit,
    two.map(x => x.deposit).join(' vs '));
  await send('/notify', { text: 'You received ₹500 from someone' }, { 'x-pakka-token': TOKEN });
  ck('two candidates -> settles neither',
    two.every(x => store.byRef(x.ref).status === 'hold'),
    two.map(x => store.byRef(x.ref).status).join(','));

  console.log('--- tier 0: owner forwards the SMS on WhatsApp ---');
  // Age one ambiguity leftover out of the window and cancel the other, so this
  // section has exactly one ₹500 hold - the refusal-to-guess above already passed.
  store.byRef(two[0].ref).held = new Date(Date.now() - 60 * 60000).toISOString();
  store.setStatus(two[1].ref, 'cancelled');
  const C7 = '919999900034';
  await msg(C7, 'कल 7 बजे बॉक्स क्रिकेट');
  await btn(C7, 'ok');
  const b7 = store.pending('CHAMPION')[0];
  await btn(OWNER, 'ok:' + b7.ref);
  ck('fresh hold', store.byRef(b7.ref).status === 'hold');

  // Owner forwards a debit first - their own spending must change nothing.
  await msg(OWNER, 'Sent Rs.500.00 from HDFC Bank AC XX1234 to john@okicici on 12-08-26.UPI Ref 123456789012.');
  ck('forwarded debit settles nothing', store.byRef(b7.ref).status === 'hold');

  await msg(OWNER, 'Dear Customer, Your a/c no. XXXXXXXX3450 is credited by Rs.500.00 on 12-08-26 by a/c linked to mobile 9XXXXXX999-RAHUL KUMAR (IMPS Ref no 412345678901).If not done by you, call 1800111109. -SBI');
  ck('forwarded credit SMS settles the booking', store.byRef(b7.ref).status === 'paid',
    'status ' + store.byRef(b7.ref).status);
  ck('utr captured from the forward', store.byRef(b7.ref).utr === '412345678901',
    store.byRef(b7.ref).utr);
  ck('customer told', /बुकिंग पक्की/.test(to(C7).text || ''), to(C7).text);

  await msg(OWNER, 'Rs.750.00 received from Someone in your Paytm Payments Bank a/c 91XX01234. UPI Ref: 999888777666.');
  ck('forward matching nothing says so, settles nothing',
    /मेल नहीं खाया|कोई बुकिंग बाकी नहीं/.test(to(OWNER).text || ''), to(OWNER).text);

  await msg(OWNER, 'आज');
  ck('day view still works after the forward path', /बुकिंग/.test(to(OWNER).text || ''));

  console.log('--- stale holds fall outside the window ---');
  const old = two[0];
  store.byRef(old.ref).held = new Date(Date.now() - 60 * 60000).toISOString();
  store.byRef(two[1].ref).status = 'cancelled';
  await send('/notify', { text: 'You received ₹500 from someone' }, { 'x-pakka-token': TOKEN });
  ck('an hour-old hold is not settled by a fresh credit',
    store.byRef(old.ref).status === 'hold', store.byRef(old.ref).status);

  console.log('\n' + p + '/' + n + ' passed');
  process.exit(p === n ? 0 : 1);
})();
