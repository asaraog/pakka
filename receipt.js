/* Payment screenshots.

   This is the touchpoint that already exists. A customer pays, screenshots the
   success screen, and sends it - unprompted, every time, across the whole country.
   Today the merchant squints at it and cross-checks their own app. That squint is
   the thing being automated here.

   It needs nobody's permission: no bank, no PSP, no NPCI, no Play Store. The image
   is already arriving on the venue's WhatsApp number, which is where we live.

   HONEST LIMIT: a screenshot is a CLAIM, not proof. Fake-receipt generators are a
   real fraud in India. What makes it safe enough is context - we know the exact
   amount owed, the exact VPA it must be paid to, and that a booking is on hold in
   a ten minute window. Forging all four consistently is a different order of effort
   than screenshotting someone else's payment. Where that is still not enough, set
   `trustScreenshot: false` on the venue and the owner gets a pre-filled one-tap
   confirmation instead of an open question. */

const wa = require('./wa');

// ---------------------------------------------------------------- vision

/* Sarvam Vision 1.5, via the Document Intelligence Extract endpoint.

   Chosen over a general vision model for three reasons that matter here:
   it is trained on Indian documents in 22 Indian languages, so a Hindi PhonePe
   screenshot is its home ground; Extract takes a SCHEMA and returns structured
   JSON, so there is no prose to fish a JSON object out of; and it shares
   SARVAM_KEY with sarvam.js, so a venue owner sets one key, not two.

   Unlike a chat model this is asynchronous: submit a job, poll, fetch results.
   That costs a few seconds, which is free - the owner is being handed a
   pre-filled tap, not kept waiting on a booking.

   Contract read off docs.sarvam.ai on 16 Aug 2026:
     POST /doc-ai/v1/job/extract     multipart: file, language, output_format, schema
     GET  /doc-ai/v1/job/{id}/status  -> { status: "completed" | ... }
     GET  /doc-ai/v1/job/{id}/results -> { result: {...} } */

const DOC_AI = process.env.SARVAM_DOC_URL || 'https://api.sarvam.ai/doc-ai/v1/job';

/* Extract's rules: root must be an object with a non-empty properties map, and
   every field needs a type AND a non-empty description. The descriptions are the
   actual prompt - they are what the model reads to find each field. */
const SCHEMA = {
  type: 'object',
  properties: {
    amount:    { type: 'number',  description: 'Total amount paid, in rupees, digits only, no currency symbol' },
    utr:       { type: 'string',  description: 'UPI transaction id, UTR, or reference number shown on the receipt' },
    payeeVpa:  { type: 'string',  description: 'The UPI id the money was sent TO, for example someone@okhdfcbank' },
    payeeName: { type: 'string',  description: 'The name of the person or business the money was sent TO' },
    time:      { type: 'string',  description: 'The date and time shown on the receipt, exactly as written' },
    success:   { type: 'boolean', description: 'True only if the screenshot clearly shows a completed, successful payment' },
    app:       { type: 'string',  description: 'Which payment app the screenshot is from, such as PhonePe, Google Pay, Paytm or a bank app' }
  }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Checked BEFORE the first sleep, so a job that is already done costs no delay.
const POLL_MS = Number(process.env.SARVAM_POLL_MS ?? 1000);
const POLL_TRIES = 20;

const headers = () => ({ 'api-subscription-key': process.env.SARVAM_KEY });

async function vision(image) {
  const key = process.env.SARVAM_KEY;
  if (!key) { console.warn('SARVAM_KEY unset - screenshots cannot be read'); return null; }
  try {
    /* Node 18 ships FormData and Blob globally, so multipart costs no dependency
       and no hand-rolled boundary. Do NOT set content-type: fetch writes the
       boundary itself, and overriding it breaks the upload. */
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(image.base64, 'base64')], { type: image.mime }), 'receipt.jpg');
    form.append('language', 'hi-IN');
    form.append('output_format', 'json');
    form.append('schema', JSON.stringify(SCHEMA));

    const r = await fetch(DOC_AI + '/extract', { method: 'POST', headers: headers(), body: form });
    const txt = await r.text();
    if (!r.ok) { console.error('sarvam vision %d %s', r.status, txt.slice(0, 300)); return null; }
    const job = JSON.parse(txt).job_id;
    if (!job) { console.error('sarvam vision returned no job_id'); return null; }

    // ~20 tries is generous for one screenshot and bounds the worst case.
    for (let i = 0; i < POLL_TRIES; i++) {
      const st = await fetch(`${DOC_AI}/${job}/status`, { headers: headers() });
      if (st.ok) {
        const state = (await st.json()).status;
        if (state === 'completed') {
          const res = await fetch(`${DOC_AI}/${job}/results`, { headers: headers() });
          if (!res.ok) return null;
          const out = await res.json();
          return out && out.result ? out.result : null;
        }
        if (state === 'failed') { console.error('sarvam vision job failed'); return null; }
      }
      if (POLL_MS) await sleep(POLL_MS);
    }
    console.error('sarvam vision timed out');
    return null;
  } catch (e) {
    console.error('sarvam vision call failed', e.message);
    return null;
  }
}

