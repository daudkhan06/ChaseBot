const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, cur = "GBP") => new Intl.NumberFormat("en-GB", { style: "currency", currency: cur }).format(n || 0);
const fmtDate = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "—");

let S = null; // server state
let filter = "all";
let openId = null;
let draft = null;
let image = null;
let lastRun = [];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : opts.method === "POST" ? "{}" : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = "toast"), error ? 6000 : 3000);
}

async function busy(btn, label, fn) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> ${label}`;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = html;
  }
}

async function load() {
  S = await api("/api/state");
  render();
}

function statusPill(i) {
  if (i.pending) return `<span class="pill pending">Needs approval</span>`;
  if (["PAID", "MARKED_AS_PAID"].includes(i.status)) return `<span class="pill paid">Paid${i.daysLate ? ` · ${i.daysLate}d late` : ""}</span>`;
  if (i.status === "CANCELLED") {
    const plan = S.invoices.some((x) => x.planOf === i.id);
    return plan ? `<span class="pill plan">Split into plan</span>` : `<span class="pill cancelled">Cancelled</span>`;
  }
  if (i.overdue) return `<span class="pill overdue">Overdue ${i.daysOverdue}d</span>`;
  if (i.status === "DRAFT") return `<span class="pill draft">Draft</span>`;
  return `<span class="pill sent">${i.status === "PARTIALLY_PAID" ? "Part paid" : "Sent"}</span>`;
}

function render() {
  const { settings, kpis, mode } = S;
  $("#biz-name").textContent = settings.businessName;
  const badge = $("#mode-badge");
  badge.textContent = mode === "mock" ? "Mock PayPal" : `PayPal ${mode}`;
  badge.className = `badge${mode === "mock" ? " mock" : ""}`;
  $("#today").textContent = new Date(`${S.today}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  $(".clock").classList.toggle("shifted", settings.dayOffset > 0);
  $("#autopilot").checked = settings.autopilot;

  const cur = settings.currency;
  $("#kpis").innerHTML = [
    ["Outstanding", fmt(kpis.outstanding, cur), "awaiting payment", ""],
    ["Overdue", fmt(kpis.overdue, cur), `${kpis.overdueCount} invoice${kpis.overdueCount === 1 ? "" : "s"}`, kpis.overdueCount ? "bad" : ""],
    ["Collected (30d)", fmt(kpis.collected30d, cur), "via PayPal", "ok"],
    ["Avg. days late", kpis.avgDaysLate, "across paid invoices", ""],
    ["Awaiting approval", kpis.pendingApprovals, "agent proposals", kpis.pendingApprovals ? "violet" : ""],
  ].map(([l, v, s, c]) => `<div class="kpi ${c}"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join("");

  renderApprovals();
  renderRows();
  if (openId) renderDrawer();
}

function renderApprovals() {
  const pending = S.invoices.filter((i) => i.pending);
  const escalated = S.invoices.filter((i) => i.escalated && !["PAID", "MARKED_AS_PAID", "CANCELLED"].includes(i.status));
  let html = "";
  for (const i of pending) {
    const p = i.pending;
    const why = [...i.history].reverse().find((h) => h.type === "agent")?.text || "";
    const title = p.tool === "send_reminder"
      ? `${p.input.escalation.replace(/_/g, " ")} → ${esc(i.client?.name)}`
      : `${p.input.installments}-part payment plan → ${esc(i.client?.name)}`;
    html += `<div class="proposal" data-id="${i.id}">
      <div class="proposal-head"><span class="proposal-title" style="text-transform:capitalize">${title}</span><span class="muted">${esc(i.number)} · ${fmt(i.total, i.currency)} · ${i.daysOverdue}d overdue</span></div>
      ${why ? `<div class="proposal-why"><span class="spark" style="color:var(--violet)">✦</span> ${esc(why)}</div>` : ""}
      ${p.input.subject ? `<div class="proposal-subject"><span class="muted">Subject:</span> ${esc(p.input.subject)}</div>` : ""}
      ${p.tool === "offer_payment_plan" ? `<div class="proposal-subject muted">${p.input.installments} PayPal invoices of ~${fmt(i.total / p.input.installments, i.currency)}, every ${p.input.interval_days} days</div>` : ""}
      <textarea class="proposal-msg">${esc(p.input.message)}</textarea>
      <div class="proposal-actions">
        <button class="btn sm ghost" data-act="reject">Dismiss</button>
        <button class="btn sm ok" data-act="approve">Approve & send via PayPal</button>
      </div></div>`;
  }
  for (const i of escalated) {
    html += `<div class="proposal escalation" data-id="${i.id}">
      <div class="proposal-head"><span class="proposal-title">Needs you: ${esc(i.client?.name)}</span><span class="muted">${esc(i.number)} · ${fmt(i.total, i.currency)}</span></div>
      <div class="proposal-why">${esc(i.escalated.reason)}</div>
      <div class="proposal-subject"><b>Suggested:</b> ${esc(i.escalated.next)}</div>
      <div class="proposal-actions"><button class="btn sm ghost" data-act="open">View</button><button class="btn sm" data-act="resolve">Resume auto-chasing</button></div></div>`;
  }
  if (lastRun.length) {
    html += `<div class="run-log">${lastRun.map((r) => `<div class="run-item"><b>${esc(r.number)}</b> — ${esc(r.error || r.summary || "No action needed.")}</div>`).join("")}</div>`;
  }
  if (!html) {
    const overdue = S.kpis.overdueCount;
    html = `<div class="empty"><strong>${overdue ? `${overdue} overdue invoice${overdue > 1 ? "s" : ""}` : "All caught up"}</strong>${overdue ? "Run the agent and it will decide how to follow up with each client." : "Overdue invoices will show up here with the agent's suggested follow-up. Use the demo clock to jump ahead."}</div>`;
  }
  $("#approvals").innerHTML = html;
}

function renderRows() {
  let rows = S.invoices;
  if (filter === "open") rows = rows.filter((i) => ["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "PAYMENT_PENDING"].includes(i.status));
  if (filter === "overdue") rows = rows.filter((i) => i.overdue);
  if (filter === "paid") rows = rows.filter((i) => ["PAID", "MARKED_AS_PAID"].includes(i.status));
  rows = [...rows].sort((a, b) => (b.overdue - a.overdue) || (b.invoiceDate > a.invoiceDate ? 1 : -1));
  $("#invoice-rows").innerHTML = rows.length
    ? rows.map((i) => {
        const rev = [...i.history].reverse();
        const lastAgent = rev.find((h) => h.by === "agent" && h.type !== "agent") || rev.find((h) => h.by === "agent");
        return `<tr data-id="${i.id}">
          <td><b>${esc(i.number)}</b>${i.historical ? `<span class="hist-tag">history</span>` : ""}${i.label ? `<span class="hist-tag">plan ${esc(i.label)}</span>` : ""}<div class="sub">${esc(i.items[0]?.name)}${i.items.length > 1 ? ` +${i.items.length - 1}` : ""}</div></td>
          <td>${esc(i.client?.name)}<div class="sub">${esc(i.client?.company || "")}</div></td>
          <td class="num"><b>${fmt(i.total, i.currency)}</b></td>
          <td>${fmtDate(i.dueDate)}</td>
          <td>${statusPill(i)}</td>
          <td class="agent-cell">${lastAgent ? `${esc(lastAgent.type === "reminder" ? `Sent ${lastAgent.escalation?.replace(/_/g, " ") || "reminder"}` : lastAgent.type === "plan" ? "Offered payment plan" : lastAgent.type === "escalated" ? "Escalated to you" : lastAgent.type === "proposal" ? "Proposed follow-up" : "Reviewed")} · ${fmtDate(lastAgent.day)}` : i.nextCheck ? `Next check ${fmtDate(i.nextCheck)}` : ""}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6"><div class="empty" style="margin:8px 0">No invoices here yet.</div></td></tr>`;
}

