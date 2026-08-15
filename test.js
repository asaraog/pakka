/* End-to-end against a stubbed Graph API. No network, no WhatsApp account. */
process.env.WA_VERIFY_TOKEN='verify'; process.env.DB_PATH=':memory:'; process.env.PORT='3999';
const PHONE_ID='000000000000000';   // matches venues.js

const sent = [];
global.fetch = async (url, opt) => {
  const b = JSON.parse(opt.body);
  if (b.status !== 'read') sent.push({ to: b.to, text: b.text?.body || b.interactive?.body?.text,
    buttons: b.interactive?.action?.buttons?.map(x=>x.reply.title),
    ids: b.interactive?.action?.buttons?.map(x=>x.reply.id) });
  return { ok: true, text: async () => '{}' };
};
require('./server.js');

const OWNER = '9198XXXXXXXX', CUST = '919999900001';
const post = (body) => fetch2('/webhook', body);
async function fetch2(path, body) {
  const r = await (await import('node:http')).request;
  return new Promise((res) => {
    const req = require('node:http').request({ host:'127.0.0.1', port:3999, path, method:'POST',
      headers:{'content-type':'application/json'} }, (r)=>{ r.resume(); r.on('end',()=>setTimeout(res,60)); });
    req.end(JSON.stringify(body));
  });
}
const env = (from, m, profile) => ({ entry:[{changes:[{value:{
  metadata:{ phone_number_id: PHONE_ID },
  contacts:[{profile:{name:profile||'टेस्ट टीम'}}], messages:[m]}}]}]});
const msg = (from, text, profile) => env(from,
  {from, id:'m'+Math.random(), type:'text', text:{body:text}}, profile);
const btn = (from, id, title) => env(from,
  {from, id:'m'+Math.random(), type:'interactive', interactive:{button_reply:{id, title}}});

const last = () => sent[sent.length-1] || {};
let n=0,p=0;
const ck=(name,cond,extra)=>{n++;if(cond){p++;console.log('PASS '+name)}else console.log('FAIL '+name+(extra?'  '+extra:''))};

(async () => {
  await new Promise(r=>setTimeout(r,300));

  console.log('--- customer books ---');
  await post(msg(CUST, 'नमस्ते'));
  ck('routed by the venue own number, no code needed', /चैंपियन|क्या खेलना/.test(last().text||''), last().text);

  await post(msg(CUST, 'हर मंगलवार 7 बजे बॉक्स क्रिकेट'));
  ck('recurring + service + time parsed', /हर हफ्ते/.test(last().text||''), last().text);
  ck('peak rate applied', /1800/.test(last().text||''), last().text);
  ck('confirm buttons offered', (last().buttons||[]).length===2);

  await post(btn(CUST,'ok','✓ हाँ, बुक करें'));
  const ownerMsg = sent.filter(s=>s.to===OWNER).pop();
  ck('owner asked to approve', /पक्का स्लॉट|नई बुकिंग/.test(ownerMsg?.text||''), ownerMsg?.text);
  ck('owner gets 3 buttons', (ownerMsg?.buttons||[]).length===3);
  ck('4 weeks held', /4 हफ्ते|× 4/.test(ownerMsg?.text||''), ownerMsg?.text);

  console.log('--- owner approves ---');
  const ref = /BA[A-Z0-9]+/.exec(JSON.stringify(sent))?.[0];
  const store = require('./store');
  const pend = store.pending('CHAMPION');
  ck('four pending rows persisted', pend.length===4, 'got '+pend.length);
  await post(btn(OWNER,'ok:'+pend[0].ref,'✓ मंज़ूर'));
  const toCust = sent.filter(s=>s.to===CUST).pop();
  ck('customer gets UPI link', /upi:\/\/pay/.test(toCust?.text||''), toCust?.text);
  ck('link pays the venue vpa', /championarena@okhdfcbank/.test(toCust?.text||''));
  // deposit is capped at ₹500 by venue config, so four weeks = ₹2000
  ck('advance summed across all four weeks', /₹2000/.test(toCust?.text||''), toCust?.text);
  ck('upi amount matches', /am=2000\.00/.test(toCust?.text||''));
  ck('all four moved to hold', store.pending('CHAMPION').length===0);

  console.log('--- payment confirmed by owner ---');
  await post(msg(CUST,'भेज दिया'));
  const ask = sent.filter(s=>s.to===OWNER).pop();
  ck('owner asked to eyeball UPI app', /आया क्या/.test(ask?.text||''), ask?.text);
  const holdRef = (ask?.ids||[]).find(i=>i.startsWith('paid:'))?.split(':')[1];
  ck('owner button carries the ref', !!holdRef, JSON.stringify(ask?.ids));
  await post(btn(OWNER,'paid:'+holdRef,'✓ हाँ, आ गया'));
  ck('booking marked paid', store.byRef(holdRef).status==='paid');
  ck('customer told confirmed', /बुकिंग पक्की/.test(sent.filter(s=>s.to===CUST).pop()?.text||''));

  console.log('--- owner day view ---');
  await post(msg(OWNER,'आज'));
  await post(msg(OWNER,'कल'));
  ck('day list renders', /बुकिंग|कोई बुकिंग नहीं/.test(sent.filter(s=>s.to===OWNER).pop()?.text||''));

  console.log('--- second customer, slot conflict ---');
  const C2='919999900002';
  await post(msg(C2,'हर मंगलवार 7 बजे बॉक्स क्रिकेट'));
  await post(btn(C2,'ok','✓ हाँ, बुक करें'));
  const c2 = sent.filter(s=>s.to===C2).pop();
  ck('second team still fits (ground 2)', /एक मिनट|भर गया/.test(c2?.text||''), c2?.text);

  console.log('--- misc ---');
  await post(msg(CUST,'बैडमिंटन कितने का है'));
  ck('price list answered', /400/.test(sent.filter(s=>s.to===CUST).pop()?.text||''));
  await post(msg(CUST,'मेरा डेटा हटा दीजिए'));
  ck('erasure works', /हटा दी गई/.test(sent.filter(s=>s.to===CUST).pop()?.text||''));

  console.log('\n'+p+'/'+n+' passed');
  process.exit(p===n?0:1);
})();
