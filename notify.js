/* The merchant's own payment signal - the thing they check today.

   Every merchant taking UPI already learns about a payment somehow: their bank
   texts them, or their UPI app does. They glance at it, then confirm the
   booking. This removes the glance.

   The owner FORWARDS that message to their own bot on WhatsApp and the parser
   below reads it. No app to install, no provider agreement, no integration -
   it works for every merchant on day one, which is why it is the only path
   here.

   It is the ONLY signal allowed to settle a booking, because it originates with
   the merchant's own bank or provider. A customer cannot forge it. A screenshot
   is the payer's claim about the payer's own payment, and apps exist that
   manufacture those.

   Parsing is deliberately loose. We are not announcing an amount out loud like a
   soundbox - we are answering one narrow question: did the exact sum we are
   waiting for arrive in the last few minutes? Knowing the expected amount does
   most of the work, which is why one parser handles banks we have never seen. */

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

module.exports = { parse, match, direction, amounts, utrOf, payerOf, WINDOW_MIN };