// ---------------- Drawer ----------------
const LABEL = { created: "Created", reminder: "Reminder sent", plan: "Payment plan", agent: "Agent reasoning", proposal: "Agent proposal", escalated: "Escalated", paid: "Paid", status: "Status", webhook: "Webhook", rejected: "Dismissed" };

function renderDrawer() {
  const i = S.invoices.find((x) => x.id === openId);
  if (!i) return closeDrawer();
  const open = ["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "PAYMENT_PENDING"].includes(i.status);
  const children = S.invoices.filter((x) => x.planOf === i.id);
  $("#drawer-body").innerHTML = `
    <div class="d-meta">${esc(i.number)} · issued ${fmtDate(i.invoiceDate)} · due ${fmtDate(i.dueDate)}</div>
    <h3 class="d-title" id="drawer-title">${esc(i.client?.name)}${i.client?.company ? ` · ${esc(i.client.company)}` : ""}</h3>
    <div class="d-meta">${esc(i.client?.email || "")}</div>
    <div style="display:flex;align-items:center;gap:10px"><span class="d-amount">${fmt(i.total, i.currency)}</span>${statusPill(i)}</div>
    <div class="d-actions">
      ${open && !i.historical ? `<button class="btn primary" data-act="chase"><span class="spark">✦</span> Run chase agent</button>` : ""}
      ${i.viewUrl ? `<a class="btn paypal" href="${esc(i.viewUrl)}" target="_blank" rel="noopener">Open in PayPal ↗</a>` : ""}
      ${!i.historical && i.paypalId ? `<button class="btn" data-act="sync">↻ Sync</button>` : ""}
      ${open && !i.historical ? `<button class="btn ghost" data-act="record">Mark paid offline</button>` : ""}
    </div>
    ${i.escalated ? `<div class="escalation-box"><b>Escalated:</b> ${esc(i.escalated.reason)}<br/><b>Suggested:</b> ${esc(i.escalated.next)}</div>` : ""}
    <table class="d-items">${i.items.map((it) => `<tr><td>${esc(it.name)}<div class="muted" style="font-size:12px">${it.quantity} × ${fmt(it.unitPrice, i.currency)}${it.unit === "HOURS" ? "/h" : ""}</div></td><td>${fmt(it.quantity * it.unitPrice, i.currency)}</td></tr>`).join("")}</table>
    ${children.length ? `<p class="muted">Replaced by instalments: ${children.map((c) => `<a href="#" class="link" data-open="${c.id}">${esc(c.number)} (${fmt(c.total, c.currency)}, due ${fmtDate(c.dueDate)})</a>`).join(", ")}</p>` : ""}
    <h2 style="margin:8px 0 12px">Timeline</h2>
    <ul class="timeline">${[...i.history].reverse().map((h) => `
      <li class="${h.type}"><span class="dot"></span>
        <div class="t-head"><b>${LABEL[h.type] || h.type}</b>${h.escalation ? ` · ${h.escalation.replace(/_/g, " ")}` : ""} · ${fmtDate(h.day)}${h.by === "agent" ? " · ✦ agent" : ""}</div>
        ${h.subject ? `<div class="t-head">Subject: ${esc(h.subject)}</div>` : ""}
        <div class="t-text">${esc(h.text)}</div>
      </li>`).join("")}</ul>`;
}

function openDrawer(id) {
  openId = id;
  renderDrawer();
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
}
function closeDrawer() {
  openId = null;
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
}

// ---------------- Composer ----------------
function renderDraft() {
  const el = $("#draft");
  if (!draft) return (el.hidden = true);
  el.hidden = false;
  const total = draft.items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0);
  el.innerHTML = `
    <div class="card-head" style="margin-bottom:10px"><h2><span class="spark" style="color:var(--violet)">✦</span> Draft invoice</h2><span class="muted">Check it, then send</span></div>
    <div class="draft-grid">
      <label class="field">Client name<input data-k="clientName" value="${esc(draft.clientName)}" /></label>
      <label class="field">Company<input data-k="clientCompany" value="${esc(draft.clientCompany || "")}" /></label>
      <label class="field ${draft.clientEmail ? "" : "missing"}">Client email${draft.clientEmail ? "" : " (needed)"}<input data-k="clientEmail" type="email" value="${esc(draft.clientEmail || "")}" placeholder="client@example.com" /></label>
      <label class="field">Payment terms (days)<input data-k="dueInDays" type="number" min="0" value="${esc(draft.dueInDays)}" /></label>
    </div>
    <table class="items">
      <thead><tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Price</th><th></th></tr></thead>
      <tbody>${draft.items.map((it, n) => `<tr data-n="${n}">
        <td><input data-i="name" value="${esc(it.name)}" /></td>
        <td class="num" style="width:70px"><input data-i="quantity" type="number" step="0.25" value="${esc(it.quantity)}" /></td>
        <td style="width:118px"><select data-i="unit">${["HOURS", "QUANTITY", "AMOUNT"].map((u) => `<option ${u === it.unit ? "selected" : ""}>${u}</option>`).join("")}</select></td>
        <td class="num" style="width:100px"><input data-i="unitPrice" type="number" step="0.01" value="${esc(it.unitPrice)}" /></td>
        <td class="x"><button type="button" data-remove="${n}" aria-label="Remove item">×</button></td></tr>`).join("")}</tbody>
    </table>
    <button type="button" class="link" id="add-item">+ Add line</button>
    <div class="draft-total"><span class="muted">Total</span><strong>${fmt(total, draft.currency)}</strong></div>
    <label class="field">Note to client<textarea data-k="note" rows="2" style="min-height:60px">${esc(draft.note)}</textarea></label>
    ${draft.assumptions?.length ? `<div class="assumptions">${draft.assumptions.map((a) => `<span class="assumption">${esc(a)}</span>`).join("")}</div>` : ""}
    <div class="draft-actions">
      <button type="button" class="btn ghost" id="discard">Discard</button>
      <button type="button" class="btn paypal" id="send-invoice">Create & send PayPal invoice</button>
    </div>`;
}

