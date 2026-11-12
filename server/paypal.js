// PayPal REST client (Invoicing v2 + webhook verification).
// Talks to the sandbox by default. Set PAYPAL_MOCK=true to run a local in-memory
// imitation of the Invoicing API (for offline development only).

const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

export const isMock = () =>
  process.env.PAYPAL_MOCK === "true" ||
  !process.env.PAYPAL_CLIENT_ID ||
  !process.env.PAYPAL_CLIENT_SECRET;

export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let cachedToken = null; // { token, expiresAt }

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(`PayPal auth failed: ${body.error_description || res.status}`, res.status, body);
  cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.token;
}

async function call(method, path, body, extraHeaders = {}) {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data?.details?.map((d) => `${d.field ?? ""} ${d.description ?? d.issue}`).join("; ");
    throw new PayPalError(`PayPal ${method} ${path} failed: ${data?.message || res.status}${detail ? ` (${detail})` : ""}`, res.status, data);
  }
  return data;
}

const money = (currency, value) => ({ currency_code: currency, value: Number(value).toFixed(2) });

/** Build a PayPal invoice payload from our internal draft shape. */
function buildInvoice(draft, invoiceNumber) {
  const [given, ...rest] = (draft.clientName || "Client").split(" ");
  return {
    detail: {
      invoice_number: invoiceNumber,
      currency_code: draft.currency,
      invoice_date: draft.invoiceDate,
      payment_term: { due_date: draft.dueDate },
      note: draft.note?.slice(0, 4000),
      memo: draft.memo?.slice(0, 500),
    },
    invoicer: draft.businessName ? { business_name: draft.businessName } : undefined,
    primary_recipients: [
      {
        billing_info: {
          name: { given_name: given, surname: rest.join(" ") || undefined },
          business_name: draft.clientCompany || undefined,
          email_address: draft.clientEmail,
        },
      },
    ],
    items: draft.items.map((it) => ({
      name: it.name.slice(0, 200),
      description: it.description?.slice(0, 1000) || undefined,
      quantity: String(it.quantity),
      unit_amount: money(draft.currency, it.unitPrice),
      unit_of_measure: it.unit || "QUANTITY",
    })),
  };
}

// ---------------- real API ----------------
const real = {
  async createAndSend(draft, { subject, note } = {}) {
    const { invoice_number } = await call("POST", "/v2/invoicing/generate-next-invoice-number");
    const created = await call("POST", "/v2/invoicing/invoices", buildInvoice(draft, invoice_number));
    const id = created.id ?? created.href?.split("/").pop();
    await call("POST", `/v2/invoicing/invoices/${id}/send`, {
      subject,
      note,
      send_to_invoicer: false,
      send_to_recipient: true,
    });
    return real.get(id);
  },
  get: (id) => call("GET", `/v2/invoicing/invoices/${id}`),
  remind: (id, subject, note) =>
    call("POST", `/v2/invoicing/invoices/${id}/remind`, { subject, note, send_to_invoicer: false, send_to_recipient: true }),
  cancel: (id, subject, note) =>
    call("POST", `/v2/invoicing/invoices/${id}/cancel`, { subject, note, send_to_invoicer: false, send_to_recipient: true }),
  recordPayment: (id, amount, currency, method = "BANK_TRANSFER") =>
    call("POST", `/v2/invoicing/invoices/${id}/payments`, {
      method,
      payment_date: new Date().toISOString().slice(0, 10),
      amount: money(currency, amount),
    }),
  async verifyWebhook(headers, event) {
    if (!process.env.PAYPAL_WEBHOOK_ID) return false;
    const res = await call("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    });
    return res?.verification_status === "SUCCESS";
  },
};

// ---------------- mock API (offline dev only) ----------------
const mockDb = new Map();
let mockSeq = 1000;
const mock = {
  async createAndSend(draft) {
    const id = `INV2-MOCK-${mockSeq++}`;
    const inv = buildInvoice(draft, String(mockSeq));
    const total = draft.items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
    const full = {
      id,
      status: "SENT",
      ...inv,
      amount: money(draft.currency, total),
      due_amount: money(draft.currency, total),
      detail: { ...inv.detail, metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}` } },
    };
    mockDb.set(id, full);
    return structuredClone(full);
  },
  async get(id) {
    const inv = mockDb.get(id);
    if (!inv) throw new PayPalError("Invoice not found (mock)", 404);
    return structuredClone(inv);
  },
  async remind() { return null; },
  async cancel(id) { mockDb.get(id).status = "CANCELLED"; return null; },
  async recordPayment(id) {
    const inv = mockDb.get(id);
    inv.status = "MARKED_AS_PAID";
    inv.due_amount = money(inv.detail.currency_code, 0);
    return null;
  },
  async verifyWebhook() { return false; },
};

export const paypal = new Proxy({}, { get: (_, k) => (isMock() ? mock : real)[k] });
