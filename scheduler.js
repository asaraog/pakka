/* Headless booking logic. Same rules as the prototype, no DOM.
   Slots are 30 minutes; a 60-minute game occupies two consecutive ones. */
const store = require('./store');

const pad2 = n => String(n).padStart(2, '0');
const hhmm = (h, m) => pad2(h) + ':' + pad2(m);
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };

const isClosed = (v, d) => v.off >= 0 && d.getDay() === v.off;
const isPeak = (v, h) => v.peakFrom != null && h >= v.peakFrom && h < v.peakTo;
const priceAt = (v, svc, h) => isPeak(v, h) ? Math.round(svc.price * (v.peakMult || 1)) : svc.price;
function depositFor(v, svc, h) {
  const p = priceAt(v, svc, h);
  return Math.min(v.depositMax || 500, Math.max(v.depositMin || 200, Math.round(p * (v.depositPct || 0.3) / 50) * 50));
}
const slotsNeeded = svc => Math.max(1, Math.ceil(svc.mins / 30));

function slotList(v) {
  const out = [];
  for (let h = v.open; h < v.close; h++) { out.push({ h, m: 0 }); out.push({ h, m: 30 }); }
  return out;
}
function runFrom(v, h, m, need) {
  const list = slotList(v);
  const i = list.findIndex(s => s.h === h && s.m === m);
  if (i < 0 || i + need > list.length) return null;
  return list.slice(i, i + need).map(s => hhmm(s.h, s.m));
}

// Which ground can take this game at this time? First free one the sport allows.
function findGround(v, date, h, m, svc) {
  if (isClosed(v, date)) return null;
  const times = runFrom(v, h, m, slotsNeeded(svc));
  if (!times) return null;
  const allowed = svc.grounds || v.grounds.map(g => g.id);
  for (const gid of allowed) {
    if (!store.takenAt(v.code, ymd(date), gid, times)) return gid;
  }
  return null;
}
const isFree = (v, date, h, m, svc) => !!findGround(v, date, h, m, svc);

function freeSlots(v, date, svc, limit, nearMins) {
  const out = [];
  for (const s of slotList(v)) {
    const g = findGround(v, date, s.h, s.m, svc);
    if (g) out.push({ h: s.h, m: s.m, ground: g });
  }
  if (nearMins != null) out.sort((a, b) => Math.abs(a.h * 60 + a.m - nearMins) - Math.abs(b.h * 60 + b.m - nearMins));
  return limit ? out.slice(0, limit) : out;
}

function nextOpen(v, d) { let x = d, g = 0; while (isClosed(v, x) && g++ < 8) x = addDays(x, 1); return x; }

function book(v, { customer, name, svc, date, h, m, status }) {
  const ground = findGround(v, date, h, m, svc);
  if (!ground) return null;
  return store.create({
    venue: v.code, customer, name, service: svc.id, ground,
    date: ymd(date), time: hhmm(h, m), mins: svc.mins,
    price: priceAt(v, svc, h), deposit: depositFor(v, svc, h),
    status: status || 'pending'
  });
}

// upi://pay intent to the venue's own VPA. Payer-initiated, so unaffected by the
// Collect withdrawal, and no PSP sits in the middle.
function upiLink(v, b) {
  const enc = s => encodeURIComponent(String(s));
  return 'upi://pay?pa=' + v.vpa + '&pn=' + enc(v.payeeName || v.nameEn) +
    '&am=' + Number(b.deposit).toFixed(2) + '&cu=INR' +
    '&tn=' + enc('Advance ' + b.ref) + '&tr=' + b.ref;
}

module.exports = {
  pad2, hhmm, ymd, addDays, today, isClosed, isPeak, priceAt, depositFor,
  slotsNeeded, findGround, isFree, freeSlots, nextOpen, book, upiLink
};
