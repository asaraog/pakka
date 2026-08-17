#!/usr/bin/env node
/* Set your venue up in one sitting.

   Tonight's onboarding took six hours because every step was discovered rather
   than followed, and each Meta failure looked like every other Meta failure.
   This does the checkable parts itself and asks only what a human must answer.

     node onboard.js            interactive
     node onboard.js --check    verify the credentials already in venues.js

   It never guesses. Anything it cannot verify against the live API, it says so
   and stops - a venue that half-works is worse than one that is not set up yet.

   Order matters: credentials are proved BEFORE you spend the owner's time on
   prices and hours, so a bad token fails in minute one, not minute twenty. */

const readline = require('node:readline');

const API = 'https://graph.facebook.com/v21.0';
const g = s => `\x1b[32m${s}\x1b[0m`, r = s => `\x1b[31m${s}\x1b[0m`,
      y = s => `\x1b[33m${s}\x1b[0m`, b = s => `\x1b[1m${s}\x1b[0m`;
const ok = m => console.log(g('  ok  ') + m);
const bad = m => console.log(r(' fail ') + m);
const note = m => console.log(y('  ..  ') + m);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, a => res(a.trim())));

async function askDefault(q, dflt) {
  const a = await ask(`${q}${dflt !== undefined ? ` [${dflt}]` : ''}: `);
  return a === '' && dflt !== undefined ? String(dflt) : a;
}
const askNum = async (q, dflt) => Number(await askDefault(q, dflt));

// ------------------------------------------------------------------ meta checks

async function meta(path, token, opts) {
  const r = await fetch(`${API}/${path}`, Object.assign({
    headers: { Authorization: `Bearer ${token}` }
  }, opts || {}));
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; }
  return { ok: r.ok, status: r.status, j };
}

/* Everything that can go wrong with credentials, checked in the order that
   produces the most useful error. Returns null if the venue is not usable. */
async function verifyCreds(waPhoneId, waToken, wabaId) {
  const tok = await meta(`debug_token?input_token=${waToken}&access_token=${waToken}`, waToken);
  if (!tok.ok || !tok.j.data || !tok.j.data.is_valid) {
    bad('token is not valid'); return null;
  }
  const d = tok.j.data;
  const exp = d.expires_at;
  ok(`token valid (${d.type || 'user'})`);
  if (exp && exp !== 0) {
    const hrs = Math.round((exp * 1000 - Date.now()) / 3600e3);
    bad(`this token EXPIRES in ~${hrs}h. Use a System User token with expiry Never,`);
    console.log('       or the bot dies mid-pilot and every merchant goes quiet.');
    return null;
  }
  ok('token never expires');

  const need = ['whatsapp_business_messaging', 'whatsapp_business_management'];
  const missing = need.filter(s => !(d.scopes || []).includes(s));
  if (missing.length) { bad('token missing scopes: ' + missing.join(', ')); return null; }
  ok('scopes present');

  const ph = await meta(`${waPhoneId}?fields=display_phone_number,platform_type,status,quality_rating`, waToken);
  if (!ph.ok) {
    bad(`cannot read phone ${waPhoneId}: ${(ph.j.error || {}).message || ph.status}`);
    console.log('       usually means the System User has not been ASSIGNED this WhatsApp account.');
    console.log('       Business settings -> System users -> Assign assets -> WhatsApp accounts.');
    return null;
  }
  const p = ph.j;
  ok(`number ${p.display_phone_number}  platform=${p.platform_type}  status=${p.status}`);
  if (p.platform_type !== 'CLOUD_API') {
    bad(`platform is ${p.platform_type}, not CLOUD_API - this number cannot send via the API yet.`);
    console.log('       Finish registering the number for Cloud API first (README step 2).');
    return null;
  }
  if (p.status !== 'CONNECTED') note(`status is ${p.status}; sending may fail until it is CONNECTED`);

  if (wabaId) {
    const sub = await meta(`${wabaId}/subscribed_apps`, waToken, { method: 'POST' });
    if (sub.ok) ok('app subscribed to their WABA (inbound messages will reach us)');
    else bad(`could not subscribe app to WABA: ${(sub.j.error || {}).message || sub.status}`);
  } else {
    note('no WABA id given - skipping the subscribe step. Inbound will NOT work until');
    console.log('       the app is subscribed to their WhatsApp Business Account.');
  }
  return p;
}

async function sendTest(waPhoneId, waToken, to, venueName) {
  const res = await meta(`${waPhoneId}/messages`, waToken, {
    method: 'POST',
    headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'text',
      text: { body: `पक्का ✅ ${venueName} का बॉट तैयार है।\nजवाब में लिखिए: आज` }
    })
  });
  if (res.ok) { ok(`test message sent to ${to} - ASK THEM TO CONFIRM IT ARRIVED`); return true; }
  bad(`test send failed: ${(res.j.error || {}).message || res.status}`);
  if (((res.j.error || {}).code) === 131030)
    console.log('       recipient not on the allow-list (test numbers only message approved numbers).');
  return false;
}

// ------------------------------------------------------------------ flows

async function checkAll() {
  const VENUES = require('./venues');
  for (const v of VENUES) {
    console.log('\n' + b(`── ${v.code}  ${v.nameEn || v.name}`));
    const p = await verifyCreds(v.waPhoneId, v.waToken, v.wabaId);
    if (!p) continue;
    if (!v.vpa || v.vpa.includes('XXXX')) bad('vpa looks like a placeholder');
    else ok(`upi ${v.vpa}`);
    if (!/^\d{10,15}$/.test(String(v.ownerPhone))) bad(`ownerPhone "${v.ownerPhone}" is not digits with country code`);
    else ok(`owner ${v.ownerPhone}`);
  }
  rl.close();
}

