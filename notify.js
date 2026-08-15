/* The merchant's own payment signal - the thing they check today.

   Every merchant taking UPI already learns about a payment somehow. They glance at
   it, then confirm the booking. This removes the glance, and it is the ONLY signal
   allowed to settle a booking, because it originates with the merchant's own
   provider or device. A customer cannot forge it. A screenshot is the payer's claim
   about the payer's own payment, and apps exist that manufacture those.

   Three sources, in order of preference. All of them land on POST /notify and are
   normalised to the same shape, so the matching below never knows the difference.

     1. PROVIDER CALLBACK - the merchant's existing QR provider posts to us.
        PhonePe's "Integrated Static QR with Callback" and Paytm's dashboard
        webhook both do this. Nothing on the merchant's side changes: same QR on
        the wall, same VPA, same instant credit, same zero fee. This is the
        plug-and-play option and it should always be tried first.

     2. PROVIDER POLL - PhonePe's Transaction-List + Metadata API, for merchants
        whose provider will not push. Slower, but no device involved.

     3. DEVICE - a NotificationListenerService app on the merchant's phone, reading
        whatever their UPI app or bank posts. Last resort, because it is an app to
        install and a parser to maintain, but it is the only source that works for
        a merchant with no provider relationship at all.

   Parsing for source 3 is deliberately loose. We are not announcing an amount out
   loud like a soundbox - we are answering one narrow question: did the exact sum we
   are waiting for arrive in the last few minutes? Knowing the expected amount does
   most of the work, which is why one generic parser handles apps we have never
   seen, and why chasing thirty app-specific parsers is not necessary. */

const crypto = require('node:crypto');

// ------------------------------------------------------------------ parsing

/* Credit or debit? A merchant's phone sees both, and settling a booking because
   the owner PAID somebody ₹500 would be the worst bug in the system. Checked
   first, and anything ambiguous is thrown away. */
/* Bare "credit"/"debit" are deliberately absent: "credit card" and "debit card"
   appear in messages going the other way and would flip the verdict. Only verbs
   and unambiguous phrases.

   "sent" cuts both ways in real messages and is split accordingly:
     GPay credit:  "Rahul Kumar sent you ₹500"          -> sent you = credit
     HDFC debit:   "Sent Rs.1500.00 from HDFC Bank AC XX1234 to john@okicici"

   CARD_BILL: "Payment of INR 500 has been received towards your ICICI Bank Credit
   Card" (real ICICI wording) says RECEIVED but is the merchant paying their own
   card bill. It must never settle a booking. */
// "credit by"/"debit by" are the real SBI transfer wordings ("has a credit by
// Transfer of Rs...") - verified from captured samples, not guessed.
const CREDIT = /(received|receiving|credited|credit by|deposited|sent you|प्राप्त|मिले|मिल गए|जमा|आए|prapt)/i;
const DEBIT = /(\bsent\b(?!\s*you)|paid to|payment to|debited|debit by|withdrawn|spent|transferred to|भेजे|भुगतान किया|कटे|निकाले)/i;
const CARD_BILL = /(received\s+)?towards your .{0,30}(credit\s*card|card)/i;

function direction(text) {
  if (CARD_BILL.test(text)) return 'card-bill';
  const d = DEBIT.exec(text), c = CREDIT.exec(text);
  if (d && !c) return 'debit';
  if (c && !d) return 'credit';
  /* Both verbs is NORMAL in Indian bank SMS, not noise - the wire formats name
     both sides of the transfer, account holder first:
       ICICI: "Acct XX62 debited for Rs 150.00 ...; JioCinema credited."
       ICICI: "Acct XX82 credited with Rs 500.00 ...; RAHUL KUMAR debited."
       SBI:   "Your a/c no. XX00 is debited for Rs.500 ... and a/c XX01 credited"
     So when both appear, the EARLIER verb is the holder's side and wins. */
  if (c && d) return d.index < c.index ? 'debit' : 'credit';
  return 'unknown';
}

