/* बारी / Baari - pilot server.

   The bot runs on EACH VENUE'S OWN WhatsApp number. Their signboard, their
   Google listing, their customers' existing thread. Inbound webhooks carry
   metadata.phone_number_id, which is how we know whose number was messaged.

   Customer books in Hindi -> owner approves with a button -> UPI advance to the
   venue's OWN vpa -> owner confirms the money landed.
   No SIM of ours, no PSP, no entity needed. */

require('node:http');
const http = require('node:http');
const NLU = require('./nlu.js');
const store = require('./store');
const S = require('./scheduler');
const wa = require('./wa');
const receipt = require('./receipt');
const notify = require('./notify');
const sarvam = require('./sarvam');
const relay = require('./relay');
const VENUES = require('./venues');

const byCode = c => VENUES.find(v => v.code.toUpperCase() === String(c).toUpperCase());
const byPhoneId = id => VENUES.find(v => v.waPhoneId === id);
const svcOf = (v, id) => v.services.find(s => s.id === id);
const groundName = (v, id) => (v.grounds.find(g => g.id === id) || {}).hi || id;

const HI_DAYS = NLU.HI_DAYS;
const dHi = d => `${HI_DAYS[d.getDay()]}, ${d.getDate()} ${NLU.HI_MONTHS[d.getMonth()]}`;
const tHi = (h, m) => {
  const per = h < 12 ? 'सुबह' : h < 16 ? 'दोपहर' : h < 20 ? 'शाम' : 'रात';
  return `${per} ${h % 12 === 0 ? 12 : h % 12}:${S.pad2(m)}`;
};
const tOf = b => { const [h, m] = b.time.split(':').map(Number); return tHi(h, m); };
const dOf = b => dHi(new Date(b.date + 'T00:00:00'));

// The parser is written against a catalogue shape; hand it this venue's services.
function nluOpts(v) {
  const cat = NLU.CATALOGUE.turf;
  cat.services = v.services.map(s => Object.assign({}, cat.services.find(x => x.id === s.id) || {}, s, { en: s.id }));
  cat.open = v.open; cat.close = v.close;
  return { vertical: 'turf', now: new Date() };
}