$("#draft").addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.k) draft[t.dataset.k] = t.value;
  if (t.dataset.i) {
    const n = Number(t.closest("tr").dataset.n);
    draft.items[n][t.dataset.i] = ["quantity", "unitPrice"].includes(t.dataset.i) ? Number(t.value) : t.value;
    const total = draft.items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0);
    $(".draft-total strong").textContent = fmt(total, draft.currency);
  }
  if (t.dataset.k === "clientEmail") t.closest(".field").classList.toggle("missing", !t.value);
});

$("#draft").addEventListener("click", async (e) => {
  if (e.target.dataset.remove) {
    draft.items.splice(Number(e.target.dataset.remove), 1);
    renderDraft();
  } else if (e.target.id === "add-item") {
    draft.items.push({ name: "", quantity: 1, unitPrice: 0, unit: "QUANTITY" });
    renderDraft();
  } else if (e.target.id === "discard") {
    draft = null;
    renderDraft();
  } else if (e.target.id === "send-invoice") {
    if (!draft.clientEmail) return toast("Add the client's email first.", true);
    await busy(e.target, "Sending via PayPal…", async () => {
      const inv = await api("/api/invoices", { body: draft });
      toast(`Invoice ${inv.number} sent to ${inv.client.email}`);
      draft = null;
      image = null;
      $("#compose-text").value = "";
      $("#attach-label").textContent = "Attach timesheet / screenshot";
      $(".attach").classList.remove("has");
      renderDraft();
      await load();
    });
  }
});

