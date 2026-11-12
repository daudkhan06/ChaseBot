// Invoice operations shared by the HTTP routes and the chase agent.
import { paypal } from "./paypal.js";
import { state, save, id, today, addDays, log, findOrCreateClient, PAID, OPEN } from "./store.js";

const total = (items) => items.reduce((s, it) => s + Number(it.quantity) * Number(it.unitPrice), 0);
const round2 = (n) => Math.round(n * 100) / 100;

/** Create a PayPal invoice from a reviewed draft and send it to the client. */
export async function createInvoice(draft, { planOf = null, label = null } = {}) {
  const s = state();
  const client = findOrCreateClient({ name: draft.clientName, company: draft.clientCompany, email: draft.clientEmail });
  const invoiceDate = draft.invoiceDate || new Date().toISOString().slice(0, 10);
  const dueDate = draft.dueDate || addDays(invoiceDate, Number(draft.dueInDays ?? 14));
  const full = {
    ...draft,
    clientEmail: client.email,
    businessName: s.settings.businessName,
    currency: draft.currency || s.settings.currency,
    invoiceDate,
    dueDate,
  };
  if (!full.clientEmail) throw new Error("Client email is required to send a PayPal invoice.");

  const pp = await paypal.createAndSend(full, {
    subject: `Invoice from ${s.settings.businessName}`,
    note: draft.note,
  });

  const inv = {
    id: id("inv"),
    paypalId: pp.id,
    number: pp.detail?.invoice_number,
    clientId: client.id,
    currency: full.currency,
    items: full.items,
    total: round2(total(full.items)),
    note: full.note || "",
    invoiceDate,
    dueDate,
    status: pp.status || "SENT",
    viewUrl: pp.detail?.metadata?.recipient_view_url || null,
    paidAt: null,
    planOf,
    label,
    nextCheck: null,
    pending: null,
    history: [],
  };
  log(inv, "created", `Invoice ${inv.number} created in PayPal and sent to ${client.email}.`);
  s.invoices.unshift(inv);
  save();
  return inv;
}

/** Pull the latest status from PayPal. Returns true if anything changed. */
export async function syncInvoice(inv) {
  if (inv.historical || !inv.paypalId) return false;
  const pp = await paypal.get(inv.paypalId);
  if (pp.status === inv.status) return false;
  const was = inv.status;
  inv.status = pp.status;
  if (PAID.has(pp.status) && !inv.paidAt) {
    inv.paidAt = today();
    inv.pending = null;
    inv.nextCheck = null;
    log(inv, "paid", `Paid via PayPal (${pp.status}). Chasing stopped.`);
  } else {
    log(inv, "status", `PayPal status changed ${was} → ${pp.status}.`);
  }
  save();
  return true;
}

export async function syncAll() {
  const open = state().invoices.filter((i) => OPEN.has(i.status) && !i.historical);
  const results = await Promise.allSettled(open.map(syncInvoice));
  return results.filter((r) => r.status === "fulfilled" && r.value).length;
}

export async function sendReminder(inv, { subject, message }) {
  await paypal.remind(inv.paypalId, subject, message);
  log(inv, "reminder", message, { subject, by: "agent" });
  save();
}

/**
 * Replace an overdue invoice with N smaller instalment invoices.
 * The original is cancelled in PayPal (with an explanatory note) and each
 * instalment is created + sent as its own PayPal invoice.
 */
export async function offerPaymentPlan(inv, { installments, intervalDays, message }) {
  const s = state();
  const client = s.clients.find((c) => c.id === inv.clientId);
  await paypal.cancel(inv.paypalId, "Your invoice has been split into instalments", message);
  inv.status = "CANCELLED";
  log(inv, "plan", message, { by: "agent", installments, intervalDays });

  const base = Math.floor((inv.total / installments) * 100) / 100;
  const created = [];
  for (let k = 0; k < installments; k++) {
    const amount = k === installments - 1 ? round2(inv.total - base * (installments - 1)) : base;
    const dueDate = addDays(new Date().toISOString().slice(0, 10), intervalDays * (k + 1));
    created.push(
      await createInvoice(
        {
          clientName: client.name,
          clientCompany: client.company,
          clientEmail: client.email,
          currency: inv.currency,
          items: [{ name: `Instalment ${k + 1} of ${installments} for invoice ${inv.number}`, quantity: 1, unitPrice: amount, unit: "AMOUNT" }],
          note: message,
          dueDate,
        },
        { planOf: inv.id, label: `${k + 1}/${installments}` },
      ),
    );
  }
  save();
  return created;
}

export async function recordOfflinePayment(inv) {
  await paypal.recordPayment(inv.paypalId, inv.total, inv.currency);
  return syncInvoice(inv);
}
