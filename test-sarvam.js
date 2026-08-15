/* Sarvam as fallback interpreter and merchant assistant. Stubs the Sarvam API,
   so this runs offline with no key spend.

   What is being proved:
     - the parser stays first: messages it reads NEVER reach the model
     - model slots feed the same deterministic flow (buttons, approval, pricing)
     - model replies answer questions without touching state
     - the owner's business Q&A is grounded in a summary we build, read-only
     - every failure (garbage, outage, ai:false) degrades to the old behaviour */

process.env.WA_VERIFY_TOKEN = 'verify';
process.env.DB_PATH = ':memory:';
process.env.PORT = '3995';
process.env.SARVAM_KEY = 'test-key';

const http = require('node:http');
const PHONE_ID = '000000000000000';

const sent = [];
let sarvamSays = null;      // next model output (string); null = API failure
let sarvamCalls = 0;
let lastSarvamBody = null;

global.fetch = async (url, opt) => {
  const u = String(url);
  if (u.includes('sarvam')) {
    sarvamCalls++;
    lastSarvamBody = JSON.parse(opt.body);
    if (sarvamSays === null) return { ok: false, text: async () => 'boom' };
    return { ok: true, text: async () => JSON.stringify({
      choices: [{ message: { content: sarvamSays } }] }) };
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
const S = require('./scheduler');
const VENUES = require('./venues');

const OWNER = '9198XXXXXXXX';

function send(path, body) {
  return new Promise(res => {
    const req = http.request({
      host: '127.0.0.1', port: 3995, path, method: 'POST',
      headers: { 'content-type': 'application/json' }
    }, r => { r.resume(); r.on('end', () => setTimeout(res, 60)); });
    req.end(JSON.stringify(body));
  });
}
const env = m => ({ entry: [{ changes: [{ value: {
  metadata: { phone_number_id: PHONE_ID },
  contacts: [{ profile: { name: 'टेस्ट टीम' } }], messages: [m] } }] }] });
const msg = (from, text) => send('/webhook', env({ from, id: 'm' + Math.random(), type: 'text', text: { body: text } }));
const btn = (from, id) => send('/webhook', env({ from, id: 'm' + Math.random(), type: 'interactive',
  interactive: { button_reply: { id, title: '✓ हाँ, बुक करें' } } }));
const to = who => sent.filter(s => s.to === who).pop() || {};

let n = 0, p = 0;
const ck = (name, cond, extra) => { n++; if (cond) { p++; console.log('PASS ' + name); }
  else console.log('FAIL ' + name + (extra ? '  ' + extra : '')); };

(async () => {
  await new Promise(r => setTimeout(r, 300));
  const tomorrow = S.ymd(S.addDays(S.today(), 1));

  console.log('--- the parser stays first ---');
  const C1 = '919999900041';
  await msg(C1, 'कल 8 बजे बॉक्स क्रिकेट');
  ck('parseable booking never reaches the model', sarvamCalls === 0, 'calls ' + sarvamCalls);
  await msg(C1, 'बैडमिंटन कितने का है');
  ck('price question stays regex-served', sarvamCalls === 0 && /400/.test(to(C1).text || ''));

  console.log('--- greetings skip the model ---');
  const C2 = '919999900042';
  await msg(C2, 'नमस्ते');
  ck('greeting gets the menu, no model call', sarvamCalls === 0 && /क्या खेलना/.test(to(C2).text || ''));

  console.log('--- conversational question -> grounded reply ---');
  const C3 = '919999900043';
  sarvamSays = JSON.stringify({ reply: 'जी, बारिश में बुकिंग आगे बढ़ा दी जाती है। मालिक से पक्का करा लेंगे।', slots: null });
  await msg(C3, 'अगर बारिश हो गई तो बुकिंग का क्या होगा भाई');
  ck('model was consulted', sarvamCalls === 1, 'calls ' + sarvamCalls);
  ck('customer got the grounded reply', /बारिश में बुकिंग/.test(to(C3).text || ''), to(C3).text);
  ck('venue card was in the prompt',
    /चैंपियन/.test(lastSarvamBody.messages[0].content) && /1200/.test(lastSarvamBody.messages[0].content));
  ck('no booking state was created', store.pending('CHAMPION').every(b => b.customer !== C3));

  console.log('--- messy message -> slots -> the same deterministic flow ---');
  const C4 = '919999900044';
  // NB deliberately keyword-free: 'फुटबॉल'/'शाम' would be parsed by the regex
  // NLU itself (it is grabbier than it looks) and the model would never run.
  sarvamSays = JSON.stringify({ reply: null, slots: { service: 'football', date: tomorrow, time: '21:00', recurring: false } });
  await msg(C4, 'हम लोग टूर्नामेंट टाइप कुछ करवाना चाह रहे हैं अपने ग्रुप के लिए');
  ck('slots fed the flow: confirm buttons offered', (to(C4).buttons || []).length === 2, JSON.stringify(to(C4)));
  ck('price came from venues.js, not the model', /1800/.test(to(C4).text || ''), to(C4).text);
  await btn(C4, 'ok');
  const b4 = store.pending('CHAMPION').find(b => b.customer === C4);
  ck('booking still lands in pending - owner approval unchanged', !!b4);

  console.log('--- model failure degrades to the menu ---');
  const C5 = '919999900045';
  sarvamSays = null;                                   // API down
  await msg(C5, 'कुछ समझ नहीं आ रहा क्या करना है मुझे बताओ');
  ck('outage falls back to the welcome menu', /क्या खेलना/.test(to(C5).text || ''), to(C5).text);
  sarvamSays = 'मैं JSON नहीं दूँगा';                    // garbage output
  const C6 = '919999900046';
  await msg(C6, 'कुछ समझ नहीं आ रहा क्या करना है मुझे बताओ');
  ck('garbage falls back to the welcome menu', /क्या खेलना/.test(to(C6).text || ''), to(C6).text);

  console.log('--- invalid model slots are rejected ---');
  const C7 = '919999900047';
  sarvamSays = JSON.stringify({ reply: null, slots: { service: 'golf', date: '2019-01-01', time: '99:00' } });
  await msg(C7, 'गोल्फ खेलना है परसों वाले दिन किसी टाइम पर');
  ck('unknown service + past date + bad time all ignored', /क्या खेलना/.test(to(C7).text || ''), to(C7).text);

  console.log('--- the merchant feature ---');
  const before = sarvamCalls;
  sarvamSays = 'इस हफ्ते ₹500 अग्रिम आया है, एक बुकिंग पक्की है।';
  await msg(OWNER, 'इस हफ्ते कमाई कितनी हुई है भाई');
  ck('owner question reached the model', sarvamCalls === before + 1);
  ck('owner got the answer', /₹500 अग्रिम आया/.test(to(OWNER).text || ''), to(OWNER).text);
  ck('summary we built was the grounding',
    /पिछले 7 दिन/.test(lastSarvamBody.messages[0].content), lastSarvamBody.messages[0].content.slice(0, 120));
  await msg(OWNER, 'आज');
  ck('आज still regex-served', /बुकिंग/.test(to(OWNER).text || ''));

  console.log('--- ai:false switches a venue back to pure regex ---');
  VENUES[0].ai = false;
  const C8 = '919999900048';
  const calls = sarvamCalls;
  await msg(C8, 'अगर बारिश हो गई तो बुकिंग का क्या होगा भाई');
  ck('customer side: no model call', sarvamCalls === calls && /क्या खेलना/.test(to(C8).text || ''));
  await msg(OWNER, 'इस हफ्ते कमाई कितनी हुई है भाई');
  ck('owner side: help line, no model call', sarvamCalls === calls && /लिखिए/.test(to(OWNER).text || ''));
  VENUES[0].ai = true;

  console.log('\n' + p + '/' + n + ' passed');
  process.exit(p === n ? 0 : 1);
})();
