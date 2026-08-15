/* WhatsApp Cloud API. Every call is made AS a venue, using that venue's own
   number and token, because the bot lives on their number rather than ours.
   Three calls cover a pilot: text, reply buttons (max 3, titles <=20 chars),
   and marking read. */
const API = 'https://graph.facebook.com/v21.0';

async function call(venue, path, body) {
  const r = await fetch(`${API}/${venue.waPhoneId}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${venue.waToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) console.error('WA %d %s', r.status, txt.slice(0, 400));
  else if (process.env.DEBUG) console.log('WA ok', txt.slice(0, 200));
  return r.ok;
}

const sendText = (venue, to, body) =>
  call(venue, 'messages', { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } });

// buttons: [{id, title}] - WhatsApp allows 3, and truncates titles past 20 chars
const sendButtons = (venue, to, body, buttons) =>
  call(venue, 'messages', {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) }
    }
  });

const markRead = (venue, id) =>
  call(venue, 'messages', { messaging_product: 'whatsapp', status: 'read', message_id: id });

// Pull the interesting bits out of the webhook envelope.
function parseWebhook(body) {
  const v = body?.entry?.[0]?.changes?.[0]?.value;
  const m = v?.messages?.[0];
  if (!m) return null;
  // which of our venues' numbers received this
  const phoneId = v?.metadata?.phone_number_id;
  const from = m.from;
  const profile = v.contacts?.[0]?.profile?.name || null;
  if (m.type === 'text') return { phoneId, from, profile, id: m.id, kind: 'text', text: m.text.body };
  if (m.type === 'interactive' && m.interactive?.button_reply)
    return { phoneId, from, profile, id: m.id, kind: 'button', text: m.interactive.button_reply.title, buttonId: m.interactive.button_reply.id };
  if (m.type === 'audio') return { phoneId, from, profile, id: m.id, kind: 'audio', mediaId: m.audio.id };
  // The payment screenshot. Customers already send these unprompted - it is the
  // habit that exists, so reading it costs the merchant nothing.
  if (m.type === 'image') return { phoneId, from, profile, id: m.id, kind: 'image',
    mediaId: m.image.id, text: m.image.caption || '' };
  return { phoneId, from, profile, id: m.id, kind: m.type, text: '' };
}

/* Media comes in two steps: ask Graph for a short-lived URL, then fetch the bytes
   with the same bearer token. Returns base64, or null if either leg fails. */
async function fetchMedia(venue, mediaId) {
  try {
    const auth = { Authorization: `Bearer ${venue.waToken}` };
    const meta = await fetch(`${API}/${mediaId}`, { headers: auth });
    if (!meta.ok) { console.error('media meta %d', meta.status); return null; }
    const j = JSON.parse(await meta.text());
    const bin = await fetch(j.url, { headers: auth });
    if (!bin.ok) { console.error('media fetch %d', bin.status); return null; }
    const buf = Buffer.from(await bin.arrayBuffer());
    return { base64: buf.toString('base64'), mime: j.mime_type || 'image/jpeg', bytes: buf.length };
  } catch (e) {
    console.error('media download failed', e.message);
    return null;
  }
}

module.exports = { sendText, sendButtons, markRead, parseWebhook, fetchMedia };