// ---------------- customer side ----------------
async function handleCustomer(venue, from, text, profile) {
  const sess = store.getSession(from) || {};
  const t = NLU.normalize(text);
  const draft = (sess.venue === venue.code ? sess.draft : {}) || {};

  if (/डेटा हटा|डेटा मिटा|मिटा दीजिए|delete my data/.test(t)) {
    const n = store.eraseCustomer(from);
    return wa.sendText(venue, from, `हो गया। आपका नाम, नंबर और ${n} बुकिंग हटा दी गई।`);
  }

  const p = NLU.parse(text, nluOpts(venue));
  if (p.slots.service) draft.service = p.slots.service.id;
  if (p.slots.date) draft.date = S.ymd(p.slots.date);
  if (p.slots.time) draft.time = p.slots.time;
  if (p.slots.recurring) {
    draft.recurring = true;
    if (p.slots.recurringDay != null) {
      let d0 = S.today(), g = 0;
      while (d0.getDay() !== p.slots.recurringDay && g++ < 8) d0 = S.addDays(d0, 1);
      draft.date = S.ymd(d0);
    }
  }

  if (p.intent === 'price') {
    const list = venue.services.map(s => `• ${s.hi} — ₹${s.price}/घंटा`).join('\n');
    store.setSession(from, venue.code, draft);
    return wa.sendText(venue, from, `${venue.name}\n${list}\n\nशाम 5 बजे के बाद पीक रेट लगता है।`);
  }
  if (p.intent === 'hours') {
    store.setSession(from, venue.code, draft);
    return wa.sendText(venue, from, `हम रोज़ सुबह ${venue.open} से रात ${venue.close - 12} बजे तक खुले हैं।`);
  }
  if (p.intent === 'cancel') {
    const b = store.lastFor(from);
    if (!b) return wa.sendText(venue, from, 'कोई चालू बुकिंग नहीं दिख रही।');
    store.setStatus(b.ref, 'cancelled');
    await notifyOwner(venue, `❌ ${b.name || 'ग्राहक'} ने ${dOf(b)} ${tOf(b)} की बुकिंग रद्द कर दी।`);
    return wa.sendText(venue, from, 'बुकिंग रद्द कर दी गई।');
  }

  // confirm -> hold the slot(s) and ask the owner
  if (p.intent === 'confirm' && draft.pending) {
    const svc = svcOf(venue, draft.pending.service);
    const [h, m] = draft.pending.time.split(':').map(Number);
    const weeks = draft.pending.recurring ? 4 : 1;
    const made = [];
    for (let w = 0; w < weeks; w++) {
      const d = S.addDays(new Date(draft.pending.date + 'T00:00:00'), w * 7);
      const b = S.book(venue, { customer: from, name: profile || draft.name, svc, date: d, h, m, status: 'pending' });
      if (b) made.push(b);
    }
    delete draft.pending;
    store.setSession(from, venue.code, draft);
    if (!made.length) return wa.sendText(venue, from, 'माफ़ कीजिए, वह स्लॉट अभी भर गया।');
    const total = made.reduce((x, b) => x + b.deposit, 0);
    await wa.sendText(venue, from,
      `एक मिनट, मालिक से पूछ कर बताता हूँ 🙏\n` +
      made.map(b => `• ${dOf(b)} ${tOf(b)} · ${groundName(venue, b.ground)}`).join('\n') +
      `\nअग्रिम ₹${total}`);
    return askOwner(venue, made);
  }

  /* The parser got nothing from a substantive message - the conversational,
     messy, or long ones. Hand it to Sarvam as an INTERPRETER: it may answer
     from the venue card, or extract slots that feed this same flow. It cannot
     book, price, or promise anything - the deterministic path below stays the
     only way a booking happens. Short greetings skip it: the menu is better. */
  /* "Nothing" = no slots. The intent alone is not progress: "बुकिंग का क्या
     होगा" keyword-matches intent 'book' with zero slots, and that is exactly
     the conversational case the model is for. greet/price/hours/cancel/confirm
     were already served above. */
  const gotNothing = ['unknown', 'book', 'deny'].includes(p.intent) &&
    !p.slots.service && !p.slots.date && !p.slots.time && !p.slots.recurring;
  if (gotNothing && sarvam.enabled(venue) && t.split(/\s+/).length >= 3) {
    const ai = await sarvam.customer(venue, text, draft, new Date());
    if (ai && ai.slots) {
      const s = ai.slots;
      if (s.service && svcOf(venue, s.service)) draft.service = s.service;
      if (typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) &&
          s.date >= S.ymd(S.today())) draft.date = s.date;
      const tm = typeof s.time === 'string' && /^(\d{1,2}):(\d{2})$/.exec(s.time);
      if (tm && +tm[1] >= 0 && +tm[1] < 24) draft.time = { h: +tm[1], min: +tm[2] >= 30 ? 30 : 0 };
      if (s.recurring) draft.recurring = true;
      // fall through: the normal flow below prompts for whatever is still missing
    } else if (ai && ai.reply) {
      store.setSession(from, venue.code, draft);
      return wa.sendText(venue, from, ai.reply);
    }
    // ai === null: Sarvam unavailable or unreadable - the menu below still works
  }

  // booking flow
  if (!draft.service) {
    store.setSession(from, venue.code, draft);
    return wa.sendText(venue, from, `${venue.name} में आपका स्वागत है 🙏\nक्या खेलना है?\n` +
      venue.services.map(s => `• ${s.hi}`).join('\n'));
  }
  const svc = svcOf(venue, draft.service);
  if (!draft.date) {
    store.setSession(from, venue.code, draft);
    return wa.sendText(venue, from, 'किस दिन? "आज", "कल", "शनिवार" — जैसे भी कहना हो।');
  }
  const date = new Date(draft.date + 'T00:00:00');
  if (!draft.time) {
    const free = S.freeSlots(venue, date, svc, 4);
    store.setSession(from, venue.code, draft);
    if (!free.length) return wa.sendText(venue, from, `${dHi(date)} को कुछ खाली नहीं है। दूसरा दिन बता दीजिए।`);
    return wa.sendText(venue, from, `${dHi(date)} को ये खाली हैं:\n` +
      free.map(f => `• ${tHi(f.h, f.m)}`).join('\n') + '\nकौन सा रखूँ?');
  }
  const { h, min } = draft.time;
  if (!S.isFree(venue, date, h, min, svc)) {
    const alt = S.freeSlots(venue, date, svc, 3, h * 60 + min);
    draft.time = null; store.setSession(from, venue.code, draft);
    return wa.sendText(venue, from, `${tHi(h, min)} भर चुका है।` +
      (alt.length ? `\nपास में: ${alt.map(a => tHi(a.h, a.m)).join(', ')}` : ''));
  }
  const price = S.priceAt(venue, svc, h), dep = S.depositFor(venue, svc, h);
  draft.pending = { service: svc.id, date: S.ymd(date), time: S.hhmm(h, min), recurring: !!draft.recurring };
  store.setSession(from, venue.code, draft);
  return wa.sendButtons(venue, from,
    `${svc.hi} · ${draft.recurring ? 'हर हफ्ते ' : ''}${dHi(date)} · ${tHi(h, min)}\n` +
    `₹${price}${S.isPeak(venue, h) ? ' (पीक)' : ''} · अग्रिम ₹${dep}` +
    (draft.recurring ? ' × 4 हफ्ते' : ''),
    [{ id: 'ok', title: '✓ पक्का कर दो' }, { id: 'no', title: '✗ नहीं' }]);
}

