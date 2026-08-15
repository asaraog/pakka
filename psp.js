/* Payment service provider adapter.

   The product requirement is absolute and drives every choice here:
     - the money reaches the VENUE'S OWN bank account in seconds, not T+1
     - the server learns it happened without asking a human

   Both are satisfied by one PSP feature: INSTANT (direct) SETTLEMENT. Funds route
   customer-bank -> merchant-bank on NPCI rails instead of resting in the PSP's nodal
   account, and the PSP still sees the transaction, so it can fire a webhook. This is
   exactly what a soundbox does - it announces the credit because the PSP knows the
   instant it clears.

   Two things must be true of whichever PSP is configured:
     1. instant settlement enabled on the merchant's account
     2. a webhook on payment success carrying back OUR reference

   Nothing below is vendor-locked. `VENDORS` holds the parts that differ; everything
   else - reference round-tripping, idempotency, the booking state change - is common.

   !! Cashfree and Paytm below are written from documented shapes and MUST be checked
   !! against live docs before going live. PhonePe was read off developer.phonepe.com
   !! on 14 Aug 2026 and its literals are quoted in the comments there. */

const crypto = require('node:crypto');

// ---------------------------------------------------------------- phonepe auth

/* PhonePe v2 is the only vendor here that needs a token round-trip before it will
   talk to you, so it gets a cache. Keyed on client id, because two venues can be on
   two different PhonePe merchants and must never share a token. */
const tokens = new Map();

async function phonepeToken(c) {
  const hit = tokens.get(c.clientId);
  // 60s of slack: a token that expires between here and the pay call costs a
  // customer their booking, and the retry lands after they have wandered off.
  if (hit && hit.expiresAt * 1000 > Date.now() + 60000) return hit.token;

  /* Production auth does NOT sit under the pay host - it is identity-manager.
     Sandbox keeps everything under pg-sandbox. Getting this wrong 404s. */
  const url = c.env === 'sandbox'
    ? 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token'
    : 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token';

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_version: String(c.clientVersion || 1),
      client_secret: c.clientSecret,
      grant_type: 'client_credentials'
    }).toString()
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('phonepe auth ' + r.status + ' ' + txt.slice(0, 200));
  const j = JSON.parse(txt);
  if (!j.access_token) throw new Error('phonepe auth returned no access_token');
  tokens.set(c.clientId, { token: j.access_token, expiresAt: Number(j.expires_at) || 0 });
  return j.access_token;
}

// ---------------------------------------------------------------- vendors

