/* Hindi + Hinglish booking NLU. Rule-based, deterministic, runs on-device.
   Extracts: intent, service, date, time, party size.

   Note on word boundaries: JS \b is ASCII-only, so \bकल\b never matches and
   plain substring tests fire on the wrong things (ना inside करवाना). Every
   whole-word test below goes through wordRe(), which brackets the term with
   explicit Devanagari-aware boundaries instead. */
const NLU = (function () {

  const DEVA_DIGITS = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
  const WORDCH = '\\u0900-\\u097F0-9a-z';                  // Devanagari + digits + latin
  const NOT_AFTER = '(?![' + WORDCH + '])';
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function wordRe(w) { return new RegExp('(?:^|[^' + WORDCH + '])' + esc(w) + NOT_AFTER); }
  function hasWord(t, w) { return wordRe(w).test(t); }
  function hasAny(t, list) { for (const w of list) if (hasWord(t, w)) return w; return null; }

  function normalize(s) {
    let t = s.toLowerCase().trim();
    t = t.replace(/[०-९]/g, d => DEVA_DIGITS[d]);
    t = t.replace(/[‌‍]/g, '');                   // ZWJ / ZWNJ
    t = t.replace(/[।,!?."'‘’“”]/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  // ---------- catalogues ----------
  const CATALOGUE = {
    salon: {
      name: 'शर्मा हेयर स्टूडियो', nameEn: 'Sharma Hair Studio',
      city: 'इंदौर', cityEn: 'Indore',
      addr: 'दुकान 12, न्यू पलासिया, इंदौर 452001', addrEn: 'Shop 12, New Palasia, Indore 452001',
      vpa: 'sharmastudio@okhdfcbank',
      subject: 'ग्राहक', subjectEn: 'Customer',
      open: 10, close: 20, kind: 'retail',
      resourceLabel: 'कुर्सी', resourceLabelEn: 'Chair',
      resources: [{ id: 'c1', hi: 'कुर्सी 1', en: 'Chair 1' }, { id: 'c2', hi: 'कुर्सी 2', en: 'Chair 2' }],
      services: [
        { id: 'cut', hi: 'हेयरकट', en: 'Haircut', price: 300, mins: 30, kw: ['हेयरकट', 'हेयर कट', 'बाल कटिंग', 'बाल कटवा', 'कटिंग', 'बाल काट', 'haircut', 'hair cut', 'cutting', 'baal'] },
        { id: 'beard', hi: 'दाढ़ी / शेव', en: 'Beard trim / shave', price: 150, mins: 20, kw: ['दाढ़ी', 'दाढी', 'शेव', 'बियर्ड', 'beard', 'shave', 'daadhi', 'dadhi'] },
        { id: 'colour', hi: 'हेयर कलर', en: 'Hair colour', price: 1200, mins: 90, kw: ['कलर', 'कलरिंग', 'डाई', 'colour', 'color', 'dye', 'highlight', 'हाइलाइट'] },
        { id: 'facial', hi: 'फेशियल', en: 'Facial', price: 800, mins: 45, kw: ['फेशियल', 'क्लीनअप', 'क्लीन अप', 'facial', 'cleanup', 'clean up'] },
        { id: 'massage', hi: 'हेड मसाज', en: 'Head massage', price: 400, mins: 30, kw: ['मसाज', 'चंपी', 'मालिश', 'massage', 'champi', 'malish'] },
        { id: 'thread', hi: 'थ्रेडिंग', en: 'Threading', price: 80, mins: 15, kw: ['थ्रेडिंग', 'आइब्रो', 'भौंह', 'threading', 'eyebrow', 'upper lip'] },
        { id: 'bridal', hi: 'ब्राइडल मेकअप', en: 'Bridal makeup', price: 8000, mins: 180, kw: ['ब्राइडल', 'दुल्हन', 'मेकअप', 'bridal', 'makeup', 'dulhan'] }
      ],
      pkg: { hi: 'ग्रूमिंग पैक', en: 'Grooming pack', amount: 1499, perHi: 'महीना', perEn: 'month', includesHi: 'महीने में 2 हेयरकट + 2 शेव + 1 हेड मसाज', includesEn: '2 haircuts + 2 shaves + 1 head massage a month' }
    },
    dental: {
      name: 'डॉ. मीना डेंटल क्लिनिक', nameEn: 'Dr Meena Dental Clinic',
      city: 'जयपुर', cityEn: 'Jaipur',
      addr: 'प्लॉट 4, मालवीय नगर, जयपुर 302017', addrEn: 'Plot 4, Malviya Nagar, Jaipur 302017',
      vpa: 'meenadental@okicici',
      subject: 'मरीज़', subjectEn: 'Patient',
      open: 10, close: 19, kind: 'clinic',
      resourceLabel: 'डॉक्टर', resourceLabelEn: 'Doctor',
      resources: [{ id: 'd1', hi: 'डॉ. मीना', en: 'Dr Meena' }, { id: 'd2', hi: 'डॉ. अरुण', en: 'Dr Arun' }],
      services: [
        { id: 'consult', hi: 'कंसल्टेशन', en: 'Consultation', price: 300, mins: 15, visits: 1, kw: ['कंसल्टेशन', 'चेकअप', 'दिखाना', 'सलाह', 'consult', 'checkup', 'check up'] },
        { id: 'clean', hi: 'सफाई / स्केलिंग', en: 'Cleaning / scaling', price: 1200, mins: 30, visits: 1, recallMonths: 6, kw: ['सफाई', 'स्केलिंग', 'cleaning', 'scaling', 'safai'] },
        { id: 'filling', hi: 'फिलिंग', en: 'Filling', price: 1500, mins: 40, visits: 1, kw: ['फिलिंग', 'भरवा', 'कैविटी', 'कीड़ा', 'filling', 'cavity'] },
        { id: 'rct', hi: 'रूट कैनाल', en: 'Root canal', price: 6000, mins: 60, visits: 3, kw: ['रूट कैनाल', 'रुट कैनाल', 'आरसीटी', 'root canal', 'rct'] },
        { id: 'extract', hi: 'दांत निकालना', en: 'Extraction', price: 1500, mins: 30, visits: 1, kw: ['निकालना', 'निकलवाना', 'उखड़वा', 'extraction', 'extract'] },
        { id: 'braces', hi: 'ब्रेसेस', en: 'Braces', price: 35000, mins: 45, visits: 12, kw: ['ब्रेसेस', 'अलाइनर', 'braces', 'aligner'] }
      ],
      pkg: { hi: 'ब्रेसेस किस्त', en: 'Braces instalment', amount: 2999, perHi: 'महीना', perEn: 'month', includesHi: '12 महीने, हर महीने चेकअप और वायर बदलाई शामिल', includesEn: '12 months, monthly check-up and wire change included' }
    },
    lab: {
      name: 'सृजन डायग्नोस्टिक्स', nameEn: 'Srijan Diagnostics',
      city: 'लखनऊ', cityEn: 'Lucknow',
      addr: '18, हज़रतगंज, लखनऊ 226001', addrEn: '18 Hazratganj, Lucknow 226001',
      vpa: 'srijanlabs@okhdfcbank',
      subject: 'मरीज़', subjectEn: 'Patient',
      open: 7, close: 19, kind: 'clinic',
      resourceLabel: 'काउंटर', resourceLabelEn: 'Counter',
      resources: [{ id: 'l1', hi: 'काउंटर 1', en: 'Counter 1' }, { id: 'l2', hi: 'घर से सैंपल', en: 'Home collection' }],
      services: [
        { id: 'cbc', hi: 'ब्लड टेस्ट (CBC)', en: 'Blood test (CBC)', price: 350, mins: 15, visits: 1, kw: ['सीबीसी', 'ब्लड टेस्ट', 'खून की जाँच', 'खून', 'cbc', 'blood test'] },
        { id: 'sugar', hi: 'शुगर (फास्टिंग)', en: 'Fasting glucose', price: 150, mins: 15, visits: 1, fasting: true, recallMonths: 3, kw: ['शुगर', 'डायबिटीज', 'ग्लूकोज', 'sugar', 'glucose', 'diabetes'] },
        { id: 'thyroid', hi: 'थायरॉइड', en: 'Thyroid panel', price: 600, mins: 15, visits: 1, recallMonths: 6, kw: ['थायरॉइड', 'थाइरॉइड', 'thyroid', 'tsh'] },
        { id: 'lipid', hi: 'लिपिड प्रोफ़ाइल', en: 'Lipid profile', price: 800, mins: 15, visits: 1, fasting: true, kw: ['लिपिड', 'कोलेस्ट्रॉल', 'lipid', 'cholesterol'] },
        { id: 'xray', hi: 'एक्स-रे', en: 'X-ray', price: 500, mins: 20, visits: 1, kw: ['एक्स रे', 'एक्सरे', 'x ray', 'xray'] },
        { id: 'full', hi: 'फुल बॉडी चेकअप', en: 'Full body check-up', price: 2500, mins: 45, visits: 1, fasting: true, recallMonths: 12, kw: ['फुल बॉडी', 'पूरा चेकअप', 'full body', 'health check'] }
      ],
      pkg: { hi: 'साल भर की जाँच', en: 'Annual screening', amount: 499, perHi: 'महीना', perEn: 'month', includesHi: 'साल में 2 फुल बॉडी चेकअप और घर से सैंपल', includesEn: '2 full-body screens a year, samples collected at home' }
    },
    vet: {
      name: 'पंजा पेट क्लिनिक', nameEn: 'Panja Pet Clinic',
      city: 'गुरुग्राम', cityEn: 'Gurugram',
      addr: 'शॉप 7, सेक्टर 14 मार्केट, गुरुग्राम 122001', addrEn: 'Shop 7, Sector 14 Market, Gurugram 122001',
      vpa: 'panjavet@okhdfcbank',
      subject: 'पालतू', subjectEn: 'Pet',
      open: 10, close: 20, kind: 'clinic',
      resourceLabel: 'डॉक्टर', resourceLabelEn: 'Doctor',
      resources: [{ id: 'v1', hi: 'डॉ. कविता', en: 'Dr Kavita' }, { id: 'v2', hi: 'डॉ. इमरान', en: 'Dr Imran' }],
      services: [
        { id: 'consult', hi: 'चेकअप', en: 'Consultation', price: 500, mins: 20, visits: 1, kw: ['चेकअप', 'दिखाना', 'कंसल्टेशन', 'सलाह', 'consult', 'checkup', 'check up'] },
        { id: 'vaccine', hi: 'टीका', en: 'Vaccination', price: 900, mins: 15, visits: 1, recallMonths: 12, kw: ['टीका', 'वैक्सीन', 'वैक्सिनेशन', 'रेबीज', 'vaccine', 'vaccination', 'rabies', 'shot'] },
        { id: 'deworm', hi: 'कृमि की दवा', en: 'Deworming', price: 350, mins: 10, visits: 1, recallMonths: 3, kw: ['कृमि', 'पेट के कीड़े', 'डीवर्म', 'deworm', 'worming'] },
        { id: 'groom', hi: 'ग्रूमिंग', en: 'Grooming', price: 1200, mins: 60, visits: 1, kw: ['ग्रूमिंग', 'नहलाना', 'बाल काटना', 'नाखून', 'groom', 'bath', 'nail'] },
        { id: 'dental', hi: 'दाँत की सफाई', en: 'Dental cleaning', price: 2500, mins: 45, visits: 1, kw: ['दाँत की सफाई', 'दांत साफ', 'scaling', 'dental clean'] },
        { id: 'surgery', hi: 'ऑपरेशन / नसबंदी', en: 'Surgery / spay', price: 8000, mins: 90, visits: 2, kw: ['ऑपरेशन', 'नसबंदी', 'सर्जरी', 'spay', 'neuter', 'surgery'] }
      ],
      pkg: { hi: 'पेट केयर प्लान', en: 'Pet care plan', amount: 599, perHi: 'महीना', perEn: 'month', includesHi: 'साल भर के टीके, 4 चेकअप और कृमि की दवा', includesEn: 'a year of vaccinations, 4 check-ups and deworming' }
    },
    turf: {
      name: 'चैंपियन स्पोर्ट्स एरिना', nameEn: 'Champion Sports Arena',
      city: 'लखनऊ', cityEn: 'Lucknow',
      addr: 'विराज खंड, गोमती नगर, लखनऊ 226010', addrEn: 'Viraj Khand, Gomti Nagar, Lucknow 226010',
      vpa: 'championarena@okhdfcbank',
      subject: 'टीम', subjectEn: 'Team',
      open: 6, close: 23, kind: 'venue',
      // an empty 8pm slot on Saturday is worth three times an empty 11am one
      peakFrom: 17, peakTo: 23, peakMult: 1.5,
      slotMins: 60,
      resourceLabel: 'ग्राउंड', resourceLabelEn: 'Ground',
      resources: [{ id: 'g1', hi: 'ग्राउंड 1 (बड़ा)', en: 'Ground 1 (full)' },
                  { id: 'g2', hi: 'ग्राउंड 2', en: 'Ground 2' },
                  { id: 'c1', hi: 'बैडमिंटन कोर्ट', en: 'Badminton court' }],
      services: [
        { id: 'cricket', hi: 'बॉक्स क्रिकेट', en: 'Box cricket', price: 1200, mins: 60, visits: 1, kw: ['बॉक्स क्रिकेट', 'क्रिकेट', 'बॉक्स', 'cricket', 'box'] },
        { id: 'football', hi: 'फुटबॉल (5-a-side)', en: 'Football 5-a-side', price: 1200, mins: 60, visits: 1, kw: ['फुटबॉल', 'फ़ुटबॉल', 'फूटबाल', 'football', 'soccer'] },
        { id: 'badminton', hi: 'बैडमिंटन', en: 'Badminton', price: 400, mins: 60, visits: 1, kw: ['बैडमिंटन', 'बेडमिंटन', 'शटल', 'badminton', 'shuttle'] },
        { id: 'pickle', hi: 'पिकलबॉल', en: 'Pickleball', price: 600, mins: 60, visits: 1, kw: ['पिकलबॉल', 'पिकल', 'pickleball', 'pickle'] }
      ],
      pkg: { hi: 'महीने का स्लॉट', en: 'Monthly slot', amount: 3999, perHi: 'महीना', perEn: 'month', includesHi: 'हर हफ्ते वही स्लॉट, 4 बार, पक्का', includesEn: 'the same slot every week, four times, guaranteed' }
    }
  };

  // ---------- intents ----------
  // [name, whole-word terms, stem terms]. Stems match as plain substrings so a
  // verb keeps its intent when Hindi inflects it (खुल → खुले / खुला / खुलते).
  const INTENTS = [
    ['cancel', ['कैंसिल', 'कैन्सल', 'रद्द', 'cancel'], []],
    ['reschedule', ['रीशेड्यूल', 'पोस्टपोन', 'reschedule', 'postpone', 'prepone'], ['बदल', 'आगे बढ़ा']],
    ['price', ['रेट', 'दाम', 'चार्ज', 'कीमत', 'price', 'rate', 'charges', 'kitna', 'kitne'], ['कितने का', 'कितने के', 'कितने की', 'कितना लग', 'कितने लग', 'कितने पैसे', 'कितने रुपए', 'कितने रुपये', 'कितने में']],
    ['hours', ['टाइमिंग', 'timing', 'closing'], ['कब खुल', 'कब तक खुल', 'बजे खुल', 'कब बंद', 'बजे बंद', 'खुले रह', 'खुला रह', 'कब तक खुले']],
    ['address', ['पता', 'कहाँ', 'कहां', 'लोकेशन', 'address', 'location', 'kahan'], []],
    ['human', ['इंसान', 'मालिक', 'human', 'call me'], ['बात कर', 'talk to']],
    ['pkg', ['पैकेज', 'पैक', 'मेंबरशिप', 'सब्सक्रिप्शन', 'ऑटोपे', 'किस्त', 'ईएमआई', 'package', 'membership', 'autopay', 'emi', 'subscription'], []],
    ['confirm', ['हाँ', 'हां', 'ठीक है', 'ठीक', 'पक्का', 'कर दो', 'कर दीजिए', 'ok', 'okay', 'yes', 'haan', 'confirm', 'theek', 'sahi'], []],
    ['deny', ['नहीं', 'ना', 'नही', 'no', 'nahi', 'nope'], []],
    ['book', ['बुक', 'अपॉइंटमेंट', 'अपॉइन्टमेंट', 'स्लॉट', 'चाहिए', 'book', 'appointment', 'slot', 'chahiye'], ['आना है', 'करवाना है', 'कराना है', 'करवानी है', 'बनवानी है', 'बुकिंग']]
  ];

  const WEEKDAYS = [
    ['रविवार', 'रवि', 'इतवार', 'sunday', 'ravivar', 'itwar'],
    ['सोमवार', 'सोम', 'monday', 'somvar'],
    ['मंगलवार', 'मंगल', 'tuesday', 'mangalvar'],
    ['बुधवार', 'बुध', 'wednesday', 'budhvar'],
    ['गुरुवार', 'गुरु', 'बृहस्पतिवार', 'thursday', 'guruvar'],
    ['शुक्रवार', 'शुक्र', 'friday', 'shukravar'],
    ['शनिवार', 'शनि', 'saturday', 'shanivar']
  ];

  const HI_DAYS = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
  const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const HI_MONTHS = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
  const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
  function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  // Returns { date, evidence (hi), ev (en), matched (raw substring to strip before time parsing) }
  function parseDate(t, now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let w = hasAny(t, ['आज', 'aaj', 'today']);
    if (w) return { date: today, evidence: 'आज', ev: 'today', matched: w };
    w = hasAny(t, ['परसों', 'parson', 'parso']);
    if (w) return { date: addDays(today, 2), evidence: 'परसों', ev: 'day after tomorrow', matched: w };
    // कल is yesterday or tomorrow; in a forward-looking booking context it is tomorrow
    w = hasAny(t, ['कल', 'kal', 'tomorrow']);
    if (w) return { date: addDays(today, 1), evidence: 'कल', ev: 'tomorrow', matched: w };

    // dd/mm first, so "20/8 को" is not read as "8 को"
    let m = t.match(/(?:^|[^\d])(\d{1,2})([\/\-])(\d{1,2})(?:[\/\-](\d{2,4}))?(?![\d])/);
    if (m) {
      const dd = +m[1], mm = +m[3];
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
        const yy = m[4] ? (+m[4] < 100 ? 2000 + +m[4] : +m[4]) : today.getFullYear();
        let d = new Date(yy, mm - 1, dd);
        if (!m[4] && d < today) d = new Date(yy + 1, mm - 1, dd);
        return { date: d, evidence: `${dd}/${mm}`, ev: `${dd}/${mm}`, matched: m[1] + m[2] + m[3] };
      }
    }
    // "15 तारीख" / "15 को" / "15 tareekh"
    m = t.match(new RegExp('(\\d{1,2})\\s*(?:तारीख|तारिख|को)' + NOT_AFTER))
      || t.match(/(\d{1,2})\s*(?:tarikh|tareekh|ko)(?![a-z])/);
    if (m) {
      const dd = +m[1];
      if (dd >= 1 && dd <= 31) {
        let d = new Date(today.getFullYear(), today.getMonth(), dd);
        if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, dd);
        return { date: d, evidence: `${dd} तारीख`, ev: `the ${dd}th`, matched: m[0] };
      }
    }
    // weekday, optionally prefixed with अगले / next
    const nextWeek = hasWord(t, 'अगले') || hasWord(t, 'अगला') || hasWord(t, 'agle') || hasWord(t, 'next');
    for (let i = 0; i < 7; i++) {
      const hit = hasAny(t, WEEKDAYS[i]);
      if (hit) {
        const raw = (i - today.getDay() + 7) % 7;
        let delta = raw === 0 ? 7 : raw;          // a bare weekday always means the next one
        if (nextWeek && raw !== 0) delta += 7;    // "अगले शनिवार" skips this week's
        return { date: addDays(today, delta), evidence: HI_DAYS[i], ev: EN_DAYS[i], matched: hit };
      }
    }
    if (hasWord(t, 'हफ्ते') || hasWord(t, 'hafte') || /this week|next week/.test(t)) {
      const n = nextWeek || /next week/.test(t) ? 7 : 1;
      return { date: addDays(today, n), evidence: n === 7 ? 'अगले हफ्ते' : 'इस हफ्ते', ev: n === 7 ? 'next week' : 'this week', fuzzy: true, matched: 'हफ्ते' };
    }
    return null;
  }

  const NUMWORDS = {
    'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12,
    'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'paanch': 5, 'panch': 5, 'chhe': 6, 'saat': 7, 'aath': 8, 'nau': 9, 'das': 10, 'gyarah': 11, 'barah': 12
  };

  function numAfter(t, idx) {
    const tail = t.slice(idx);
    const md = tail.match(/^\s*(\d{1,2})/);
    if (md) return +md[1];
    for (const [w, n] of Object.entries(NUMWORDS)) {
      if (new RegExp('^\\s*' + esc(w) + NOT_AFTER).test(tail)) return n;
    }
    return null;
  }

  function periodOf(t) {
    if (hasAny(t, ['सुबह', 'सवेरे', 'subah', 'savere', 'morning', 'am'])) return 'am';
    if (hasAny(t, ['दोपहर', 'dopahar', 'afternoon', 'noon'])) return 'noon';
    if (hasAny(t, ['शाम', 'sham', 'shaam', 'evening', 'pm'])) return 'pm';
    if (hasAny(t, ['रात', 'raat', 'night'])) return 'night';
    return null;
  }

  const PERIOD_HI = { am: 'सुबह', noon: 'दोपहर', pm: 'शाम', night: 'रात' };

  function applyPeriod(h, period) {
    if (period === 'am') return h === 12 ? 0 : h;
    if (period === 'noon' || period === 'pm' || period === 'night') return h < 12 ? h + 12 : h;
    if (h >= 1 && h <= 9) return h + 12;   // "5 बजे" at a shop means 5 pm
    return h;                               // 10, 11, 12 stay morning
  }

  function parseTime(t) {
    const period = periodOf(t);
    const pfx = period ? PERIOD_HI[period] + ' ' : '';
    let h = null, min = 0, evidence = null, ev = null, fuzzy = false;

    if (hasAny(t, ['डेढ़', 'डेढ', 'dedh'])) { h = 1; min = 30; evidence = 'डेढ़'; ev = '1:30'; }
    else if (hasAny(t, ['ढाई', 'dhai'])) { h = 2; min = 30; evidence = 'ढाई'; ev = '2:30'; }
    else {
      const frac = [
        [['साढ़े', 'साढे', 'sadhe', 'sade'], 30, 0, 'साढ़े'],
        [['सवा', 'sawa', 'sava'], 15, 0, 'सवा'],
        [['पौने', 'पौना', 'paune', 'pone'], 45, -1, 'पौने']
      ];
      for (const [words, mm, off, label] of frac) {
        const hit = hasAny(t, words);
        if (!hit) continue;
        const idx = t.indexOf(hit) + hit.length;
        const n = numAfter(t, idx);
        if (n !== null) { h = n + off; min = mm; evidence = `${label} ${n}`; ev = `${n + off}:${String(mm).padStart(2, '0')}`; break; }
      }
      if (h === null) {
        let m = t.match(/(\d{1,2}):(\d{2})/);
        if (m) { h = +m[1]; min = +m[2]; evidence = m[0]; ev = m[0]; }
        else if ((m = t.match(new RegExp('(\\d{1,2})\\s*बजकर\\s*(\\d{1,2})\\s*मिनट')))) { h = +m[1]; min = +m[2]; evidence = m[0]; ev = `${m[1]}:${m[2]}`; }
        else if ((m = t.match(new RegExp('(\\d{1,2})\\s*(?:बजे|baje|o\'?clock)' + NOT_AFTER)))) { h = +m[1]; evidence = m[0]; ev = `${m[1]} o'clock`; }
        else {
          for (const [w, n] of Object.entries(NUMWORDS)) {
            if (new RegExp('(?:^|[^' + WORDCH + '])' + esc(w) + '\\s*(?:बजे|baje)' + NOT_AFTER).test(t)) { h = n; evidence = `${w} बजे`; ev = `${n} o'clock`; break; }
          }
          if (h === null && period) {
            // a bare part of day: propose the middle of it rather than guessing
            h = { am: 11, noon: 13, pm: 17, night: 19 }[period];
            return { h, min: 0, evidence: PERIOD_HI[period], ev: period, fuzzy: true };
          }
          if (h === null) {
            const m2 = t.match(/(?:^|[^\d])(\d{1,2})(?![\d])/);
            if (m2 && +m2[1] >= 1 && +m2[1] <= 21) { h = +m2[1]; evidence = m2[1]; ev = m2[1]; fuzzy = true; }
          }
        }
      }
    }
    if (h === null) return null;
    const h24 = applyPeriod(h, period);
    if (h24 < 0 || h24 > 23 || min > 59) return null;
    return { h: h24, min, evidence: pfx + evidence, ev, fuzzy };
  }

  // Pain and its cousins mean the slot the patient asked for is the wrong question.
  const URGENT = ['दर्द', 'तेज़ दर्द', 'तेज दर्द', 'सूजन', 'खून', 'खून आ रहा', 'टूट गया', 'इमरजेंसी', 'अर्जेंट', 'बर्दाश्त नहीं',
    // an animal cannot report pain, so the owner reports behaviour instead
    'उल्टी', 'खा नहीं', 'खाना नहीं', 'खाना छोड़', 'लंगड़ा', 'लंगड़ाकर', 'सुस्त', 'बेहोश', 'दुर्घटना', 'गाड़ी से', 'ज़हर', 'जहर',
    'साँस', 'सांस फूल', 'दौरा', 'काट लिया',
    'pain', 'hurting', 'swelling', 'bleeding', 'broken', 'emergency', 'urgent',
    'vomiting', 'not eating', 'limping', 'lethargic', 'unconscious', 'accident', 'poison', 'seizure'];
  function parseUrgency(t) {
    const hit = URGENT.find(w => t.indexOf(w) >= 0);
    return hit ? { urgent: true, evidence: hit } : null;
  }

  // Teams do not book once, they book a standing slot.
  function parseRecurring(t) {
    if (!/हर|हर हफ्ते|every|weekly|रेगुलर|regular/.test(t)) return null;
    for (let i = 0; i < 7; i++) {
      for (const w of WEEKDAYS[i]) {
        if (new RegExp('(हर|every)\\s*' + esc(w)).test(t)) return { every: true, weekday: i, evidence: 'हर ' + HI_DAYS[i] };
      }
    }
    if (/हर हफ्ते|every week|weekly/.test(t)) return { every: true, weekday: null, evidence: 'हर हफ्ते' };
    return null;
  }

  function parseService(t, vertical) {
    let best = null, bestKw = null;
    for (const s of CATALOGUE[vertical].services) for (const k of s.kw) {
      if (t.includes(k) && (!bestKw || k.length > bestKw.length)) { best = s; bestKw = k; }
    }
    return best ? { service: best, evidence: bestKw } : null;
  }

  function parsePeople(t) {
    const units = ['लोग', 'लोगो', 'लोगों', 'जन', 'people', 'persons', 'person', 'log'];
    for (const u of units) {
      let m = t.match(new RegExp('(\\d{1,2})\\s*' + esc(u) + NOT_AFTER));
      if (m) return +m[1];
      for (const [w, n] of Object.entries(NUMWORDS)) {
        if (new RegExp('(?:^|[^' + WORDCH + '])' + esc(w) + '\\s*' + esc(u) + NOT_AFTER).test(t)) return n;
      }
    }
    return null;
  }

  function parse(input, opts) {
    const vertical = (opts && opts.vertical) || 'salon';
    const now = (opts && opts.now) || new Date();
    const t = normalize(input);

    let intent = null, intentEvidence = null;
    for (const [name, kws, stems] of INTENTS) {
      const hit = hasAny(t, kws) || (stems || []).find(s => t.includes(s));
      if (hit) { intent = name; intentEvidence = hit; break; }
    }

    const svc = parseService(t, vertical);
    const urg = NLU_KIND(vertical) === 'clinic' ? parseUrgency(t) : null;
    const rec = parseRecurring(t);
    const dt = parseDate(t, now);
    // strip the date phrase so "20/8" or "15 तारीख" is not also read as a time
    const tTime = dt && dt.matched ? t.split(dt.matched).join(' ') : t;
    const tm = parseTime(tTime);
    const people = parsePeople(t);

    // a bare "कल शाम 5" carries no verb but is plainly a booking attempt
    if ((!intent || intent === 'deny') && (svc || dt || tm || urg)) intent = 'book';
    if (!intent && hasAny(t, ['नमस्ते', 'नमस्कार', 'हेलो', 'हाय', 'namaste', 'hello', 'hi', 'hey'])) intent = 'greet';
    if (!intent) intent = 'unknown';

    const slots = {
      urgent: !!urg, urgentEvidence: urg ? urg.evidence : null,
      recurring: !!rec, recurringDay: rec ? rec.weekday : null, recurringEvidence: rec ? rec.evidence : null,
      service: svc ? svc.service : null,
      serviceEvidence: svc ? svc.evidence : null,
      date: dt ? dt.date : null,
      dateEvidence: dt ? dt.evidence : null,
      dateEn: dt ? dt.ev : null,
      dateFuzzy: !!(dt && dt.fuzzy),
      time: tm ? { h: tm.h, min: tm.min } : null,
      timeEvidence: tm ? tm.evidence : null,
      timeEn: tm ? tm.ev : null,
      timeFuzzy: !!(tm && tm.fuzzy),
      people
    };
    const filled = ['service', 'date', 'time'].filter(k => slots[k]).length;
    return { input, normalized: t, vertical, intent, intentEvidence, slots, filled };
  }

  // ---------- customer name, for merchant shorthand ----------
  // The shop owner speaks a whole booking in one breath: "रीना जी का हेयरकट कल शाम 5 बजे".
  // Everything the other extractors already claimed is stripped out; what survives is the name.
  const NAME_STOP = new Set(([
    'का', 'की', 'के', 'को', 'जी', 'और', 'है', 'हैं', 'हूँ', 'हूं', 'चाहिए', 'बुक', 'बुकिंग', 'करो', 'कर', 'दो', 'दीजिए', 'दीजिये',
    'नई', 'नया', 'नए', 'वाला', 'वाली', 'वाले', 'लिए', 'साथ', 'मिनट', 'बजे', 'बजकर', 'सुबह', 'शाम', 'दोपहर', 'रात', 'सवेरे',
    'आज', 'कल', 'परसों', 'तारीख', 'तारिख', 'हफ्ते', 'अगले', 'अगला', 'इस', 'उस', 'साढ़े', 'साढे', 'सवा', 'पौने', 'पौना', 'डेढ़', 'डेढ', 'ढाई',
    'एक', 'दो', 'तीन', 'चार', 'पांच', 'पाँच', 'छह', 'छः', 'सात', 'आठ', 'नौ', 'दस', 'ग्यारह', 'बारह',
    'लोग', 'लोगो', 'लोगों', 'जन', 'नाम', 'फ़ोन', 'फोन', 'नंबर', 'से', 'में', 'पर', 'तक', 'ही', 'भी', 'तो', 'अब', 'फिर', 'अपॉइंटमेंट', 'स्लॉट', 'टाइम', 'समय',
    'रविवार', 'रवि', 'इतवार', 'सोमवार', 'सोम', 'मंगलवार', 'मंगल', 'बुधवार', 'बुध', 'गुरुवार', 'गुरु', 'बृहस्पतिवार', 'शुक्रवार', 'शुक्र', 'शनिवार', 'शनि',
    'ka', 'ki', 'ke', 'ji', 'ko', 'aur', 'hai', 'book', 'booking', 'karo', 'kar', 'do', 'nayi', 'naya', 'liye', 'minute', 'baje', 'bajkar',
    'subah', 'savere', 'sham', 'shaam', 'raat', 'dopahar', 'aaj', 'kal', 'parso', 'parson', 'tarikh', 'tareekh', 'hafte', 'agle',
    'sadhe', 'sade', 'sawa', 'sava', 'paune', 'pone', 'dedh', 'dhai', 'ek', 'teen', 'char', 'paanch', 'panch', 'chhe', 'saat', 'aath', 'nau', 'das',
    'log', 'name', 'phone', 'number', 'for', 'at', 'on', 'the', 'and', 'am', 'pm', 'slot', 'time', 'appointment',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'next', 'week'
  ]));

  const NLU_KIND = v => (CATALOGUE[v] && CATALOGUE[v].kind) || 'retail';

  function extractName(input, vertical) {
    const t = normalize(input);
    let s = ' ' + t + ' ';
    for (const svc of CATALOGUE[vertical || 'salon'].services)
      for (const k of svc.kw) if (s.indexOf(k) >= 0) s = s.split(k).join(' ');
    const toks = s.split(/\s+/).filter(Boolean)
      .filter(w => !/\d/.test(w) && w.length >= 2 && !NAME_STOP.has(w));
    if (!toks.length) return null;
    return toks.slice(0, 3).join(' ');
  }

  function fmtDateHi(d) { return `${HI_DAYS[d.getDay()]}, ${d.getDate()} ${HI_MONTHS[d.getMonth()]}`; }
  function fmtDateEn(d) { return `${EN_DAYS[d.getDay()]}, ${d.getDate()} ${EN_MONTHS[d.getMonth()]}`; }
  function fmtTimeHi(h, m) {
    const per = h < 12 ? 'सुबह' : h < 16 ? 'दोपहर' : h < 20 ? 'शाम' : 'रात';
    return `${per} ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')}`;
  }
  function fmtTimeEn(h, m) {
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  }

  return { parse, normalize, extractName, CATALOGUE, fmtDateHi, fmtDateEn, fmtTimeHi, fmtTimeEn, ymd, addDays, HI_DAYS, EN_DAYS, HI_MONTHS, EN_MONTHS };
})();

if (typeof module !== 'undefined') module.exports = NLU;