// ---------------- owner side ----------------
async function askOwner(venue, made) {
  const b = made[0];
  const body = (made.length > 1 ? `पक्का स्लॉट (${made.length} हफ्ते) 🔔\n` : 'नई बुकिंग 🔔\n') +
    `${b.name || 'ग्राहक'}\n${svcOf(venue, b.service).hi} · ${dOf(b)} · ${tOf(b)}\n` +
    `${groundName(venue, b.ground)} · अग्रिम ₹${b.deposit}${made.length > 1 ? ` × ${made.length}` : ''}`;
  return wa.sendButtons(venue, venue.ownerPhone, body, [
    { id: 'ok:' + b.ref, title: '✓ पक्का' },
    { id: 'no:' + b.ref, title: '✗ नहीं' },
    { id: 'day:' + b.ref, title: '📋 दिन देखें' }
  ]);
}
const notifyOwner = (v, text) => wa.sendText(v, v.ownerPhone, text);

async function handleOwner(venue, from, text, buttonId) {
  if (buttonId) {
    const [act, ref] = buttonId.split(':');
    const b = store.byRef(ref);
    if (!b) return wa.sendText(venue, from, 'वह बुकिंग नहीं मिली।');

    if (act === 'ok') {
      // approve this and any sibling weeks of a standing slot
      const sibs = store.pending(venue.code).filter(x => x.customer === b.customer && x.time === b.time);
      const all = sibs.length ? sibs : [b];
      all.forEach(x => store.setStatus(x.ref, 'hold'));
      const total = all.reduce((t, x) => t + x.deposit, 0);

      const link = S.upiLink(venue, Object.assign({}, b, { deposit: total }));

      await wa.sendText(venue, from, 'पक्का ✅ ग्राहक को भुगतान का लिंक भेज दिया।');
      await wa.sendText(venue, b.customer,
        `मालिक ने हाँ कर दी ✅\nस्लॉट पक्का करने के लिए ₹${total} अग्रिम भेजिए:\n${link}\n\n` +
        `बुकिंग नं. ${b.ref}\nपैसे भेजने के बाद "भेज दिया" लिख दीजिए।`);
      return;
    }
    if (act === 'no') {
      const sibs = store.pending(venue.code).filter(x => x.customer === b.customer && x.time === b.time);
      (sibs.length ? sibs : [b]).forEach(x => store.setStatus(x.ref, 'cancelled'));
      const d = new Date(b.date + 'T00:00:00');
      const alt = S.freeSlots(venue, d, svcOf(venue, b.service), 3);
      await wa.sendText(venue, from, 'मना कर दिया।');
      return wa.sendText(venue, b.customer, 'माफ़ कीजिए, वह समय नहीं हो पाएगा।' +
        (alt.length ? `\nये खाली हैं: ${alt.map(a => tHi(a.h, a.m)).join(', ')}` : ''));
    }
    if (act === 'day') return sendDay(venue, from, new Date(b.date + 'T00:00:00'));
    if (act === 'paid') return settle(venue, b);
    if (act === 'unpaid') return wa.sendText(venue, from, 'ठीक है, होल्ड पर रखा है।');
  }

  /* The relay, checked first because its trigger is explicit ("X को बोल दो ...")
     and nothing else the owner types looks like it. On a second number the owner
     is not in the customer's thread at all, so without this they can only say
     what the bot already knows how to say. */
  const rel = relay.parse(text || '');
  if (rel) {
    const who = relay.resolve(venue.code, store, rel.name);

    if (who.none)
      return wa.sendText(venue, from,
        `"${rel.name}" नाम का कोई ग्राहक नहीं मिला। नंबर या बुकिंग नंबर लिख कर देखिए।`);

    if (who.ambiguous)
      return wa.sendText(venue, from,
        `"${rel.name}" नाम के ${who.ambiguous.length} ग्राहक हैं:\n` +
        who.ambiguous.slice(0, 5).map(c => `• ${c.name} — ${c.customer}`).join('\n') +
        '\n\nनंबर या बुकिंग नंबर लिख कर भेजिए।');

    /* Meta's 24-hour service window. Said plainly rather than swallowed: an owner
       who thinks a message went out and it did not is worse off than one who
       knows it did not. */
    if (!relay.inWindow(who.contact))
      return wa.sendText(venue, from,
        `${who.name} ने 24 घंटे से कोई मैसेज नहीं किया। WhatsApp के नियम से अभी ` +
        'सीधा मैसेज नहीं जा सकता। उनके मैसेज करते ही भेज देंगे।');

    await wa.sendText(venue, who.customer, rel.message);
    const left = Math.floor(relay.hoursLeft(who.contact));
    return wa.sendText(venue, from,
      `भेज दिया ✅ ${who.name}` + (left <= 2 ? `\n(${left} घंटे बाद सीधा मैसेज नहीं जा पाएगा)` : ''));
  }

  /* Tier-0 delivery: the owner FORWARDS the bank/app payment message to the bot.
     No app to install, no provider agreement - the forward lands here as plain
     text on the venue's own number, and the same parser that reads the listener
     app's payloads reads it. Better than the old "did money come?" tap, because
     the amount and reference are verified rather than taken on trust. */
  const fwd = notify.parse(text || '');
  if (fwd.direction === 'credit' && fwd.amount) {
    const m = notify.match(venue, store, fwd);
    if (m.ok) {
      store.siblings(venue.code, m.booking).forEach(x => store.setStatus(x.ref, 'paid'));
      await settle(venue, m.booking, fwd.utr);
      return;
    }
    return wa.sendText(venue, from,
      `₹${fwd.amount} का मैसेज मिला, पर ${m.reason === 'nothing awaiting payment'
        ? 'कोई बुकिंग बाकी नहीं है।'
        : 'किसी बुकिंग से मेल नहीं खाया।'} अभी कुछ पक्का नहीं किया।`);
  }

  const t = NLU.normalize(text || '');
  if (/आज|today/.test(t)) return sendDay(venue, from, S.today());
  if (/कल|tomorrow/.test(t)) return sendDay(venue, from, S.addDays(S.today(), 1));
  if (/बुकिंग|list|दिन/.test(t)) return sendDay(venue, from, S.today());

  /* The merchant feature: anything else substantive is a question about their
     own business - "इस हफ्ते कितनी कमाई हुई?", "अगला खाली स्लॉट कब है?".
     Sarvam answers from a summary WE build, so it can only talk about what is
     true, and it can change nothing - approvals stay buttons. */
  // fwd.direction !== 'unknown' means this was a forwarded payment message
  // (a debit, or a credit that matched nothing) - not a question for the model.
  if (fwd.direction === 'unknown' && sarvam.enabled(venue) &&
      (text || '').trim().split(/\s+/).length >= 3) {
    const said = await sarvam.owner(venue, text, bizSummary(venue));
    if (said) return wa.sendText(venue, from, said);
  }
  return wa.sendText(venue, from, 'लिखिए: "आज" या "कल" — उस दिन की बुकिंग भेज देता हूँ।');
}