async function interactive() {
  console.log(b('\nSet up your venue\n'));
  console.log('Credentials first: if these are wrong, nothing else matters.\n');

  const waPhoneId = await ask('Phone number ID (digits, from API Setup): ');
  const waToken   = await ask('System User token (expiry Never): ');
  const wabaId    = await ask('WhatsApp Business Account ID (blank to skip subscribe): ');

  console.log();
  const phone = await verifyCreds(waPhoneId, waToken, wabaId || null);
  if (!phone) { console.log(r('\nStopping. Fix the above before spending the owner\'s time.\n')); rl.close(); return; }

  console.log(b('\nNow the business. Ask the owner; do not guess.\n'));
  const nameEn = await ask('Venue name (English): ');
  const name   = await askDefault('Venue name (Hindi, shown to customers)', nameEn);
  const ownerPhone = await ask('Owner WhatsApp (digits + country code, e.g. 919XXXXXXXXX): ');
  const vpa    = await ask('Their UPI id ("आपकी UPI ID क्या है?"): ');
  const payeeName = await askDefault('Name shown in the UPI app', nameEn);

  const open  = await askNum('Opens at (24h)', 6);
  const close = await askNum('Closes at (24h)', 23);
  const off   = await askNum('Weekly off day (0=Sun, 6=Sat, -1=never)', -1);
  const peakFrom = await askNum('Peak starts at (24h, -1 if no peak rate)', 17);
  const peakTo   = peakFrom < 0 ? 0 : await askNum('Peak ends at (24h)', close);
  const peakMult = peakFrom < 0 ? 1 : await askNum('Peak multiplier (1.5 = 50% more)', 1.5);

  console.log(y('\n  "अभी एडवांस कितना लेते हैं?" - if they take none today, they are the wrong merchant.\n'));
  const depositPct = await askNum('Advance as fraction of price (0.3 = 30%)', 0.3);
  const depositMin = await askNum('Minimum advance ₹', 200);
  const depositMax = await askNum('Maximum advance ₹', 500);

  console.log(b('\nWhat is bookable? (grounds, courts, chairs, rooms) - blank name to finish'));
  const grounds = [];
  for (let i = 1; ; i++) {
    const hi = await ask(`  ${i}. name as they say it: `);
    if (!hi) break;
    grounds.push({ id: 'g' + i, hi });
  }
  if (!grounds.length) grounds.push({ id: 'g1', hi: 'ग्राउंड 1' });

  console.log(b('\nWhat do people book? - blank name to finish'));
  const services = [];
  for (let i = 1; ; i++) {
    const hi = await ask(`  ${i}. service (Hindi): `);
    if (!hi) break;
    const id = await askDefault('     id (english, no spaces)', 'svc' + i);
    const price = await askNum('     price per slot ₹', 1200);
    const mins = await askNum('     minutes', 60);
    services.push({ id, hi, price, mins });
  }
  if (!services.length) { bad('no services - cannot onboard'); rl.close(); return; }

  console.log();

  const yn = await askDefault('Send a live test message to the owner now? (y/n)', 'y');
  if (yn.toLowerCase().startsWith('y')) await sendTest(waPhoneId, waToken, ownerPhone, name);

  /* Two blocks, printed - never written to a file. The first five values are
     private and belong in Render's environment. Everything after is exactly
     what venues.js already asks you to edit directly, so it goes straight into
     the committed file where the Hindi wording and rates are meant to live. */
  console.log(b('\n' + '='.repeat(64)));
  console.log(b('1. Paste these into Render -> Environment (or your shell):'));
  console.log(b('='.repeat(64)));
  console.log(`WA_PHONE_ID=${waPhoneId}`);
  console.log(`WA_TOKEN=${waToken}`);
  console.log(`WABA_ID=${wabaId}`);
  console.log(`OWNER_PHONE=${ownerPhone}`);
  console.log(`VENUE_VPA=${vpa}`);
  console.log(y('\nThis is your token, your WhatsApp number and your UPI id.'));
  console.log(y('Do not paste it into venues.js, a chat, or a commit.'));

  console.log(b('\n' + '='.repeat(64)));
  console.log(b('2. Edit venues.js with these - safe to commit, nothing private here:'));
  console.log(b('='.repeat(64)));
  console.log(`    name: '${name}',`);
  console.log(`    nameEn: '${nameEn}',`);
  console.log(`    payeeName: '${payeeName}',`);
  console.log(`    open: ${open}, close: ${close},`);
  console.log(`    off: ${off},`);
  console.log(`    peakFrom: ${peakFrom}, peakTo: ${peakTo}, peakMult: ${peakMult},`);
  console.log(`    depositPct: ${depositPct}, depositMin: ${depositMin}, depositMax: ${depositMax},`);
  console.log('    grounds: [');
  console.log(grounds.map(x => `      { id: '${x.id}', hi: '${x.hi}' }`).join(',\n'));
  console.log('    ],');
  console.log('    services: [');
  console.log(services.map(x => `      { id: '${x.id}', hi: '${x.hi}', price: ${x.price}, mins: ${x.mins} }`).join(',\n'));
  console.log('    ]');

  console.log(b('\n' + '='.repeat(64)));
  console.log('Then:');
  console.log('  1. Commit venues.js (fork it on GitHub and edit there, or edit locally).');
  console.log('  2. Set the five values above in Render -> Environment. It redeploys itself.');
  console.log('  3. Reply "आज" to the test message - confirms inbound works.');
  console.log('  4. Payments: forward your bank\'s payment message to your own bot.');
  console.log('     See the README to automate it.\n');
  rl.close();
}

const mode = process.argv.includes('--check') ? checkAll : interactive;

(mode()).catch(e => {
  console.error(r('error: ') + e.message); rl.close(); process.exit(1);
});