const VENDORS = {
  /* PhonePe PG (Standard Checkout v2). Read off developer.phonepe.com, 14 Aug 2026.

     Chosen over Razorpay for the merchant side because UPI is 0% there and 2% here,
     and because the webhook is signed - which closes the SMS-spoofing hole that
     tier 0 (owner forwards a bank SMS) can never close.

     Note the auth shape is nothing like the old Static QR integration in notify.js:
     no saltKey, no X-VERIFY. That one still exists for merchants on a static QR;
     this is for merchants on a real PG account. Both are live at once. */
  phonepe: {
    base: c => c.env === 'sandbox'
      ? 'https://api-preprod.phonepe.com/apis/pg-sandbox'
      : 'https://api.phonepe.com/apis/pg',
    path: '/checkout/v2/pay',
    headers: async c => ({
      'content-type': 'application/json',
      Authorization: 'O-Bearer ' + await phonepeToken(c)
    }),
    createBody: (venue, b, amount) => ({
      merchantOrderId: b.ref,               // max 63 chars, [_-] the only specials
      amount: Math.round(amount * 100),     // paise, minimum 100
      expireAfter: 1200,                    // 20 min; docs allow 300-3600. Matches
                                            // notify.WINDOW_MIN so an expired order
                                            // and an unmatchable notification agree.
      metaInfo: { udf1: venue.code, udf2: b.ref },
      paymentFlow: {
        type: 'PG_CHECKOUT',
        message: 'Advance ' + b.ref,
        merchantUrls: {
          redirectUrl: process.env.PSP_REDIRECT_URL || process.env.PSP_WEBHOOK_URL
        }
      }
    }),
    readCreate: j => ({ token: j.orderId, link: j.redirectUrl }),

    /* Not a signature - PhonePe hashes credentials YOU choose in the dashboard:
       "PhonePe will use your configured credentials to create an Authorization
       header in the webhook response using the SHA256(username:password) method."
       So there is no secret to go hunting for; you set both when you add the
       webhook, and they go in venues.js as webhookUser / webhookPass. */
    verify: (raw, headers, secret, c) => {
      const got = headers && (headers.authorization || headers.Authorization);
      if (!got || !c || !c.webhookUser || !c.webhookPass) return false;
      const want = crypto.createHash('sha256')
        .update(c.webhookUser + ':' + c.webhookPass).digest('hex');
      // Docs show a bare hex digest; tolerate a scheme prefix in case that changes.
      return safeEq(String(got).replace(/^SHA256\s+/i, '').trim(), want);
    },

    readHook: j => {
      const p = (j && j.payload) || {};
      const paise = Number(p.amount);
      const det = Array.isArray(p.paymentDetails) ? p.paymentDetails : [];
      return {
        ref: p.merchantOrderId,
        amount: isFinite(paise) ? paise / 100 : NaN,
        status: p.state,
        /* PhonePe's own transaction id, NOT a bank UTR - the documented payload has
           no UTR field. If a real callback turns out to carry one, add it here and
           prefer it; until a live one is in hand, do not invent the path. */
        utr: (det[0] && det[0].transactionId) || p.orderId || null,
        // Docs, verbatim: "For payment status, rely only on the root-level
        // payload.state field." So the event name is deliberately not consulted.
        ok: p.state === 'COMPLETED'
      };
    }
  },

  /* Cashfree - 0% on UPI, instant settlement as an add-on. */
  cashfree: {
    base: 'https://api.cashfree.com/pg',
    headers: c => ({
      'x-client-id': c.appId,
      'x-client-secret': c.secretKey,
      'x-api-version': '2023-08-01',
      'content-type': 'application/json'
    }),
    // Ask for a UPI intent link + QR against one booking.
    createBody: (venue, b, amount) => ({
      order_id: b.ref,
      order_amount: Number(amount.toFixed(2)),
      order_currency: 'INR',
      customer_details: {
        customer_id: 'c' + b.customer,
        customer_phone: b.customer
      },
      order_note: 'Advance ' + b.ref,
      order_meta: { notify_url: process.env.PSP_WEBHOOK_URL }
    }),
    path: '/orders',
    readCreate: j => ({ token: j.payment_session_id, link: j.payments && j.payments.url }),
    // Cashfree signs with base64(HMAC-SHA256(timestamp + rawBody)).
    verify: (raw, headers, secret) => {
      const ts = headers['x-webhook-timestamp'];
      const sig = headers['x-webhook-signature'];
      if (!ts || !sig) return false;
      const mac = crypto.createHmac('sha256', secret).update(ts + raw).digest('base64');
      return safeEq(mac, sig);
    },
    readHook: j => ({
      ref: j.data && j.data.order && j.data.order.order_id,
      amount: j.data && j.data.order && Number(j.data.order.order_amount),
      status: j.data && j.data.payment && j.data.payment.payment_status,
      utr: j.data && j.data.payment && j.data.payment.bank_reference,
      ok: j.type === 'PAYMENT_SUCCESS_WEBHOOK'
    })
  },

  /* Paytm - real-time settlement, documented webhook callbacks. */
  paytm: {
    base: 'https://securegw.paytm.in',
    headers: () => ({ 'content-type': 'application/json' }),
    createBody: (venue, b, amount) => ({
      body: {
        mid: null,                       // filled from venue creds at call time
        orderId: b.ref,
        txnAmount: { value: String(amount.toFixed(2)), currency: 'INR' },
        userInfo: { custId: 'c' + b.customer },
        callbackUrl: process.env.PSP_WEBHOOK_URL
      }
    }),
    path: '/theia/api/v1/initiateTransaction',
    readCreate: j => ({ token: j.body && j.body.txnToken, link: null }),
    verify: (raw, headers, secret) => {
      const j = JSON.parse(raw);
      const sig = j.head && j.head.signature;
      if (!sig) return false;
      const mac = crypto.createHmac('sha256', secret).update(JSON.stringify(j.body)).digest('base64');
      return safeEq(mac, sig);
    },
    readHook: j => ({
      ref: j.body && j.body.orderId,
      amount: j.body && Number(j.body.txnAmount),
      status: j.body && j.body.resultInfo && j.body.resultInfo.resultStatus,
      utr: j.body && j.body.bankTxnId,
      ok: !!(j.body && j.body.resultInfo && j.body.resultInfo.resultStatus === 'TXN_SUCCESS')
    })
  }
};

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------- api