/* Amounts. Handles ₹500, Rs.500, Rs 1,250.00, INR 500, and 500.00 next to a
   currency word. Indian grouping (1,25,000) is just commas to us. */
const AMOUNT = /(?:₹|\bRs\.?\b|\bINR\b)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:रुपये|rupees|\bRs\.?\b)/gi;

function amounts(text) {
  const out = [];
  let m;
  AMOUNT.lastIndex = 0;
  while ((m = AMOUNT.exec(text)) !== null) {
    const n = Number(String(m[1] || m[2]).replace(/,/g, ''));
    if (isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

// UPI reference / UTR: a long digit run, usually 12. Account tails (XX1234) excluded.
function utrOf(text) {
  const m = /(?:utr|upi(?:\s*(?:ref|txn|transaction))?(?:\s*(?:no|id|number))?|ref(?:erence)?(?:\s*no)?)\D{0,6}(\d{8,22})/i.exec(text);
  if (m) return m[1];
  const bare = /\b(\d{12})\b/.exec(text);
  return bare ? bare[1] : null;
}

// "received from Rahul Kumar", "from RAHUL K", "Rahul से"
function payerOf(text) {
  const m = /\bfrom\s+([A-Za-z][A-Za-z .'-]{1,40})/i.exec(text) ||
            /([ऀ-ॿ A-Za-z.'-]{2,40})\s*से\b/.exec(text);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

function parse(text) {
  const t = String(text || '');
  const dir = direction(t);
  const amt = amounts(t);
  return {
    direction: dir,
    amounts: amt,
    amount: amt.length ? amt[0] : null,
    utr: utrOf(t),
    payer: payerOf(t),
    text: t
  };
}

// ------------------------------------------------------------------ sources

/* Normalise every source into { direction, amounts, amount, utr, payer }.

   !! The provider payload shapes below are written from the documented forms and
   !! MUST be checked against live callbacks before go-live. The normalisation
   !! boundary is the point - adding a provider is one function, not a refactor. */
const SOURCES = {
  /* PhonePe Integrated Static QR S2S callback. Shape verified against
     developer.phonepe.com/offline-integration (Aug 2026):
       - body is { "response": "<base64 JSON>" }
       - X-VERIFY: SHA256(base64response + saltKey) + "###" + saltIndex
       - amount is in PAISE
       - success: data.paymentState === "COMPLETED", code "PAYMENT_SUCCESS"
       - bank UTR sits inside data.paymentModes[].utr
     Set venue.notify.saltKey to enforce X-VERIFY; without it the shared token in
     the URL is the only auth, which is fine for a pilot and says so in the log. */
  phonepe(body, cfg, headers) {
    if (!body || typeof body.response !== 'string') return null;
    if (cfg && cfg.saltKey) {
      const want = crypto.createHash('sha256')
        .update(body.response + cfg.saltKey).digest('hex') + '###' + (cfg.saltIndex || 1);
      const got = headers && (headers['x-verify'] || headers['X-VERIFY']);
      if (got !== want) { console.warn('phonepe X-VERIFY mismatch'); return null; }
    } else {
      console.log('phonepe callback accepted on token only (no saltKey configured)');
    }
    let d;
    try { d = JSON.parse(Buffer.from(body.response, 'base64').toString('utf8')); }
    catch (e) { return null; }
    const data = (d && d.data) || {};
    const paise = Number(data.amount);
    if (!isFinite(paise)) return null;
    const rupees = paise / 100;
    const ok = d.success === true &&
      (data.paymentState === 'COMPLETED' || d.code === 'PAYMENT_SUCCESS');
    const modes = Array.isArray(data.paymentModes) ? data.paymentModes : [];
    return {
      direction: ok ? 'credit' : 'unknown',
      amounts: [rupees], amount: rupees,
      utr: (modes.find(m => m && m.utr) || {}).utr || data.providerReferenceId || null,
      payer: null,
      text: '[phonepe callback]'
    };
  },

  /* Paytm merchant webhook - flat key/value, amount in rupees as a string. */
  paytm(body) {
    const b = (body && body.body) || body || {};
    const amt = Number(b.TXNAMOUNT != null ? b.TXNAMOUNT : b.txnAmount);
    if (!isFinite(amt)) return null;
    const st = String(b.STATUS || b.status || '');
    return {
      direction: /SUCCESS/i.test(st) ? 'credit' : 'unknown',
      amounts: [amt], amount: amt,
      utr: b.BANKTXNID || b.bankTxnId || null,
      payer: null,
      text: '[paytm webhook]'
    };
  },

  /* Everyone else - banks and aggregators, of which there are a dozen and rising.

     Rather than invent a payload shape per bank and get each one subtly wrong,
     onboarding maps the fields once in `venue.notify.map`:

       map: { amount: 'data.amount', paise: true,
              status: 'data.state', successWhen: 'COMPLETED',
              utr: 'data.rrn', payer: 'data.payerName' }

     Adding ICICI, HDFC, Axis, Kotak, Razorpay or Cashfree is then a config line
     written while reading their docs with a real callback in front of you - not a
     code change, and not a guess made here. */
  generic(body, cfg) {
    const map = (cfg && cfg.map) || {};
    const at = path => String(path || '').split('.')
      .reduce((o, k) => (o == null ? o : o[k]), body);

    let amt = Number(at(map.amount));
    if (!isFinite(amt)) return null;
    if (map.paise) amt = amt / 100;

    const ok = map.status
      ? String(at(map.status)) === String(map.successWhen)
      : true;                                   // no status field means success-only callbacks
    return {
      direction: ok ? 'credit' : 'unknown',
      amounts: [amt], amount: amt,
      utr: map.utr ? (at(map.utr) || null) : null,
      payer: map.payer ? (at(map.payer) || null) : null,
      text: '[' + (cfg && cfg.label || 'generic') + ' callback]'
    };
  },

  /* The Android listener, for a merchant whose provider will not call us - or who
     has no provider at all, just a personal VPA and a printed QR. Sends whatever
     their UPI app or bank actually posted, and the generic text parser reads it. */
  device(body) {
    const text = [body && body.title, body && body.text, body && body.body]
      .filter(Boolean).join(' ');
    return text ? parse(text) : null;
  }
};

const normalise = (source, body, cfg, headers) =>
  (SOURCES[source] ? SOURCES[source](body, cfg, headers) : null);

// ------------------------------------------------------------------ matching

const WINDOW_MIN = Number(process.env.NOTIFY_WINDOW_MIN || 20);

/* Which booking, if any, does this notification pay for?

   Deliberately conservative. Ambiguity resolves to "ask the owner", never to a
   guess - a wrongly auto-confirmed booking costs a real slot on a real evening.

   `now` is injected so this is testable without waiting twenty minutes. */
function match(venue, store, p, now) {
  if (p.direction === 'debit') return { ok: false, reason: 'a debit, not a credit' };
  if (p.direction !== 'credit') return { ok: false, reason: 'direction unclear' };
  if (!p.amount) return { ok: false, reason: 'no amount found' };

  const t = (now || new Date()).getTime();
  const holds = store.holds(venue.code).filter(b => {
    const age = (t - new Date(b.held || b.created).getTime()) / 60000;
    return age >= -1 && age <= WINDOW_MIN;
  });
  if (!holds.length) return { ok: false, reason: 'nothing awaiting payment' };

  // A standing slot is one charge across several weeks, so compare against the
  // group total rather than a single row's deposit.
  const due = b => b.deposit + store.siblings(venue.code, b).reduce((s, x) => s + x.deposit, 0);
  const hit = holds.filter(b => p.amounts.some(a => Math.round(a) === Math.round(due(b))));

  if (!hit.length) return { ok: false, reason: `₹${p.amount} matches no booking on hold` };
  if (hit.length > 1) {
    return { ok: false, reason: `₹${p.amount} matches ${hit.length} bookings`, ambiguous: hit };
  }
  return { ok: true, booking: hit[0], due: due(hit[0]), reason: 'amount and window match' };
}

module.exports = { parse, match, normalise, SOURCES, direction, amounts, utrOf, payerOf, WINDOW_MIN };
