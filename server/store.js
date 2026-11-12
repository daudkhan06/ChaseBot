// Tiny JSON-file store. Good enough for a single-user demo; swap for Postgres later.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FILE = process.env.DATA_FILE || path.resolve("data/db.json");

const DEFAULT = {
  settings: {
    businessName: "Northlight Studio",
    ownerName: "Alex",
    currency: "GBP",
    tone: "warm but professional, concise, British English",
    autopilot: false, // false = agent proposes customer-facing actions, owner approves
    dayOffset: 0, // demo clock: shifts "today" forward to show overdue behaviour
  },
  clients: [],
  invoices: [],
};

let db;
function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    db = structuredClone(DEFAULT);
  }
  db.settings = { ...DEFAULT.settings, ...db.settings };
  return db;
}

export function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

export const id = (p) => `${p}_${crypto.randomBytes(5).toString("hex")}`;
export const state = () => load();

export function reset(seed) {
  db = structuredClone(seed ?? DEFAULT);
  save();
}

/** "Today" according to the demo clock, as YYYY-MM-DD. */
export function today() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (load().settings.dayOffset || 0));
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const OPEN = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "PAYMENT_PENDING"]);
export const PAID = new Set(["PAID", "MARKED_AS_PAID"]);

/** Derived view fields used by the UI and the agent. */
export function view(inv) {
  const t = today();
  const open = OPEN.has(inv.status);
  const daysOverdue = open ? Math.max(0, daysBetween(inv.dueDate, t)) : 0;
  return {
    ...inv,
    client: load().clients.find((c) => c.id === inv.clientId),
    overdue: open && daysOverdue > 0,
    daysOverdue,
    daysLate: inv.paidAt ? Math.max(0, daysBetween(inv.dueDate, inv.paidAt)) : null,
  };
}

export function log(inv, type, text, extra = {}) {
  inv.history.push({ at: new Date().toISOString(), day: today(), type, text, ...extra });
}

export function findOrCreateClient({ name, company, email }) {
  const s = load();
  let c =
    s.clients.find((c) => email && c.email?.toLowerCase() === email.toLowerCase()) ||
    s.clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!c) {
    c = { id: id("cli"), name, company: company || null, email: email || null, notes: "" };
    s.clients.push(c);
  } else {
    if (email) c.email = email;
    if (company) c.company = company;
  }
  return c;
}
