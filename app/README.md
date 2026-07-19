# Replayable — missed-call text-back engine

The software behind Replayable. When a customer calls one of your clients and the
call isn't answered, Replayable automatically texts the caller back so the lead
isn't lost — then gives your client a dashboard to manage the conversation.

**Zero dependencies.** Runs on plain Node.js 22+ (uses the built-in `node:sqlite`
and `fetch`). No `npm install`, no build step, no database server.

---

## Quick start

```bash
cd app
node server.js
```

Open **http://localhost:3000**. It boots in **SIMULATION mode** with a demo client
("Dave's Plumbing") already set up.

Try it:
1. Click **“Simulate missed call”** — a lead appears and the auto-text is sent.
2. Click **“Simulate their reply”** — the customer's reply lands in the conversation.
3. Open the lead, reply, and mark it **won**.

That's the entire live flow — with no Twilio account and nothing to pay.

---

## How it works

```
Customer calls  ──►  Twilio number  ──►  /webhooks/voice
                                          rings the owner's real phone first
                                            │
                            owner answers ──┘ (nothing happens — normal call)
                                            │
                        owner misses it  ──►  /webhooks/voice-status
                                              auto-text sent to caller  ──►  Customer's phone
                                            │
                     customer replies    ──►  /webhooks/sms
                                              shows in dashboard, owner replies
```

The **simulator** and the **real Twilio webhooks** call the exact same
`handleMissedCall()` logic, so what you test is what goes live.

---

## Going live with Twilio

Simulation is free but only logs texts. To send real SMS:

1. Create a [Twilio](https://www.twilio.com) account and buy a UK phone number.
2. Copy `.env.example` to `.env` and set:
   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token
   ADMIN_PASSWORD=something_strong
   ```
3. In the Twilio number's config:
   - **Voice → A call comes in →** Webhook `POST https://YOUR_HOST/webhooks/voice`
   - **Messaging → A message comes in →** Webhook `POST https://YOUR_HOST/webhooks/sms`
4. In the dashboard, open **Settings** for each client and set:
   - **Owner's phone** — the real mobile that should ring first.
   - **Twilio number** — the number you bought for them.
5. Restart. The badge flips to **LIVE** and texts are really sent.

Each client gets their own Twilio number; Replayable routes calls to the right
business by the number that was dialled.

> **Call forwarding option:** instead of giving clients a new number, they can keep
> their existing one and set *conditional call forwarding* (forward-when-unanswered)
> to their Twilio number. Then nothing changes for their customers.

---

## Security notes (before hosting publicly)

- Always set `ADMIN_PASSWORD` — without it the dashboard is open.
- Verify Twilio webhook signatures (the `X-Twilio-Signature` header) so only Twilio
  can hit `/webhooks/*`. This MVP trusts the endpoints; add signature checking
  before taking real traffic.
- Put it behind HTTPS (any host — Render, Railway, Fly.io, a VPS — works).

---

## Files

| Path | What it does |
|------|--------------|
| `server.js` | HTTP server: Twilio webhooks + REST API + static dashboard |
| `lib/config.js` | Loads `.env`, decides live vs simulation |
| `lib/store.js` | `node:sqlite` schema + queries |
| `lib/telephony.js` | Twilio SMS (via `fetch`) + TwiML, with simulation fallback |
| `lib/logic.js` | Core missed-call / inbound-SMS / reply logic |
| `public/` | The dashboard (HTML/CSS/JS) |
| `data/replayable.db` | SQLite database (created on first run) |

Data lives in `data/replayable.db`. Delete it to reset.