/* Everything the owner-side model may know: the last and next 7 days, from the
   store, as plain text. Revenue counts only advances actually received. */
function bizSummary(venue) {
  const lines = [];
  let pastN = 0, pastMoney = 0, nextN = 0, nextMoney = 0;
  for (let i = -7; i <= 7; i++) {
    const d = S.addDays(S.today(), i);
    const rows = store.dayBookings(venue.code, S.ymd(d));
    if (!rows.length) continue;
    const paid = rows.filter(r => r.status === 'paid' || r.status === 'done');
    if (i < 0) { pastN += rows.length; pastMoney += paid.reduce((x, r) => x + r.deposit, 0); }
    if (i > 0) { nextN += rows.length; nextMoney += paid.reduce((x, r) => x + r.deposit, 0); }
    if (i >= 0 && i <= 2) {
      lines.push(`${i === 0 ? 'आज' : i === 1 ? 'कल' : 'परसों'} (${dHi(d)}): ` + rows.map(r =>
        `${r.time} ${r.name || 'ग्राहक'} ${svcOf(venue, r.service).hi} [${
          { pending: 'मंज़ूरी बाकी', hold: 'अग्रिम बाकी', paid: 'पक्का', done: 'हो गया' }[r.status] || r.status}]`
      ).join(', '));
    }
  }
  lines.push(`पिछले 7 दिन: ${pastN} बुकिंग, ₹${pastMoney} अग्रिम आया`);
  lines.push(`अगले 7 दिन: ${nextN} बुकिंग, जिनमें ₹${nextMoney} अग्रिम आ चुका`);
  return lines.join('\n');
}

