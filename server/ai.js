// Claude-powered pieces: (1) turning messy job notes into an invoice draft,
// (2) the chase agent that decides how to follow up on an overdue invoice.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { state, save, today, view, log, addDays } from "./store.js";
import { sendReminder, offerPaymentPlan } from "./invoices.js";

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

// ---------------------------------------------------------------------------
// 1. Extraction
// ---------------------------------------------------------------------------
const DraftSchema = z.object({
  client_name: z.string().describe("Person to bill. Best guess from the text."),
  client_company: z.string().nullable(),
  client_email: z.string().nullable().describe("Only if explicitly present; never invent one."),
  currency: z.enum(["GBP", "USD", "EUR", "CAD", "AUD"]),
  items: z.array(
    z.object({
      name: z.string().describe("Short line-item title, e.g. 'Logo design'"),
      description: z.string().nullable(),
      quantity: z.number(),
      unit_price: z.number().describe("Price per unit, excluding currency symbol"),
      unit: z.enum(["HOURS", "QUANTITY", "AMOUNT"]),
    }),
  ),
  due_in_days: z.number().describe("Payment term in days; default 14 if not stated"),
  note: z.string().describe("A short, friendly note to the client to show on the invoice"),
  assumptions: z.array(z.string()).describe("Anything you inferred or that the user should double-check"),
});

export async function extractDraft({ text, image }) {
  const { settings, clients } = state();
  const known = clients.map((c) => `${c.name}${c.company ? ` (${c.company})` : ""} <${c.email ?? "no email"}>`).join("\n");
  const content = [];
  if (image) {
    const [, mediaType, data] = image.match(/^data:(image\/[a-z+]+);base64,(.+)$/) || [];
    if (data) content.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }
  content.push({
    type: "text",
    text: `Turn this into an invoice draft for ${settings.businessName}. Default currency ${settings.currency}. Today is ${today()}.

Known clients (reuse the exact name and email if it's one of them):
${known || "(none yet)"}

Job notes from the freelancer:
"""
${text || "(see attached image)"}
"""`,
  });

  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    output_config: { effort: "low", format: zodOutputFormat(DraftSchema) },
    system:
      "You are the invoicing assistant inside ChaseBot. Extract billable work into clean invoice line items. Split distinct pieces of work and expenses into separate items. Use HOURS for time-based work, QUANTITY for countable deliverables, AMOUNT for flat fees/expenses. Never invent an email address.",
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error("Could not extract an invoice from that input.");
  const d = res.parsed_output;
  const known_ = clients.find((c) => c.name.toLowerCase() === d.client_name.toLowerCase());
  return {
    clientName: d.client_name,
    clientCompany: d.client_company ?? known_?.company ?? null,
    clientEmail: d.client_email ?? known_?.email ?? null,
    currency: d.currency,
    items: d.items.map((i) => ({ name: i.name, description: i.description, quantity: i.quantity, unitPrice: i.unit_price, unit: i.unit })),
    dueInDays: d.due_in_days,
    note: d.note,
    assumptions: d.assumptions,
  };
}

// ---------------------------------------------------------------------------
// 2. Chase agent
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "get_client_history",
    description:
      "Returns this client's full invoice history with us: amounts, due dates, when each was paid and how many days late, plus every reminder already sent. Call this first.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "send_reminder",
    description:
      "Send a payment reminder for this invoice through PayPal (the client gets an email with a Pay Now link). Customer-facing. Write the message in the business owner's voice, first person, plain text, under 120 words.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        escalation: { type: "string", enum: ["friendly_nudge", "firm_reminder", "final_notice"] },
        subject: { type: "string" },
        message: { type: "string" },
      },
      required: ["escalation", "subject", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "offer_payment_plan",
    description:
      "Cancel this invoice in PayPal and replace it with 2-4 smaller instalment invoices, each sent separately with its own due date. Customer-facing. Use when the client seems to be struggling to pay a large amount, not merely forgetful.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        installments: { type: "integer", enum: [2, 3, 4] },
        interval_days: { type: "integer", enum: [7, 14, 30] },
        message: { type: "string", description: "Explanation sent to the client with the cancellation notice." },
      },
      required: ["installments", "interval_days", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_next_check",
    description: "Decide when the agent should look at this invoice again. Always call this once at the end.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        in_days: { type: "integer", enum: [1, 2, 3, 5, 7, 10, 14] },
        reason: { type: "string" },
      },
      required: ["in_days", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_owner",
    description:
      "Flag this invoice for the business owner's personal attention (e.g. a phone call, small-claims, or writing it off). Use when automated reminders are no longer appropriate.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" }, suggested_next_step: { type: "string" } },
      required: ["reason", "suggested_next_step"],
      additionalProperties: false,
    },
  },
];

const CUSTOMER_FACING = new Set(["send_reminder", "offer_payment_plan"]);