$("#compose-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#compose-text").value;
  if (!text.trim() && !image) return toast("Describe the work first.", true);
  await busy($("#draft-btn"), "Reading…", async () => {
    draft = await api("/api/extract", { body: { text, image } });
    renderDraft();
  });
});

$("#compose-image").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    image = r.result;
    $("#attach-label").textContent = f.name;
    $(".attach").classList.add("has");
  };
  r.readAsDataURL(f);
});

document.querySelectorAll("[data-example]").forEach((b) => b.addEventListener("click", () => ($("#compose-text").value = b.dataset.example)));

// ---------------- Agent inbox ----------------
$("#approvals").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const card = btn.closest("[data-id]");
  const id = card.dataset.id;
  if (btn.dataset.act === "approve") {
    await busy(btn, "Sending…", async () => {
      await api(`/api/invoices/${id}/approve`, { body: { message: $(".proposal-msg", card).value } });
      toast("Sent through PayPal");
      await load();
    });
  } else if (btn.dataset.act === "reject") {
    await api(`/api/invoices/${id}/reject`, { method: "POST" });
    await load();
  } else if (btn.dataset.act === "resolve") {
    await api(`/api/invoices/${id}/resolve`, { method: "POST" });
    await load();
  } else if (btn.dataset.act === "open") openDrawer(id);
});

