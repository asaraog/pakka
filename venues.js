/* Your venue. Edit this file directly, on GitHub or on your own machine — it
   holds no secrets, so it is safe to commit, and safe on a public fork.

   Everything private or identifying — your token, your WhatsApp number, your
   UPI id — comes from environment variables instead, set once in Render ->
   Environment (or your shell, if running locally). `node onboard.js` checks
   them live and prints exactly what to paste in.

     WA_PHONE_ID   Phone number ID, from Meta's API Setup screen
     WA_TOKEN      a System User token with expiry Never
     WABA_ID       your WhatsApp Business Account ID
     OWNER_PHONE   your own WhatsApp, digits + country code, no +
     VENUE_VPA     your existing UPI id — do not create a new one

   Everything else below — name, hours, grounds, services, rates — is exactly
   what customers see, so it is meant to be edited freely and committed.

   Inbound messages are routed by waPhoneId, which Meta puts in every webhook,
   so `code` is only used for the optional wa.me deep link. */

module.exports = [
  {
    code: 'CHAMPION',
    waPhoneId: process.env.WA_PHONE_ID || '000000000000000',
    wabaId: process.env.WABA_ID || '',
    waToken: process.env.WA_TOKEN || '',
    ownerPhone: process.env.OWNER_PHONE || '9198XXXXXXXX',
    vpa: process.env.VENUE_VPA || 'championarena@okhdfcbank',

    name: 'चैंपियन स्पोर्ट्स एरिना',
    nameEn: 'Champion Sports Arena',
    payeeName: 'Champion Sports Arena',   // shown in the customer's UPI app

    /* Sarvam AI. Needs SARVAM_KEY set on the server; `ai: false` switches back
       to pure-regex. What it adds:
         customer side - messy/conversational messages get understood or answered
         owner side    - ask your business questions in Hindi ("इस हफ्ते कमाई?")
       It interprets and reports only: bookings still confirm through the same
       approval buttons, prices come from this file, money is never touched. */
    ai: true,

    open: 6, close: 23,
    off: -1,                           // weekly closed day, -1 for never
    peakFrom: 17, peakTo: 23, peakMult: 1.5,
    depositPct: 0.3, depositMin: 200, depositMax: 500,
    grounds: [
      { id: 'g1', hi: 'ग्राउंड 1' },
      { id: 'g2', hi: 'ग्राउंड 2' },
      { id: 'c1', hi: 'बैडमिंटन कोर्ट' }
    ],
    // which grounds each sport can use; omit to allow all
    services: [
      { id: 'cricket', hi: 'बॉक्स क्रिकेट', price: 1200, mins: 60, grounds: ['g1', 'g2'] },
      { id: 'football', hi: 'फुटबॉल', price: 1200, mins: 60, grounds: ['g1', 'g2'] },
      { id: 'badminton', hi: 'बैडमिंटन', price: 400, mins: 60, grounds: ['c1'] },
      { id: 'pickle', hi: 'पिकलबॉल', price: 600, mins: 60, grounds: ['c1'] }
    ]
  }
];
