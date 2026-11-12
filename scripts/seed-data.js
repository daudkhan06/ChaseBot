// Demo clients with realistic payment history, so the agent has something to reason about.
// Historical invoices are local records only (marked `historical`); new invoices go to PayPal.
import crypto from "node:crypto";

const ago = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const rid = (p) => `${p}_${crypto.randomBytes(5).toString("hex")}`;
const email = (local) => {
  const base = process.env.DEMO_CLIENT_EMAIL; // e.g. your sandbox personal account, so you can pay invoices
  if (!base) return `${local}@example.com`;
  const [u, d] = base.split("@");
  return `${u}+${local}@${d}`;
};

function hist(clientId, number, total, issuedDaysAgo, termDays, paidLateBy, item, history = []) {
  const invoiceDate = ago(issuedDaysAgo);
  const dueDate = ago(issuedDaysAgo - termDays);
  const paidAt = ago(issuedDaysAgo - termDays - paidLateBy);
  return {
    id: rid("inv"), paypalId: null, number, clientId, currency: "GBP",
    items: [{ name: item, quantity: 1, unitPrice: total, unit: "AMOUNT" }],
    total, note: "", invoiceDate, dueDate, status: "PAID", viewUrl: null, paidAt,
    planOf: null, label: null, nextCheck: null, pending: null, historical: true,
    history: [{ at: new Date().toISOString(), day: invoiceDate, type: "created", text: "Imported from previous records." }, ...history],
  };
}

export function seedData() {
  const sam = { id: rid("cli"), name: "Sam Patel", company: "Acme Coffee Co", email: email("sam"), notes: "Long-standing client, pays promptly. Friendly." };
  const jordan = { id: rid("cli"), name: "Jordan Lee", company: "Brightside Studio", email: email("jordan"), notes: "Agency subcontract work. Often slow to pay." };
  const priya = { id: rid("cli"), name: "Priya Shah", company: "Nimbus Youth Charity", email: email("priya"), notes: "Small charity, tight cash flow. Very appreciative." };

  const r = (day, escalation) => ({ at: new Date().toISOString(), day: ago(day), type: "reminder", text: "(earlier reminder)", escalation });

  return {
    settings: {
      businessName: "Northlight Studio",
      ownerName: "Alex",
      currency: "GBP",
      tone: "warm but professional, concise, British English",
      autopilot: false,
      dayOffset: 0,
    },
    clients: [sam, jordan, priya],
    invoices: [
      hist(sam.id, "HIST-0007", 480, 120, 14, 0, "Menu redesign"),
      hist(sam.id, "HIST-0011", 260, 75, 14, 2, "Social media templates"),
      hist(sam.id, "HIST-0016", 350, 40, 14, 1, "Loyalty card design"),
      hist(jordan.id, "HIST-0008", 1200, 140, 30, 24, "Brand identity (subcontract)", [r(98, "friendly_nudge"), r(90, "firm_reminder")]),
      hist(jordan.id, "HIST-0013", 900, 90, 30, 31, "Website illustrations", [r(55, "friendly_nudge"), r(45, "firm_reminder"), r(35, "final_notice")]),
      hist(priya.id, "HIST-0010", 300, 100, 14, 9, "Fundraiser poster", [r(80, "friendly_nudge")]),
    ],
  };
}