$("#run-agent").addEventListener("click", (e) =>
  busy(e.currentTarget, "Agent is reviewing…", async () => {
    const r = await api("/api/autopilot/run", { method: "POST" });
    lastRun = r.results.filter((x) => x.error || !x.actions?.some((a) => a.queued));
    toast(r.checked ? `Agent reviewed ${r.checked} overdue invoice${r.checked > 1 ? "s" : ""}` : "Nothing overdue needs a check today");
    await load();
  }),
);

// ---------------- Table & drawer events ----------------
$("#invoice-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-id]");
  if (tr) openDrawer(tr.dataset.id);
});
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  filter = b.dataset.filter;
  document.querySelectorAll("#filters .chip").forEach((c) => c.classList.toggle("active", c === b));
  renderRows();
});
$("#drawer").addEventListener("click", async (e) => {
  if (e.target === $("#drawer")) return closeDrawer();
  const o = e.target.closest("[data-open]");
  if (o) { e.preventDefault(); return openDrawer(o.dataset.open); }
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "chase") {
    await busy(btn, "Agent is thinking…", async () => {
      const r = await api(`/api/invoices/${openId}/chase`, { method: "POST" });
      toast(r.actions?.some((a) => a.queued) ? "Agent proposed a follow-up. Check the inbox." : "Agent finished");
      await load();
    });
  } else if (act === "sync") {
    await busy(btn, "Syncing…", async () => { await api(`/api/invoices/${openId}/sync`, { method: "POST" }); await load(); });
  } else if (act === "record") {
    await busy(btn, "Recording…", async () => { await api(`/api/invoices/${openId}/record-payment`, { method: "POST" }); toast("Payment recorded in PayPal"); await load(); });
  }
});
$("#drawer-close").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());

$("#sync-btn").addEventListener("click", (e) =>
  busy(e.currentTarget, "Syncing…", async () => {
    const r = await api("/api/sync", { method: "POST" });
    toast(r.changed ? `${r.changed} invoice${r.changed > 1 ? "s" : ""} updated from PayPal` : "Everything is up to date");
    await load();
  }),
);

// ---------------- Top bar ----------------
document.querySelectorAll(".clock [data-days]").forEach((b) =>
  b.addEventListener("click", async () => { await api("/api/clock", { body: { days: Number(b.dataset.days) } }); lastRun = []; await load(); }),
);
$("#clock-reset").addEventListener("click", async () => { await api("/api/clock", { body: { reset: true } }); lastRun = []; await load(); });
$("#autopilot").addEventListener("change", async (e) => {
  await api("/api/settings", { method: "PATCH", body: { autopilot: e.target.checked } });
  toast(e.target.checked ? "Autopilot on: the agent will send reminders itself" : "Autopilot off: the agent proposes, you approve");
  await load();
});

const dlg = $("#settings");
$("#settings-btn").addEventListener("click", () => {
  const f = $("#settings-form");
  for (const k of ["businessName", "ownerName", "currency", "tone"]) f.elements[k].value = S.settings[k];
  dlg.showModal();
});
dlg.addEventListener("close", async () => {
  if (dlg.returnValue !== "save") return;
  const f = $("#settings-form");
  const body = Object.fromEntries(["businessName", "ownerName", "currency", "tone"].map((k) => [k, f.elements[k].value]));
  await api("/api/settings", { method: "PATCH", body });
  await load();
});
$("#demo-reset").addEventListener("click", async () => {
  if (!confirm("Reset all local demo data? (Invoices already in PayPal are not deleted.)")) return;
  await api("/api/demo/reset", { method: "POST" });
  dlg.close();
  lastRun = [];
  await load();
  toast("Demo data reset");
});

load().catch((e) => toast(e.message, true));
setInterval(() => { if (!document.hidden && !document.querySelector(".btn:disabled") && !draft && !["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)) load().catch(() => {}); }, 15000);
