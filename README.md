# ChaseBot: get paid without the awkward emails

**An AI accounts-receivable agent for freelancers, built on PayPal Invoicing and Claude.**

You describe a job in your own words and ChaseBot turns it into a PayPal invoice. When the client pays late, an agent reads that client's payment history and decides what to do next: a friendly nudge, a firmer reminder, splitting the bill into instalments, or handing it back to you to make a call. Everything it sends goes out through PayPal, and it stops as soon as PayPal reports the invoice paid.

> Built for the PayPal AI Hackathon 2026 · [Demo video](#) · [Live demo](#)

---

## The problem

Freelancers and micro-businesses do the work and then wait to be paid. Late payment is the top cash-flow problem for sole traders. In the UK alone, small businesses are owed billions in late payments at any time. Chasing is awkward ("will this annoy my best client?"), takes time, and keeps getting put off, which makes it worse. Accounting suites can send reminders, but those are fixed templates on a fixed schedule. They don't know that Sam always pays the day after a nudge, that Jordan only pays after a final notice, or that a small charity might need to pay in instalments.

## What ChaseBot does

| | |
|---|---|
| **✦ Plain words → PayPal invoice** | Type "6h logo work for Sam at Acme, £40/h, plus £15 fonts, 14 days", or attach a screenshot of a timesheet. Claude extracts clean line items (hours, quantities, flat fees), matches the client you already have, notes what it assumed (e.g. "No VAT added"), and you send it as a real PayPal invoice in one click. |
| **✦ Chase agent** | For each overdue invoice, a Claude agent with tools looks up the client's history (amounts, days late, which reminders worked before) and chooses **one** action: `send_reminder` (friendly → firm → final), `offer_payment_plan`, `escalate_to_owner`, then `schedule_next_check`. It explains every decision in plain English. |
| **Human in the loop** | With **Autopilot off**, anything sent to a client is a proposal in the *Agent inbox*. You can edit the message, then approve (it goes out through PayPal) or dismiss it. Switch Autopilot on and the agent sends things itself. |
| **Payment plans** | The agent can cancel an invoice the client is struggling with and replace it with 2–4 PayPal instalment invoices, each with its own due date and Pay Now button. |
| **Stops when paid** | PayPal webhooks (`INVOICING.INVOICE.PAID`, etc.) and a polling fallback mark the invoice paid and end the chase. |
| **Guardrails** | At most one client-facing action per run. No threats of fees or legal action. A minimum gap between reminders. After a final notice is ignored, or ~45 days overdue, the agent hands the invoice to you instead of sending more emails. |
| **Demo clock** | Use the `+7d` / `+14d` buttons to move time forward and see a whole chase play out in a few minutes. |

## How PayPal is used

All PayPal calls are in [`server/paypal.js`](server/paypal.js), against the **sandbox**:

| PayPal API | Used for |
|---|---|
| OAuth 2.0 client credentials (`/v1/oauth2/token`) | App authentication, token cached until expiry |
| Invoicing v2: `generate-next-invoice-number`, `POST /invoices` | Creating invoices from the AI draft |
| Invoicing v2: `/invoices/{id}/send` | Emailing the invoice with a Pay Now link |
| Invoicing v2: `GET /invoices/{id}` | Status sync (SENT → PAID, etc.) |
| Invoicing v2: `/invoices/{id}/remind` | Delivering the agent's reminder messages |
| Invoicing v2: `/invoices/{id}/cancel` | Cancelling the original invoice when it is replaced by a payment plan |
| Invoicing v2: `/invoices/{id}/payments` | Recording payments made outside PayPal (e.g. bank transfer) |
| Webhooks + `/v1/notifications/verify-webhook-signature` | Learning instantly when an invoice is paid, with verified signatures |

## How AI is used (tools)

| Tool | How it's used |
|---|---|
| **Claude Opus 5.5** (`claude-opus-5-5`) via the Anthropic TypeScript/JS SDK | **Extraction** ([`server/ai.js`](server/ai.js) → `extractDraft`): structured outputs with a Zod schema turn free text and/or an image (vision) into typed invoice line items. Low effort, because it's a simple task. |
| | **Chase agent** (`runChaseAgent`): a manual tool-use loop with five strict-schema tools. The agent calls `get_client_history` first, then picks an action. Customer-facing tools are gated in code: limited to one per run, and queued for approval unless Autopilot is on. Server-side refusal fallbacks are enabled. |
| **Claude Code** | Used as a pair programmer while building the project. |

## Architecture

```
Browser (vanilla JS dashboard)
   │  fetch /api/*
Express server ── store.js (JSON file: clients, invoices, timeline, settings)
   ├── ai.js ──────────► Anthropic Messages API (extraction + agent loop)
   │      └── tools ──► invoices.js ──► paypal.js ──► PayPal REST (sandbox)
   └── /api/webhooks/paypal ◄──────────── PayPal webhooks (verified)
```

## Run it locally

Requires **Node 20+**.

```bash
git clone <this repo> chasebot && cd chasebot
npm install
cp .env.example .env     # then fill in the values below
npm run dev              # http://localhost:3000
```

**`.env` values**

1. `ANTHROPIC_API_KEY`: from the [Anthropic Console](https://console.anthropic.com).
2. `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: on [developer.paypal.com](https://developer.paypal.com), go to **Apps & Credentials → Sandbox → Create App** (a Merchant app).
3. `DEMO_CLIENT_EMAIL` (recommended): the email of your **sandbox personal account** (Testing Tools → Sandbox Accounts). The demo clients are given `+alias` versions of it, so invoices reach a buyer account you can log in to and pay with.
4. `PAYPAL_WEBHOOK_ID` (optional, needs a public URL): in your sandbox app, add a webhook to `https://<your-host>/api/webhooks/paypal` for the `Invoicing` events and paste its ID here. Without it, ChaseBot polls PayPal every 30 seconds instead.

No PayPal keys yet? Set `PAYPAL_MOCK=true` to use a local imitation of the Invoicing API (the UI shows a "Mock PayPal" badge). It's only meant for offline development.

## Try the demo flow

1. Click **Brightside subcontract** under *Bill a client*, then **Draft with AI**. Check the draft and click **Create & send PayPal invoice**.
2. Click **+14d** twice on the demo clock. The invoice is now overdue.
3. Click **Chase overdue invoices**. Jordan has paid late twice before, so the agent skips the friendly nudge and proposes a firm reminder, and explains why.
4. Edit the message if you like, then **Approve & send via PayPal**.
5. Open the invoice → **Open in PayPal ↗**, log in as your sandbox buyer and pay. Then **↻ Sync** (or wait for the webhook) and the invoice turns *Paid* and the chase stops.
6. Try the **Nimbus report** example to see the agent suggest instalments for a cash-strapped charity, and keep moving the clock forward on an unpaid invoice to see it escalate to you.

**Settings → Reset demo data** restores the seeded clients and history. Invoices already in PayPal are not deleted.

## Deploy on Render

The repo includes a [`render.yaml`](render.yaml) blueprint. Create a **New → Blueprint** from this repo and fill in the secret environment variables. Then point a PayPal sandbox webhook at `https://<service>.onrender.com/api/webhooks/paypal`. On the free plan the JSON data file is lost on restart, and the app re-seeds the demo data automatically.

## Project layout

```
server/index.js     HTTP routes, autopilot sweep, webhook endpoint
server/paypal.js    PayPal REST client (+ mock for offline dev)
server/invoices.js  create / sync / remind / payment-plan operations
server/ai.js        Claude extraction + chase agent loop and tools
server/store.js     JSON persistence, demo clock, derived fields
scripts/seed-data.js demo clients with realistic payment histories
public/             dashboard (HTML/CSS/vanilla JS)
```

## What's next

- Learn each client's typical payment delay to forecast cash flow
- Support SMS and WhatsApp reminders as well as PayPal email
- Multi-user accounts with PayPal partner onboarding (invoices from the user's own PayPal account)
- Let the agent reply to client emails ("can I pay next Friday?") and reschedule automatically

## License

[MIT](LICENSE)