function sendDay(venue, to, date) {
  const rows = store.dayBookings(venue.code, S.ymd(date));
  if (!rows.length) return wa.sendText(venue, to, `${dHi(date)}: कोई बुकिंग नहीं।`);
  const money = rows.filter(r => r.status === 'paid').reduce((t, r) => t + r.deposit, 0);
  const body = `${dHi(date)} — ${rows.length} बुकिंग\n\n` +
    rows.map(r => `${r.time} · ${r.name || 'ग्राहक'} · ${svcOf(venue, r.service).hi}\n   ${groundName(venue, r.ground)} · ${
      { pending: 'मंज़ूरी बाकी', hold: 'अग्रिम बाकी', paid: 'पक्का ✅', done: 'हो गया', noshow: 'नो-शो' }[r.status] || r.status}`).join('\n') +
    `\n\nअग्रिम मिला: ₹${money}`;
  return wa.sendText(venue, to, body);
}

/* The money landed. Single place the booking becomes पक्का, whether a PSP webhook
   said so or the owner tapped. Idempotent: a PSP that retries its webhook, or an
   owner who taps twice, must not send the customer two confirmations. */
async function settle(venue, b, utr) {
  if (b.status === 'paid' || b.status === 'done') return;
  store.setStatus(b.ref, 'paid');
  if (utr) store.setUtr(b.ref, utr);
  await wa.sendText(venue, venue.ownerPhone,
    `💰 ₹${b.deposit} आ गया — ${b.name || 'ग्राहक'} की बुकिंग पक्की।\n` +
    `${dOf(b)} ${tOf(b)} · ${groundName(venue, b.ground)}`);
  return wa.sendText(venue, b.customer,
    `भुगतान मिल गया ✅\nबुकिंग पक्की: ${dOf(b)} ${tOf(b)} · ${groundName(venue, b.ground)}`);
}

/* Customer sent a payment screenshot.

   A screenshot NEVER settles a booking, however well it parses. It is the payer's
   own claim about the payer's own payment, and fake-receipt apps are a real fraud
   in India. The merchant verifies against their own phone today, and that signal -
   arriving from the merchant's device, unforgeable by a customer - is the one
   allowed to move money in this system. See notify.js.

   Parsing it is still worth doing: it turns the owner's question from "did money
   come?" into "₹500 to your VPA, UTR 4123..., yes or no?" */
