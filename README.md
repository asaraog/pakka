# Pakka

Customers book on WhatsApp, in Hindi. You approve 'Yes' with one tap. The
advance goes to **your own UPI id** — this software records but never touches
your money. Booking, approval, advance, and a confirmation the moment your
bank tells you it arrived, all in one place.

Built for sports venues — the examples below are grounds, courts, cricket. The
same pattern fits any appointment-based business that takes an advance before
the slot: clinics, salons, coaching classes, rental equipment. Edit `venues.js`
to describe your own business instead of a turf.

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

### Fork it first

**Fork** this repository to your own GitHub account (one button, top right).
Do this before the Meta steps — everything from here on, including editing
`venues.js`, happens in your fork, and it's the one that actually deploys.

```bash
git clone https://github.com/YOUR-USERNAME/pakka
cd pakka
node test.js
```

You should see a list of `PASS` lines ending in `21/21 passed`. That is the
booking flow running end to end with WhatsApp faked out. No account, no internet,
no keys.

---

## Step 1 — Create the Meta app

1. Go to [developers.facebook.com](https://developers.facebook.com) and log in
   with your Facebook account.
2. **My Apps** (top right) → **Create App**.
3. It asks what you want to build. Choose the option for **business** /
   *Other* → **Business** if it offers a two-stage choice.
4. Give it any name. This name is internal and customers never see it.
5. On the app dashboard, find **WhatsApp** in the product list and click
   **Set up**.

Meta will create a test number for you automatically. **Ignore it.**

## Step 2 — Add your real number

1. On that same **API Setup** page, click **Add phone number**.
2. Fill in a display name (customers *do* see this — use your venue's name), your
   category, and your number.
3. Choose **Text message** or **Phone call** for verification and enter the code.

Now copy two values from the API Setup page and paste them somewhere:

| What                                   | Where                                                   | Looks like                            |
| -------------------------------------- | ------------------------------------------------------- | ------------------------------------- |
| **Phone number ID**              | under the "From" dropdown, after you select your number | `109xxxxxxxxxxx` — about 15 digits |
| **WhatsApp Business Account ID** | on the same page, often labelled*WABA ID*             | another long number                   |

## Step 3 — Get an access token

1. Go to [business.facebook.com](https://business.facebook.com) →
   **Business settings** (gear icon).
2. In the left menu: **Users → System users**.
3. **Add** → give it any name → role **Admin** → create.
4. With your new system user selected, click **Assign assets**.
5. Choose **WhatsApp accounts** (not Apps, not Pages) → tick your WhatsApp
   Business Account → turn on **Full control** → **Save changes**.
6. Click **Generate new token**.
7. Pick the app you created in Step 1.
8. Set **Token expiration** to **Never**.
9. Tick exactly these two permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
10. Generate, then **copy the token immediately**. It is shown once and never
    again. If you lose it, generate another. It starts with `EAA`.

Keep it somewhere for a moment — Step 5 puts it in place.

> **Never paste a token into a file in the repo.** A fork of a public repository
> is public. Everything private — your token, your WhatsApp number, your UPI id —
> goes into Render's environment in Step 5, and never into git.

## Step 4 — Describe your venue

Open `venues.js`, in your fork, and edit it directly — name, hours, grounds,
rates, how much advance you take. Nothing in there is private, so it's safe on
a public fork.

Five fields stay blank in the file on purpose, because those five *are*
private. Set them as environment variables instead, locally for now and in
Render in Step 5:

| Field | Env var | What it is |
|---|---|---|
| `waPhoneId` | `WA_PHONE_ID` | Meta's ID for your bot's number (Step 2) — not your phone number |
| `waToken` | `WA_TOKEN` | your permanent access token (Step 3) — whoever has this can send as your bot |
| `wabaId` | `WABA_ID` | your WhatsApp Business Account ID (Step 2) |
| `ownerPhone` | `OWNER_PHONE` | your own WhatsApp, digits + country code, no `+` — anything from this number is treated as you, the owner |
| `vpa` | `VENUE_VPA` | your existing UPI id — customer advances land here directly |

Then check they actually work:

```bash
node check.js
```

It fails in seconds if a value is wrong, rather than leaving you to find out
when nothing sends.

**Prefer answering questions to hand-editing?**

```bash
node check.js --interview
```

Same live checks, then asks about your hours and rates and prints everything
ready to paste — the five env values, and a `venues.js` block for the rest.

Commit what you edited: `git add venues.js && git commit -m "my venue"`.

## Step 5 — Make a server

Meta will only deliver messages to a public address with a valid HTTPS
certificate. Your laptop does not qualify.

1. Push the edits from Step 4, if you haven't: `git push`.
2. Go to [render.com](https://render.com), sign up, and choose
   **New → Blueprint**.
3. Select your fork. Render reads `render.yaml` and configures itself.
4. When prompted for environment variables, paste in the five values Step 4
   printed or checked: **`WA_PHONE_ID`**, **`WA_TOKEN`**, **`WABA_ID`**,
   **`OWNER_PHONE`**, **`VENUE_VPA`**. Also set **`WA_VERIFY_TOKEN`** to any
   word you invent — write it down, you type the same word into Meta in Step 6.
5. Choose the **Starter** plan, about ₹600/month.

## Step 6 — Connect Meta to your server

1. Back in your Meta app: **WhatsApp → Configuration**.
2. Next to *Webhook*, click **Edit**.
3. **Callback URL:** `https://your-app.onrender.com/webhook`
   (your Render address, with `/webhook` on the end)
4. **Verify token:** the same word you set as `WA_VERIFY_TOKEN`.
5. **Verify and save.**
6. Now click **Manage** next to *Webhook fields* and subscribe to **`messages`**.
   Only that one. Leave everything else off.

## Step 7 — Prove it works

1. From your own phone, message the bot's number. It should reply in Hindi.
2. Book something: `कल 8 बजे क्रिकेट`
3. You, as owner, get a message with **✓ पक्का** and **✗ नहीं**. Tap **✓ पक्का**.
4. The customer gets a payment link. Open it and check it shows **your** UPI id
   and the right amount.

---

## Getting paid without watching for it

The advance goes straight to your UPI id — this software is never in the middle
of it. The only question is how the bot learns the money arrived.

**Forward the message.** Your bank or UPI app already texts you when money comes
in. Forward that message to your own bot on WhatsApp. It reads the amount and
the reference, matches it against the booking waiting for exactly that sum in
the last twenty minutes, and confirms it. The customer is told immediately.

Nothing to install, no account to open, no integration. It works from the first
day for every merchant, whichever bank or app they use.

Three things it will not do, all deliberate:

- **A customer's screenshot never confirms anything.** A screenshot is the
  payer's claim about their own payment, and apps exist in India that
  manufacture them. Only a message from *your* bank settles a booking.
- **Your own spending is ignored.** Forward a payment you made and nothing
  happens — the parser reads direction, and Indian bank messages routinely name
  both sides of a transfer.
- **Two bookings owing the same amount settle neither.** You are asked instead.
  A wrongly confirmed booking costs a real slot on a real evening.

If it cannot match a forward, it says so and changes nothing.

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

|                    |                                              |
| ------------------ | -------------------------------------------- |
| This software      | free                                         |
| WhatsApp Cloud API | free — Meta charges nothing to host it      |
| Messages           | free within 24h of a customer writing to you |
| Render Starter     | ~₹600/month                                 |

Every message in a booking is a reply to a customer who just wrote in, so in
normal use Meta bills you nothing at all.

---

BSD 3-Clause. See [LICENSE](LICENSE). Use it for whatever you like, including
commercially.

Built on Pakka by Apoorv Saraogee. If you run this as a service, a credit and a
link back are appreciated.
