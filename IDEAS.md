# PayPal AI Hackathon: Idea Shortlist

**Deadline:** Nov 12, 2026 @ 8:00pm GMT (same day). Every idea below is scoped so one person can build it with Claude in about 7 hours, leaving 1–2 hours for the README, the video and submission.

**Must-haves (from the rules):** PayPal sandbox integration is central · AI is meaningful · a working build (hosted URL or clear run instructions) · public repo + LICENSE · YouTube demo under 3 min · a write-up of the tools used.

**Judging:** Tech implementation · Design · Potential impact (a real problem for a real audience) · Innovation · Presentation.

---

## 1. ChaseBot: an AI accounts-receivable agent for freelancers ⭐ recommended
**Problem:** Late payment is the top cash-flow problem for freelancers and micro-businesses. In the UK, small businesses are owed billions in late payments, and chasing clients is awkward, so it gets put off.

**What it does**
- Type or paste a messy job description ("6h logo work for Sam at Acme, £40/h, plus £15 fonts, due in 14 days"), or upload a timesheet or screenshot. Claude extracts the line items and drafts a **PayPal invoice** (Invoicing API v2), and the user sends it with one click.
- A dashboard shows every invoice's live status (draft → sent → viewed → paid / overdue) from PayPal.
- An **escalation agent**: for each overdue invoice, Claude picks the next step (friendly nudge → firm reminder → payment-plan offer) and writes the message in the user's tone. It can also create a split **payment plan** as several smaller invoices.
- PayPal **webhooks** (`INVOICING.INVOICE.PAID`) mark invoices as paid and stop the chasing.
- A "cash-flow forecast": Claude reads the client's payment history and predicts when each invoice will actually be paid.

**PayPal:** Invoicing API, Webhooks, optional Payouts (to pay a subcontractor once the invoice is paid).
**AI:** Claude for structured extraction (text and images), the escalation decision with tool use, and tone-matched drafting.
**Why it wins:** The PayPal integration runs deep, the problem is concrete and relatable, the agent loop shows well on video, and every API involved works properly in the sandbox (low risk).
**Prize angles:** Overall, Most Impactful, Best Use of PayPal + AI, Render (host it), AG Grid (invoice table).

---

## 2. Guardrail Wallet: safe agentic shopping with spending rules
**Problem:** People want AI agents to buy things for them but don't trust them with money. There's no simple layer for "you can spend up to £50 on groceries, but ask me for anything over £20 from a new seller."

**What it does:** A chat shopping agent searches products (Channel3 product search, or a mock catalogue) and builds a cart. Before checkout, a **policy engine** checks user-written rules in plain English, which Claude turns into structured rules. Purchases within policy are completed through **PayPal Orders v2**; anything else sends the user an approve/deny card. The full audit trail shows why the agent bought each item.

**PayPal:** Orders v2 (create/capture), Vault for a saved payment method, optional Agent Toolkit.
**AI:** Claude agent with tools (search, add_to_cart, request_approval, checkout).
**Prize angles:** Best Use of Agentic Commerce, Most Creative, Channel3.
**Risk:** The most crowded theme in this hackathon, and the Vault / no-buyer-present flow is fiddly in the sandbox.

---

## 3. Dispute Copilot: win chargebacks without a lawyer
**Problem:** Small sellers lose disputes by default because putting together evidence takes hours and they don't know what PayPal wants to see.

**What it does:** It pulls open disputes (Disputes API), gathers order data, tracking numbers and buyer messages, and Claude writes a structured evidence response tailored to the dispute reason. It scores the chance of winning and suggests "refund vs. fight" based on the amount and the evidence.

**PayPal:** Disputes API, Transactions/Orders, Refunds.
**AI:** Claude for reasoning over evidence, classification and writing.
**Prize angles:** Most Impactful, Best Use of PayPal + AI.
**Risk:** Creating realistic disputes in the sandbox takes manual setup in the buyer account (doable, but uses up time).

---

## 4. SnapSplit: photograph the receipt, everyone's paid
**Problem:** Group bills (flatmates, dinners, trips) mean someone fronts the money and then chases people for weeks.

**What it does:** Upload a receipt photo and Claude vision itemises it. Group members claim items by chatting ("I had the burger and half the nachos"), Claude settles the ambiguous splits, and each person gets a **PayPal checkout link** for their exact share. Live status shows who has paid.

**PayPal:** Orders v2 / payment links, Payouts.
**AI:** Claude vision for the receipt, natural-language item assignment.
**Prize angles:** Best Demo Delivery (very visual), Design.
**Risk:** Weaker on innovation because Splitwise-style apps exist. The AI part has to carry the novelty.

---

## 5. Merchant Pulse: ask your PayPal account anything
**Problem:** Small merchants have the data in PayPal but no analyst to read it.

**What it does:** Connects to Transaction Search and Reporting. Ask "why was October down?" or "which customers stopped buying?" and Claude answers with charts, flags unusual transactions, and can act on the answer (refund, re-engagement invoice, discount offer).

**PayPal:** Transaction Search, Reporting, Refunds, Invoicing.
**AI:** Claude with tools over the account data.
**Prize angles:** AG Grid (strong fit), Elastic, Best Use of PayPal + AI.
**Risk:** Sandbox accounts have little transaction history, so you'd need a seeding script to make the demo convincing.

---

## Recommendation
**Build #1, ChaseBot.** It scores best across all five judging criteria within the time available, its sandbox APIs are reliable, and it targets a specific, credible audience (freelancers and students who freelance). If you'd rather go for the agentic-commerce prize, #2 is the higher-risk, higher-reward option.

## Proposed stack (for any of the ideas)
- Next.js (TypeScript) app with API routes, deployed on **Render** (counts for a sponsor prize and gives the judges a hosted URL)
- PayPal REST APIs (sandbox) using a client ID and secret from `.env`
- Claude API (`claude-sonnet-5-5`) via the Anthropic SDK using `ANTHROPIC_API_KEY` from `.env` (never committed)
- SQLite/JSON store for demo state, plus a seed script
- MIT LICENSE, README with setup steps, architecture diagram and a "Tools used" section