async function handleReceipt(venue, from, mediaId) {
  const { booking: b, due, parsed, verdict } = await receipt.read(venue, store, from, mediaId);
  if (!b) return wa.sendText(venue, from, 'कोई भुगतान बाकी नहीं दिख रहा।');

  console.log('receipt for %s (context only): %s', b.ref, verdict.reasons.join(', '));
  await wa.sendText(venue, from, 'रसीद मिल गई 🙏 मालिक एक बार देख लेंगे।');
  const seen = parsed
    ? `पर्ची पर: ₹${parsed.amount ?? '?'}${parsed.payeeVpa ? ' → ' + parsed.payeeVpa : ''}` +
      `${parsed.utr ? '\nUTR ' + parsed.utr : ''}`
    : 'पर्ची पढ़ी नहीं जा सकी।';
  return wa.sendButtons(venue, venue.ownerPhone,
    `💰 ₹${due} की रसीद आई\n${b.name || 'ग्राहक'} · ${dOf(b)} ${tOf(b)}\n${seen}`,
    [{ id: 'paid:' + b.ref, title: '✓ सही है' }, { id: 'unpaid:' + b.ref, title: '✗ नहीं' }]);
}

// customer says they have paid -> ask the owner to eyeball their UPI app
async function customerClaimsPaid(venue, from) {
  const b = store.lastFor(from);
  if (!b || b.status !== 'hold') return wa.sendText(venue, from, 'कोई भुगतान बाकी नहीं दिख रहा।');
  await wa.sendText(venue, from, 'शुक्रिया 🙏 मालिक से पुष्टि करा रहे हैं।');
  return wa.sendButtons(venue, venue.ownerPhone,
    `💰 ₹${b.deposit} आया क्या?\n${b.name || 'ग्राहक'} · ${dOf(b)} ${tOf(b)}\nअपने UPI ऐप में देख लीजिए।`,
    [{ id: 'paid:' + b.ref, title: '✓ हाँ, आ गया' }, { id: 'unpaid:' + b.ref, title: '✗ नहीं आया' }]);
}

// ---------------- http ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/webhook') {
    const ok = url.searchParams.get('hub.verify_token') === process.env.WA_VERIFY_TOKEN;
    res.writeHead(ok ? 200 : 403).end(ok ? url.searchParams.get('hub.challenge') : 'no');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ ok: true, venues: VENUES.map(v => v.code) }));
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/webhook') { res.writeHead(404).end(); return; }

  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', async () => {
    res.writeHead(200).end();                    // ack fast; Meta retries on delay
    let msg;
    try { msg = wa.parseWebhook(JSON.parse(raw)); } catch (e) { return; }
    if (!msg) return;
    try {
      // Meta tells us which of our venues' numbers was messaged.
      const venue = byPhoneId(msg.phoneId);
      if (!venue) return console.warn('message for unknown phone_number_id', msg.phoneId);
      await wa.markRead(venue, msg.id);

      // the owner messaging their own bot
      if (msg.from === venue.ownerPhone) return handleOwner(venue, msg.from, msg.text, msg.buttonId);

      /* Every customer inbound, of every kind, opens a fresh 24-hour service
         window - so this is recorded before any branch below can return early.
         The relay reads it to know whether the owner may still write to them. */
      store.touch(venue.code, msg.from, msg.profile);

      if (msg.kind === 'audio') {
        return wa.sendText(venue, msg.from, 'आवाज़ संदेश अभी नहीं सुन पाता 🙏 लिख कर बता दीजिए।');
      }
      if (msg.kind === 'image') return handleReceipt(venue, msg.from, msg.mediaId);
      if (msg.buttonId === 'no') return wa.sendText(venue, msg.from, 'ठीक है। दूसरा समय बता दीजिए।');
      if (/भेज दिया|bhej diya|paid|कर दिया/.test(NLU.normalize(msg.text || ''))) {
        return customerClaimsPaid(venue, msg.from);
      }
      await handleCustomer(venue, msg.from, msg.text || '', msg.profile);
    } catch (e) {
      console.error('handler error', e);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`बारी listening on :${PORT}`);
  VENUES.forEach(v => console.log(`  ${v.code}  number ${v.waPhoneId}  owner ${v.ownerPhone}`));
});
