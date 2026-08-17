/* Sarvam - the Hindi LLM, used as a FALLBACK interpreter, never an authority.

   The regex NLU stays first: it is free, instant, and deterministic, and it
   handles the common booking messages. Sarvam is called only when the parser
   extracted nothing from a message - the long, conversational, or messy ones.

   Hard rules, enforced by the shape of the integration rather than by prompt
   hope alone:
     - it can RETURN SLOTS, which feed the same draft -> scheduler -> owner
       approval path as parsed text. It cannot create a booking.
     - it can ANSWER from the venue card we hand it. Prices, hours and deposits
       in that card come from venues.js, so it has nothing else to quote.
     - it never sees or touches payment state.

   Cost: about Rs 0.02 a turn at Sarvam's published rates, and only on the
   messages the parser could not read.

   !! Endpoint, header and model names below are from Sarvam's documented API
   !! (chat/completions, `api-subscription-key`). Verify against live docs when
   !! the key is first set - same drill as any vendor API. */

const URL = process.env.SARVAM_URL || 'https://api.sarvam.ai/v1/chat/completions';
const MODEL = process.env.SARVAM_MODEL || 'sarvam-105b';

const enabled = venue => !!process.env.SARVAM_KEY && venue.ai !== false;

async function chat(messages, maxTokens) {
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.2,
        /* sarvam-105b is a REASONING model (verified live 13 Aug 2026): it
           thinks ~600 tokens in reasoning_content before one word lands in
           content. A small budget dies mid-thought with content:null, so the
           budget must cover thinking + answer, and effort stays low. */
        reasoning_effort: 'low',
        max_tokens: Math.max(maxTokens || 0, 2000)
      })
    });
    const txt = await r.text();
    if (!r.ok) { console.error('sarvam %d %s', r.status, txt.slice(0, 300)); return null; }
    const j = JSON.parse(txt);
    // content only - reasoning_content is chain-of-thought, never the reply
    return (j.choices && j.choices[0] && j.choices[0].message &&
            j.choices[0].message.content) || null;
  } catch (e) {
    console.error('sarvam call failed', e.message);
    return null;
  }
}

// Models wrap JSON in prose or fences no matter how firmly asked not to.
function parseJson(s) {
  if (!s) return null;
  const m = /\{[\s\S]*\}/.exec(s);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// Everything the model is allowed to know about a venue, and nothing else.
function venueCard(venue) {
  return [
    `नाम: ${venue.name} (${venue.nameEn})`,
    `समय: रोज़ सुबह ${venue.open} बजे से रात ${venue.close - 12} बजे तक` +
      (venue.off >= 0 ? '' : ', कोई साप्ताहिक छुट्टी नहीं'),
    `खेल और दाम प्रति घंटा: ` + venue.services.map(s => `${s.hi} ₹${s.price}`).join(', '),
    `शाम ${venue.peakFrom - 12} बजे के बाद पीक रेट (${venue.peakMult}x)`,
    `बुकिंग पक्की करने के लिए अग्रिम (एडवांस) देना होता है, ₹${venue.depositMin || 200}-₹${venue.depositMax || 500}`,
    `अग्रिम venue के अपने UPI पर जाता है। बुकिंग मालिक की मंज़ूरी से ही पक्की होती है।`
  ].join('\n');
}

/* Customer message the parser could not read. Returns
     { reply }                    - send this text, or
     { slots: {service,date,time,recurring} } - feed the booking flow, or
     null                         - LLM unavailable/unreadable: caller falls back. */
async function customer(venue, text, draft, now) {
  const services = venue.services.map(s => `${s.id} = ${s.hi}`).join(', ');
  const sys = `तुम "${venue.name}" के व्हाट्सऐप बुकिंग असिस्टेंट हो। ग्राहक हिंदी/Hinglish में लिखते हैं।

venue की जानकारी (सिर्फ इसी से जवाब दो, कुछ भी मत गढ़ो):
${venueCard(venue)}

आज की तारीख: ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}

सिर्फ JSON लौटाओ, और कुछ नहीं:
{"reply": "<अगर ग्राहक सवाल पूछ रहा है: 1-2 वाक्य का जवाब, हिंदी में। slot निकले तो null>",
 "slots": {"service": "<${services} में से एक id, या null>",
           "date": "<YYYY-MM-DD या null>",
           "time": "<HH:MM 24h या null>",
           "recurring": <true अगर हर हफ्ते की बात हो, वरना false>} या null}

नियम: बुकिंग तुम पक्की नहीं कर सकते - slots निकालो, आगे सिस्टम संभालेगा। दाम/समय venue की जानकारी से ही। जो नहीं पता, उसके लिए reply में लिखो कि मालिक से पूछ कर बताएँगे। पैसे/रिफंड के वादे मत करो।`;

  const said = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: text }
  ]);
  const j = parseJson(said);
  if (!j) return null;
  const out = {};
  if (j.slots && (j.slots.service || j.slots.date || j.slots.time)) out.slots = j.slots;
  if (j.reply && typeof j.reply === 'string') out.reply = j.reply.slice(0, 600);
  return (out.slots || out.reply) ? out : null;
}

/* The merchant feature: the owner asks about their own business in Hindi.
   Read-only by construction - the model is handed a text summary and can do
   nothing but talk about it. Approvals and confirmations stay buttons. */
async function owner(venue, text, summary) {
  const sys = `तुम "${venue.name}" के मालिक के बिज़नेस असिस्टेंट हो। मालिक हिंदी/Hinglish में अपने धंधे के बारे में पूछते हैं। नीचे उनकी बुकिंग का ब्योरा है - सिर्फ इसी से जवाब दो, अंदाज़ा मत लगाओ। 2-4 वाक्य, सीधा जवाब, हिंदी में। यह सिर्फ जानकारी है - बुकिंग बदलना/मंज़ूर करना बटन से होता है, वह तुम नहीं कर सकते।

${summary}`;
  const said = await chat([
    { role: 'system', content: sys },
    { role: 'user', content: text }
  ], 400);
  return said ? String(said).slice(0, 900) : null;
}

module.exports = { enabled, customer, owner, chat, parseJson, venueCard };
