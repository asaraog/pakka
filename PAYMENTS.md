# Getting paid without watching for it

Money always goes straight to your UPI id. The only question is how the bot
learns it arrived. Start on tier 0 - it works today with nothing to set up.

Every venue lands on one of three tiers. All of them feed `POST /notify`, all of
them settle a booking with no human. The tier is a `notify` block in `venues.js`.

**Tier 0 — WhatsApp forward (default, works today).** The owner forwards the
payment SMS to their own bot. Nothing to configure beyond the venue itself.

**Tier 1 — MacroDroid forwarder (zero-human, no app of ours).** Every provider
surfaces on the merchant's phone as either an app notification or a bank SMS;
MacroDroid ships both to us raw and the server does all parsing. Two macros,
set up once at onboarding (~10 min):

1. *Payments (apps)* — Trigger: **Notification Received**, select their Business
   apps (PhonePe Business / Paytm for Business / GPay / bank app). Constraint:
   text contains any of `received / credited / ₹ / Rs` (so nothing else ever
   leaves the phone). Action: **HTTP Request** POST
   `https://<your-server>/notify?t=<venue-token>` body
   `{"title":"{not_title}","text":"{not_text}"}` (JSON).
2. *Payments (SMS)* — Trigger: **SMS Received**, sender contains their bank id
   (SBIINB, HDFCBK, ...). Same action, body `{"text":"{sms_message}"}`.

Then: battery optimisation OFF for MacroDroid (it walks you through it), send a
₹1 test payment, watch the booking settle. One payment often fires BOTH macros -
the second POST finds nothing on hold and is ignored, by design. Phone off past
the match window = that payment falls back to the owner's tap.

**Tier 2 — provider callback (the goal).** The merchant's QR provider calls us.
To onboard a PhonePe venue:

1. Merchant (or you, on a call with them) contacts PhonePe Business support and
   asks for **Integrated Static QR with the S2S Callback**. What you need from
   that conversation: `merchantId`, `saltKey`, `saltIndex`.
2. Give PhonePe the callback URL:
   `https://<your-server>/notify?t=<venue-token>&source=phonepe`
3. In `venues.js`:
   ```js
   notify: { token: 'long-random-string', source: 'phonepe',
             saltKey: '...', saltIndex: 1 }
   ```
4. First real payment: check the log line says the X-VERIFY matched, then watch
   the booking settle itself.

Open question to resolve with PhonePe on the first real merchant: whether a
small PhonePe Business account gets callback registration self-serve, or needs
their sales channel. Until it lands, that venue simply runs tier 0 - both paths
are live at once, so nothing blocks the pilot on a sales conversation.

Paytm venues: configure the webhook in the Paytm for Business dashboard to the
same URL with `source=paytm`. Banks and anything else: `source=generic` plus a
`map` block written against one real callback (see notify.js).

### PhonePe PG (Standard Checkout v2) — the better version of tier 2

A merchant with a real PhonePe PG account, rather than just a static QR, gets a
signed webhook and a hosted checkout. Prefer it: UPI is 0% (Razorpay is 2%), and
a signed callback cannot be forged by getting a fake SMS onto the owner's phone,
which tier 0 can never defend against.

This is `psp.js`, not `notify.js` — a different product from the Static QR
integration and a completely different auth scheme. No saltKey, no X-VERIFY.

```js
psp: {
  vendor: 'phonepe',
  clientId: '...', clientSecret: '...', clientVersion: 1,
  env: 'sandbox',            // omit or 'production' when live
  webhookUser: '...',        // BOTH of these you invent yourself and type
  webhookPass: '...'         // into the PhonePe dashboard. Nothing to look up.
}
```

Then in the PhonePe dashboard, add a webhook pointing at
`https://<this server>/psp-webhook` with that same username and password, and
subscribe to the order-completed event. PhonePe authenticates itself to us with
`Authorization: SHA256(username:password)`.

Watch for two things on the first live payment:

1. Production auth lives on a different host to production pay
   (`identity-manager` vs `pg`). Sandbox keeps both under `pg-sandbox`.
2. The documented callback carries PhonePe's own `transactionId` but **no bank
   UTR**. We store the transactionId. If a real callback turns out to include a
   UTR, add it in `readHook` and prefer it — do not guess the field path.

`node test-psp.js` covers the auth header, the paise conversion, the
state-over-event rule and the token cache without touching the network.
