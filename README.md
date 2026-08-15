# Pakka

Customers book your turf on WhatsApp, in Hindi. You approve with one tap. The
advance goes to **your own UPI id** — this software never touches your money.

Node 18 or newer. No libraries to install.

**This guide assumes nothing.** Every screen is named, every value is described
so you can tell whether you copied the right one, and each step ends with
something you can check before moving on. Most of the difficulty is Meta's
console, not this code.

---

## Before you start

You need three things. Get them first; stopping halfway through Meta's setup is
where people lose an evening.

**1. A spare phone number that has never had WhatsApp on it.**
A cheap prepaid SIM is fine. It must be able to receive one SMS or one phone
call, once. After that it can sit in a drawer forever.

> **Do not use your existing WhatsApp Business number.** Putting a number on the
> API removes the WhatsApp Business app from your phone and takes your chat
> history with it. There is a way to run both on one number, but Meta only
> offers it to its partner companies, not to you. A new number avoids the whole
> problem, and your existing number carries on exactly as it does today.

**2. A Facebook account.** A personal one is fine. Nothing gets posted.

**3. Somewhere to run it.** Render costs about ₹600/month and is the path below.
Anything that can run Node with a real HTTPS certificate works.

### Check the code runs before touching Meta

```bash
git clone https://github.com/asaraog/pakka
cd pakka
node test.js
```

You should see a list of `PASS` lines ending in `21/21 passed`. That is the
booking flow running end to end with WhatsApp faked out. No account, no internet,
no keys.

To run every suite at once: `npm test` (npm comes with Node). You should get
`190` passes in total across six files. This is optional — it proves the code is
healthy, it is not part of setup.

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

> Do not choose the free plan. It puts your server to sleep when idle, so the
> first customer of the day waits about fifty seconds for a reply, and it has no
> permanent disk — every restart deletes all your bookings, silently.

**Checkpoint:** open `https://your-app.onrender.com/health` in a browser. You
should see `{"ok":true,"venues":["CHAMPION"]}`. If you see that, your server is
alive and reachable.

## Step 2 — Create the Meta app

1. Go to [developers.facebook.com](https://developers.facebook.com) and log in
   with your Facebook account.
2. **My Apps** (top right) → **Create App**.
3. It asks what you want to build. Choose the option for **business** /
   *Other* → **Business** if it offers a two-stage choice.
4. Give it any name. This name is internal and customers never see it.
5. On the app dashboard, find **WhatsApp** in the product list and click
   **Set up**.

Meta will create a test number for you automatically. **Ignore it.** It can only
message a handful of pre-approved numbers and it is not yours.

**Checkpoint:** you are on a page called **API Setup** (sometimes *Getting
Started*), showing a "From" phone number dropdown and a temporary access token.

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

> The Phone number ID is **not** your phone number. If what you copied looks like
> `919876543210`, you have the wrong value.

**Checkpoint:** your number is listed on API Setup and shows as connected.

## Step 4 — Get a token that does not expire

The access token shown on API Setup **expires in 24 hours**. If you use it, your
bot works today and is dead tomorrow, mid-booking, with no warning. Make a
permanent one instead.

1. Go to [business.facebook.com](https://business.facebook.com) →
   **Business settings** (gear icon).
2. In the left menu: **Users → System users**.
3. **Add** → give it any name → role **Admin** → create.

Now the step everyone skips:

4. With your new system user selected, click **Assign assets**.
5. Choose **WhatsApp accounts** (not Apps, not Pages) → tick your WhatsApp
   Business Account → turn on **Full control** → **Save changes**.

> Skip this and everything still looks fine. The token generates, it passes
> validation, and then the server cannot see your phone number and nothing works.
> This is the single most common cause of "I set it all up and nothing happens".

6. Click **Generate new token**.
7. Pick the app you created in Step 2.
8. Set **Token expiration** to **Never**.
9. Tick exactly these two permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
10. Generate, then **copy the token immediately**. It is shown once and never
    again. If you lose it, generate another.

**Checkpoint:** you now have three values written down — Phone number ID, WABA
ID, and a token starting with `EAA`.

## Step 5 — Connect Meta to your server

**Your server must already be running.** Meta calls it the instant you click
Verify, and the whole form fails if nobody answers.

1. Back in your Meta app: **WhatsApp → Configuration**.
2. Next to *Webhook*, click **Edit**.
3. **Callback URL:** `https://your-app.onrender.com/webhook`
   (your Render address, with `/webhook` on the end)
4. **Verify token:** the same word you set as `WA_VERIFY_TOKEN` in Step 1.
5. **Verify and save.**
6. Now click **Manage** next to *Webhook fields* and subscribe to **`messages`**.
   Only that one. Leave everything else off.

> That last substep is not optional. Saving the webhook without subscribing to `messages`
> is the second most common cause of "nothing happens" — Meta accepts the URL and
> then never sends anything to it.

## Step 6 — Describe your venue

```bash
node onboard.js
```

It checks your token and phone number *first*, so a wrong value fails in the
first thirty seconds rather than after you have answered twenty questions. Then
it asks about your hours, what is bookable, your sports and rates, and how much
advance you take.

Two answers decide whether any of this works:

- **Your own WhatsApp number**, with country code and no `+`, like
  `919876543210`. Any message from this number is treated as *you*, the owner.
  One wrong digit and you will receive your customers' replies while they receive
  nothing.
- **Your existing UPI id**, like `yourturf@okhdfcbank`. Do not create a new one.
  Customers pay this directly and the money never passes through this software.

Write the Hindi the way your customers actually say it, not the way it is written
formally. If they say `बॉक्स क्रिकेट`, put that.

You can also edit `venues.js` by hand — it is one plain object, commented.

Then commit and push. Render redeploys on its own.

## Step 7 — Prove it works

1. From your own phone, message the bot's number. It should reply in Hindi.
2. Book something: `कल 8 बजे क्रिकेट`
3. You, as owner, get a message with **✓ पक्का** and **✗ नहीं**. Tap **✓ पक्का**.
4. The customer gets a payment link. Open it and check it shows **your** UPI id
   and the right amount. Do not pay it.

If that all worked, you are done.

### Nothing came back

Work down this list in order. It is almost always one of these.

| Symptom | Cause |
|---|---|
| No reply at all | Webhook not subscribed to **`messages`** (Step 5, last substep) |
| Server logs show an error reading the phone number | **Assign assets** skipped (Step 4.4) |
| Worked yesterday, dead today | You used the 24-hour token instead of a permanent one |
| Bot replies to you as if you were a customer | Your number in `venues.js` is wrong or missing the country code |
| Bot never replies to you as owner | Same — check `ownerPhone` digit by digit |
| Replies take ~50 seconds | You are on Render's free plan |
| Bookings disappear | Also the free plan — no disk |

Render's **Logs** tab shows everything the server prints, which is usually enough
to tell which of these it is.

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
