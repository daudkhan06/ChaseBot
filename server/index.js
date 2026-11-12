import express from "express";
import path from "node:path";
import { state, save, view, today, log, reset, OPEN, PAID, daysBetween } from "./store.js";
import { paypal, isMock } from "./paypal.js";
import { createInvoice, syncInvoice, syncAll, recordOfflinePayment } from "./invoices.js";
import { extractDraft, runChaseAgent, executeAction } from "./ai.js";
import { seedData } from "../scripts/seed-data.js";

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.resolve("public")));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(err.status && err.status < 500 ? 400 : 500).json({ error: err.message });
  });

const findInvoice = (req) => {
  const inv = state().invoices.find((i) => i.id === req.params.id);
  if (!inv) throw Object.assign(new Error("Invoice not found"), { status: 404 });
  return inv;
};

function kpis(invoices) {
  const t = today();
  const sum = (arr) => Math.round(arr.reduce((s, i) => s + i.total, 0) * 100) / 100;
  const open = invoices.filter((i) => OPEN.has(i.status));
  const paid = invoices.filter((i) => PAID.has(i.status) && i.paidAt);
  const recent = paid.filter((i) => daysBetween(i.paidAt, t) <= 30);
  return {
    outstanding: sum(open),
    overdue: sum(open.filter((i) => i.overdue)),
    overdueCount: open.filter((i) => i.overdue).length,
    collected30d: sum(recent),
    avgDaysLate: paid.length ? Math.round((paid.reduce((s, i) => s + i.daysLate, 0) / paid.length) * 10) / 10 : 0,
    pendingApprovals: invoices.filter((i) => i.pending).length,
  };
}

app.get("/api/state", (req, res) => {
  const s = state();
  const invoices = s.invoices.map(view);
  res.json({ settings: s.settings, today: today(), mode: isMock() ? "mock" : process.env.PAYPAL_ENV === "live" ? "live" : "sandbox", clients: s.clients, invoices, kpis: kpis(invoices) });
});

app.post("/api/extract", wrap(async (req, res) => {
  const { text, image } = req.body;
  if (!text?.trim() && !image) return res.status(400).json({ error: "Describe the work or attach an image." });
  res.json(await extractDraft({ text, image }));
}));

app.post("/api/invoices", wrap(async (req, res) => {
  const d = req.body;
  if (!d?.items?.length) return res.status(400).json({ error: "Add at least one line item." });
  res.json(view(await createInvoice(d)));
}));

app.post("/api/sync", wrap(async (req, res) => res.json({ changed: await syncAll() })));

app.post("/api/invoices/:id/sync", wrap(async (req, res) => {
  const inv = findInvoice(req);
  await syncInvoice(inv);
  res.json(view(inv));
}));

app.post("/api/invoices/:id/chase", wrap(async (req, res) => {
  const inv = findInvoice(req);
  await syncInvoice(inv);
  if (!OPEN.has(inv.status)) return res.json({ summary: `Invoice is ${inv.status}; nothing to chase.`, actions: [], invoice: view(inv) });
  res.json(await runChaseAgent(inv));
}));

// Autopilot sweep: run the agent on every overdue invoice that's due for a check.
app.post("/api/autopilot/run", wrap(async (req, res) => {
  await syncAll().catch(() => {});
  const t = today();
  const due = state().invoices.map(view).filter((i) => i.overdue && !i.historical && !i.escalated && (!i.nextCheck || i.nextCheck <= t));
  const results = [];
  for (const v of due) {
    const inv = state().invoices.find((i) => i.id === v.id);
    try {
      const r = await runChaseAgent(inv);
      results.push({ id: inv.id, number: inv.number, summary: r.summary, actions: r.actions });
    } catch (err) {
      results.push({ id: inv.id, number: inv.number, error: err.message });
    }
  }
  res.json({ checked: due.length, results });
}));

app.post("/api/invoices/:id/approve", wrap(async (req, res) => {
  const inv = findInvoice(req);
  if (!inv.pending) return res.status(400).json({ error: "Nothing awaiting approval." });
  const input = { ...inv.pending.input, ...(req.body?.message ? { message: req.body.message } : {}) };
  await executeAction(inv, inv.pending.tool, input);
  res.json(view(inv));
}));

app.post("/api/invoices/:id/reject", wrap(async (req, res) => {
  const inv = findInvoice(req);
  if (inv.pending) log(inv, "rejected", "Owner rejected the agent's proposal.");
  inv.pending = null;
  save();
  res.json(view(inv));
}));

app.post("/api/invoices/:id/record-payment", wrap(async (req, res) => {
  const inv = findInvoice(req);
  await recordOfflinePayment(inv);
  res.json(view(inv));
}));

app.post("/api/invoices/:id/resolve", wrap(async (req, res) => {
  const inv = findInvoice(req);
  inv.escalated = null;
  log(inv, "status", "Owner cleared the escalation; agent may resume chasing.");
  save();
  res.json(view(inv));
}));

app.patch("/api/settings", wrap(async (req, res) => {
  const allowed = ["businessName", "ownerName", "currency", "tone", "autopilot"];
  const s = state();
  for (const k of allowed) if (k in req.body) s.settings[k] = req.body[k];
  save();
  res.json(s.settings);
}));

// Demo clock: fast-forward "today" so overdue behaviour can be shown in a 3-minute video.
app.post("/api/clock", wrap(async (req, res) => {
  const s = state();
  s.settings.dayOffset = req.body.reset ? 0 : (s.settings.dayOffset || 0) + Number(req.body.days || 0);
  save();
  res.json({ today: today(), dayOffset: s.settings.dayOffset });
}));

app.post("/api/demo/reset", wrap(async (req, res) => {
  reset(seedData());
  res.json({ ok: true });
}));

// PayPal webhooks: INVOICING.INVOICE.PAID / CANCELLED / UPDATED etc.
app.post("/api/webhooks/paypal", wrap(async (req, res) => {
  const event = req.body;
  const ok = await paypal.verifyWebhook(req.headers, event).catch(() => false);
  if (!ok) return res.status(400).json({ error: "Webhook signature not verified" });
  const ppId = event.resource?.invoice?.id || event.resource?.id;
  const inv = state().invoices.find((i) => i.paypalId === ppId);
  if (inv) {
    await syncInvoice(inv);
    log(inv, "webhook", `PayPal webhook received: ${event.event_type}.`);
    save();
  }
  res.json({ received: true });
}));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`ChaseBot running on http://localhost:${port} (PayPal: ${isMock() ? "MOCK - add PAYPAL_CLIENT_ID/SECRET for sandbox" : process.env.PAYPAL_ENV || "sandbox"})`);
  if (!state().invoices.length) {
    reset(seedData());
    console.log("Seeded demo data.");
  }
});

// Light polling as a fallback for local runs where PayPal can't reach the webhook URL.
setInterval(() => syncAll().catch((e) => console.warn("sync:", e.message)), 30_000).unref();