const vendorFor = venue => VENDORS[venue.psp && venue.psp.vendor];

// A vendor whose host depends on sandbox-vs-production declares `base` as a function.
const baseOf = (V, c) => typeof V.base === 'function' ? V.base(c) : V.base;

// Is this venue wired for automatic confirmation, or still on owner-taps?
const isAuto = venue => !!vendorFor(venue);

/* Create one collect request for a booking. Returns a payable link, or null on
   failure - the caller falls back rather than leaving the customer with nothing. */
async function collect(venue, booking, amount) {
  const V = vendorFor(venue);
  if (!V) return null;
  const c = venue.psp;
  try {
    const body = V.createBody(venue, booking, amount);
    if (c.mid && body.body) body.body.mid = c.mid;
    // `await` on a plain object is a no-op, so sync vendors are unaffected. PhonePe
    // uses it to fetch (or reuse) its OAuth token.
    const r = await fetch(baseOf(V, c) + V.path, {
      method: 'POST',
      headers: await V.headers(c),
      body: JSON.stringify(body)
    });
    const txt = await r.text();
    if (!r.ok) { console.error('PSP %d %s', r.status, txt.slice(0, 300)); return null; }
    const out = V.readCreate(JSON.parse(txt));
    return out.link || (c.checkoutBase ? c.checkoutBase + out.token : null);
  } catch (e) {
    console.error('PSP create failed', e.message);
    return null;
  }
}

/* Validate an inbound webhook and pull out what matters.
   Returns null when the signature fails or the event is not a success. */
function readWebhook(venue, raw, headers) {
  const V = vendorFor(venue);
  if (!V) return null;
  // The whole psp config goes through too: PhonePe authenticates on a user/pass
  // pair rather than a single shared secret.
  if (!V.verify(raw, headers, venue.psp.webhookSecret, venue.psp)) {
    console.warn('PSP webhook signature rejected for %s', venue.code);
    return null;
  }
  let j;
  try { j = JSON.parse(raw); } catch (e) { return null; }
  const p = V.readHook(j);
  return p && p.ok && p.ref ? p : null;
}

/* Which venue does this webhook belong to? PSP webhooks do not carry a venue id,
   so we route on the booking reference the PSP is echoing back to us. */
function venueOfWebhook(VENUES, store, raw) {
  let j;
  try { j = JSON.parse(raw); } catch (e) { return null; }
  for (const v of VENUES) {
    const V = vendorFor(v);
    if (!V) continue;
    const p = V.readHook(j);
    if (!p || !p.ref) continue;
    const b = store.byRef(p.ref);
    if (b && b.venue === v.code) return v;
  }
  return null;
}

module.exports = { isAuto, collect, readWebhook, venueOfWebhook, VENDORS };
