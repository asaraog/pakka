# Pakka

Customers book on WhatsApp, in Hindi. You approve 'Yes' with one tap. The
advance goes to **your own UPI id** — this software records but never touches your money.

---

## Before you start

You need three things:

**1. A spare phone number that has never had WhatsApp on it.**
A cheap prepaid SIM is fine. It must be able to receive one SMS or one phone
call. I recommend getting a new SIM card.

> **Do not use your existing WhatsApp Business number.** Putting a number on the
> API removes the WhatsApp Business app from your phone and takes your chat
> history with it. There is a way to run both on one number, but Meta only
> offers it to its partner companies.

**2. A Facebook account.** A personal one is fine. Nothing gets posted.

**3. Somewhere to run it.** Render costs about ₹600/month and is the path below.
Any other server that can run Node with a real HTTPS certificate works.

### Check the code runs before touching Meta

```bash
git clone https://github.com/asaraog/pakka
cd pakka
node test.js
```

You should see a list of `PASS` lines ending in `21/21 passed`. That is the
booking flow running end to end with WhatsApp faked out. No account, no internet,
no keys.

---

## Step 1 — Make a server

Meta will only deliver messages to a public address with a valid HTTPS
certificate. Your laptop does not qualify.

1. Push your copy of this repository to your own GitHub account.
2. Go to [render.com](https://render.com), sign up, and choose
   **New → Blueprint**.
3. Select your repository. Render reads `render.yaml` and configures itself.
4. When prompted for environment variables, set **`WA_VERIFY_TOKEN`** to any word
   you invent. Write it down — you type the same word into Meta in Step 5.
5. Choose the **Starter** plan, about ₹600/month.


## Step 2 — Create the Meta app

1. Go to [developers.facebook.com](https://developers.facebook.com) and log in
   with your Facebook account.
2. **My Apps** (top right) → **Create App**.
3. It asks what you want to build. Choose the option for **business** /
   *Other* → **Business** if it offers a two-stage choice.
4. Give it any name. This name is internal and customers never see it.
5. On the app dashboard, find **WhatsApp** in the product list and click
   **Set up**.

Meta will create a test number for you automatically. **Ignore it.** 

## Step 3 — Add your real number

1. On that same **API Setup** page, click **Add phone number**.
2. Fill in a display name (customers *do* see this — use your venue's name), your
   category, and your number.
3. Choose **Text message** or **Phone call** for verification and enter the code.

Now copy two values from the API Setup page and paste them somewhere:

| What | Where | Looks like |
|---|---|---|
| **Phone number ID** | under the "From" dropdown, after you select your number | `109xxxxxxxxxxx` — about 15 digits |
| **WhatsApp Business Account ID** | on the same page, often labelled *WABA ID* | another long number |

## Step 4 — Get an access token

1. Go to [business.facebook.com](https://business.facebook.com) →
   **Business settings** (gear icon).
2. In the left menu: **Users → System users**.
3. **Add** → give it any name → role **Admin** → create.
4. With your new system user selected, click **Assign assets**.
5. Choose **WhatsApp accounts** (not Apps, not Pages) → tick your WhatsApp
   Business Account → turn on **Full control** → **Save changes**.
6. Click **Generate new token**.
7. Pick the app you created in Step 2.
8. Set **Token expiration** to **Never**.
9. Tick exactly these two permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
10. Generate, then **copy the token immediately**. It is shown once and never
    again. If you lose it, generate another. It starts with `EAA`.

Now put it where the server can read it: in Render, open your service →
**Environment** → add **`WA_TOKEN`** with the token as its value. Do the same for
**`WA_PHONE_ID`** with the Phone number ID from Step 3.

> **Never paste a token into `venues.js`.** That file gets committed, and a fork
> of a public repo is public. It reads `process.env.WA_TOKEN` for exactly this
> reason, so the file stays safe to push and the secret stays on your server.

## Step 5 — Connect Meta to your server

1. Back in your Meta app: **WhatsApp → Configuration**.
2. Next to *Webhook*, click **Edit**.
3. **Callback URL:** `https://your-app.onrender.com/webhook`
   (your Render address, with `/webhook` on the end)
4. **Verify token:** the same word you set as `WA_VERIFY_TOKEN`.
5. **Verify and save.**
6. Now click **Manage** next to *Webhook fields* and subscribe to **`messages`**.
   Only that one. Leave everything else off.

## Step 6 — Describe your venue

```bash
node onboard.js
```

It asks about your hours, what is bookable, your sports and rates, and how much
advance you take. It also asks for your existing business WhatsApp number and existing UPI ID.

Write the Hindi the way your customers actually say it, not the way it is written
formally. If they say `बॉक्स क्रिकेट`, put that.

You can also edit `venues.js` by hand. Commit and push.

## Step 7 — Prove it works

1. From your own phone, message the bot's number. It should reply in Hindi.
2. Book something: `कल 8 बजे क्रिकेट`
3. You, as owner, get a message with **✓ पक्का** and **✗ नहीं**. Tap **✓ पक्का**.
4. The customer gets a payment link. Open it and check it shows **your** UPI id
   and the right amount.

---

## Getting paid without watching for it

Money always goes straight to your UPI id. The only question is how the bot finds
out it arrived.

The simplest version needs no setup at all: when your bank or UPI app messages
you that money came in, **forward that message to your own bot**. It reads the
amount and reference and confirms the booking.

[PAYMENTS.md](PAYMENTS.md) covers automating that, so you do not even forward.

## Saying something in your own words

The bot answers customers, but you can speak through it:

```
you → bot:      राहुल को बोल दो कि लाइट ठीक हो गई
bot → राहुल:    लाइट ठीक हो गई
```

Use a name, a phone number, or a booking number. If two customers share a name it
messages **neither** of them and asks which you meant — a message on the wrong
phone cannot be taken back.

## Optional: better Hindi

Set `SARVAM_KEY` from [sarvam.ai](https://www.sarvam.ai/) in Render's environment
variables and three things improve: messy or roundabout messages get understood
instead of refused, you can ask your own bot questions like
`इस हफ्ते कितनी कमाई हुई?`, and payment screenshots get read so your confirmation
arrives pre-filled.

Everything works without it. The built-in parser handles ordinary bookings.

## What it will not do

**You cannot message a customer who has not written to you in the last 24
hours.** That is WhatsApp's rule for every business on the platform, not a
limitation of this software. Inside that window you can say anything; outside it
Meta requires a pre-approved template. The bot tells you when this happens rather
than failing quietly.

There is no dashboard, no website, no bulk messaging. Everything happens inside
WhatsApp, which is the point.

## Your data

Everything lives in one file, `baari.json`, on your server's disk. Open it, read
it, copy it somewhere safe now and then. There is no account, no cloud, and
nobody to ask.

## What it costs

| | |
|---|---|
| This software | free |
| WhatsApp Cloud API | free — Meta charges nothing to host it |
| Messages | free within 24h of a customer writing to you |
| Render Starter | ~₹600/month |

Every message in a booking is a reply to a customer who just wrote in, so in
normal use Meta bills you nothing at all.

---

BSD 3-Clause. See [LICENSE](LICENSE).