function systemPrompt(settings) {
  return `You are ChaseBot, the accounts-receivable agent for ${settings.businessName}, a small business run by ${settings.ownerName}.
Your job: get overdue invoices paid while protecting the client relationship. You act through PayPal.

How to decide:
- Start by calling get_client_history. Reliable payers who are a few days late get a light nudge; repeat late payers get firmer, sooner.
- Escalate gradually: friendly_nudge → firm_reminder → final_notice. Don't repeat a level that already failed unless lots of time has passed. Leave at least 3 days between reminders.
- If the amount is large relative to what this client usually pays, or they've gone quiet after firm reminders, a payment plan is often better than another reminder.
- After a final_notice has been ignored, or past ~45 days overdue, stop emailing and escalate_to_owner instead.
- Never threaten legal action, late fees or debt collectors unless the owner has asked. Never be sarcastic or guilt-trip.
- Take at most ONE customer-facing action per run, then call schedule_next_check.
- Tone for all client messages: ${settings.tone}. Sign off as ${settings.ownerName}. Mention the invoice number and amount; PayPal adds the Pay Now button automatically, so don't paste links.

Finish with 1-2 sentences for the owner explaining what you did and why.`;
}

function clientHistory(inv) {
  const s = state();
  const c = s.clients.find((x) => x.id === inv.clientId);
  const invoices = s.invoices
    .filter((i) => i.clientId === inv.clientId)
    .map(view)
    .map((i) => ({
      number: i.number,
      amount: `${i.total} ${i.currency}`,
      issued: i.invoiceDate,
      due: i.dueDate,
      status: i.status,
      paid_on: i.paidAt,
      days_late_when_paid: i.daysLate,
      days_overdue_now: i.daysOverdue || undefined,
      chase_actions: i.history.filter((h) => ["reminder", "plan", "escalated"].includes(h.type)).map((h) => `${h.day}: ${h.type}${h.escalation ? ` (${h.escalation})` : ""}`),
    }));
  return { client: { name: c.name, company: c.company, notes: c.notes || null }, invoices };
}

/** Execute (or queue, when autopilot is off) one agent tool call. */
async function runTool(inv, name, input, ctx) {
  const s = state();
  switch (name) {
    case "get_client_history":
      return clientHistory(inv);
    case "send_reminder":
    case "offer_payment_plan": {
      if (ctx.customerActions >= 1) return { error: "Already took a customer-facing action this run. Schedule the next check instead." };
      ctx.customerActions++;
      if (!s.settings.autopilot) {
        inv.pending = { tool: name, input, proposedAt: new Date().toISOString() };
        log(inv, "proposal", `Agent proposes: ${name === "send_reminder" ? `${input.escalation.replace("_", " ")} reminder` : `${input.installments}-part payment plan`}. Waiting for owner approval.`, { by: "agent" });
        ctx.actions.push({ tool: name, queued: true });
        return { status: "queued_for_owner_approval" };
      }
      await executeAction(inv, name, input);
      ctx.actions.push({ tool: name, queued: false });
      return { status: "done" };
    }
    case "schedule_next_check":
      inv.nextCheck = addDays(today(), input.in_days);
      ctx.actions.push({ tool: name, in_days: input.in_days });
      return { status: "scheduled", next_check: inv.nextCheck };
    case "escalate_to_owner":
      inv.escalated = { reason: input.reason, next: input.suggested_next_step };
      log(inv, "escalated", `${input.reason} Suggested: ${input.suggested_next_step}`, { by: "agent" });
      ctx.actions.push({ tool: name });
      return { status: "owner_notified" };
    default:
      return { error: `Unknown tool ${name}` };
  }
}

export async function executeAction(inv, tool, input) {
  if (tool === "send_reminder") {
    await sendReminder(inv, { subject: input.subject, message: input.message });
    inv.history.at(-1).escalation = input.escalation;
  } else if (tool === "offer_payment_plan") {
    await offerPaymentPlan(inv, { installments: input.installments, intervalDays: input.interval_days, message: input.message });
  }
  inv.pending = null;
  save();
}

/** Run the chase agent on one invoice. Returns a summary for the UI. */
export async function runChaseAgent(inv) {
  const s = state();
  const v = view(inv);
  const ctx = { customerActions: 0, actions: [] };
  const messages = [
    {
      role: "user",
      content: `Today is ${today()}.
Invoice ${inv.number} to ${v.client.name}${v.client.company ? ` (${v.client.company})` : ""}: ${inv.total} ${inv.currency}, issued ${inv.invoiceDate}, due ${inv.dueDate}.
Status in PayPal: ${inv.status}. Days overdue: ${v.daysOverdue}.
Line items: ${inv.items.map((i) => `${i.name} × ${i.quantity} @ ${i.unitPrice}`).join("; ")}.
${inv.pending ? `Note: a previous proposal (${inv.pending.tool}) is still awaiting the owner's approval; replace it only if it's no longer right.` : ""}
Decide what to do.`,
    },
  ];

  let summary = "";
  for (let turn = 0; turn < 8; turn++) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: systemPrompt(s.settings),
      tools: TOOLS,
      messages,
    });
    if (res.stop_reason === "refusal") throw new Error("The agent declined to act on this invoice.");
    messages.push({ role: "assistant", content: res.content });
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (text) summary = text;

    const calls = res.content.filter((b) => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || calls.length === 0) break;

    const results = [];
    for (const call of calls) {
      try {
        const out = await runTool(inv, call.name, call.input, ctx);
        results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: `Error: ${err.message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  if (summary) log(inv, "agent", summary, { by: "agent", actions: ctx.actions });
  inv.lastAgentRun = today();
  save();
  return { summary, actions: ctx.actions, invoice: view(inv) };
}