// Kept for the tests and for any model that answers in prose despite a schema.
function parseJson(s) {
  if (!s) return null;
  const m = /\{[\s\S]*\}/.exec(s);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// ---------------------------------------------------------------- matching

const digits = s => String(s == null ? '' : s).replace(/[^\d]/g, '');
const norm = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, '');

/* Score a parsed receipt against the booking it claims to pay for.

   Amount is the only hard gate - everything else raises or lowers confidence.
   A screenshot that says the right number, to the right VPA, minutes after we
   asked for it, is about as good as a claim gets. */
function score(venue, due, r) {
  const reasons = [];
  if (!r || r.success === false) return { ok: false, points: 0, reasons: ['not a completed payment'] };

  const want = Number(due);
  const got = Number(r.amount);
  if (!isFinite(got)) return { ok: false, points: 0, reasons: ['no amount read'] };
  if (Math.round(got) !== Math.round(want)) {
    return { ok: false, points: 0, reasons: [`amount ${got} != ${want}`] };
  }
  let points = 2;
  reasons.push('amount matches');

  // Paid to this venue's own UPI id? The strongest signal available.
  if (r.payeeVpa) {
    if (norm(r.payeeVpa) === norm(venue.vpa)) { points += 3; reasons.push('vpa matches'); }
    else { return { ok: false, points: 0, reasons: [`paid to ${r.payeeVpa}, not ${venue.vpa}`] }; }
  } else if (r.payeeName && venue.payeeName &&
             norm(r.payeeName).includes(norm(venue.payeeName).slice(0, 8))) {
    points += 2; reasons.push('payee name matches');
  }

  if (r.utr && digits(r.utr).length >= 8) { points += 1; reasons.push('utr present'); }

  return { ok: points >= 4, points, reasons };
}

/* Read a screenshot and decide what it proves.
   Returns { booking, due, parsed, verdict }; booking is null when nothing is owed. */
async function read(venue, store, from, mediaId) {
  const b = store.lastFor(from);
  if (!b || b.status !== 'hold') return { booking: null };

  // A standing slot was quoted as one total covering every week, so that total -
  // not one week's deposit - is what the receipt will show.
  const due = b.deposit + store.siblings(venue.code, b).reduce((t, x) => t + x.deposit, 0);

  const image = await wa.fetchMedia(venue, mediaId);
  if (!image) return { booking: b, due, parsed: null, verdict: { ok: false, reasons: ['image download failed'] } };

  const parsed = await vision(image);
  if (!parsed) return { booking: b, due, parsed: null, verdict: { ok: false, reasons: ['could not read image'] } };

  return { booking: b, due, parsed, verdict: score(venue, due, parsed) };
}

module.exports = { read, score, parseJson };
