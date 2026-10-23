import { prepare, predict, bucketText, hoursText } from "./engine.js";
import { CONTACT_METHOD, FORM_FIELDS, TICKET_TYPES } from "./fields.js";
import { inspectPage } from "./diag.js";

const $ = (id) => document.getElementById(id);
const NONE = "";
const FOOTNOTE = "Fills in the form for you. You still save it yourself.";
let model = null, current = null, timer = null, hasUrl = false;

const FIELD_TITLES = { priority: "Priority", category: "Category", record_source: "Record source" };

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function updateFill() { $("fill").disabled = !hasUrl || !current; }

function showSettings(on) {
  $("view-settings").hidden = !on;
  for (const id of ["main-header", "view-main", "main-footer"]) $(id).hidden = on;
}

async function init() {
  try {
    const blob = await (await fetch(chrome.runtime.getURL("model/model.json"))).json();
    model = prepare(blob);
    $("status").textContent = `${blob.tickets.ids.length.toLocaleString()} past tickets loaded. ${FOOTNOTE}`;
  } catch (e) {
    $("status").textContent = "Model not found: run python src/export.py and copy extension/model/model.json here.";
  }
  const { draft } = await chrome.storage.session.get("draft"); // survives closing the popup; cleared when the browser closes
  if (draft) { $("desc").value = draft; analyze(); }
  const { contactUrl, location, group, assignee } = await chrome.storage.local.get(["contactUrl", "location", "group", "assignee"]);
  $("url").value = contactUrl || "";
  $("location").value = location || "";
  $("group").value = group || "";
  $("assignee").value = assignee || "";
  hasUrl = !!contactUrl;
  showSettings(!contactUrl);
  updateFill();
}

// Mask EID, email and phone patterns so they never reach the model.
function scrub(text) {
  const c = model.cfg;
  return ["EID_PATTERN", "EMAIL_PATTERN", "PHONE_PATTERN"].reduce((t, k) => t.replace(new RegExp(c[k], "g"), " "), text);
}

function renderVerdict(r) {
  const c = model.cfg, t = r.time;
  const conf = Math.round((r.inquiry ? r.p_inquiry : 1 - r.p_inquiry) * 100);
  $("verdict-pill").textContent = r.inquiry ? "General inquiry" : "Incident";
  $("confidence").textContent = `${conf}% confident`;

  const v = $("verdict");
  v.classList.toggle("small", r.inquiry);
  v.textContent = r.inquiry ? c.AT_THE_WINDOW_LABEL.toLowerCase().replace(/^./, (s) => s.toUpperCase()) : `~${hoursText(t.median)}`;
  $("verdict-sub").textContent = r.inquiry ? `if it's an incident, ~${hoursText(t.median)}` : `usually ${bucketText(t.median, c.BUCKET_EDGES)}`;

  // Range bar: typical range (low to high) with the median as a dot
  const max = Math.max(t.high, t.median, 0.01) * 1.25;
  const pct = (h) => `${Math.min(100, (h / max) * 100)}%`;
  $("range-fill").style.left = pct(t.low);
  $("range-fill").style.width = `${Math.max(1, ((t.high - t.low) / max) * 100)}%`;
  $("range-dot").style.left = pct(t.median);

  $("range-best").textContent = `Best ${hoursText(t.best)}`;
  $("range-typical").textContent = `Usually ${hoursText(t.low)} to ${hoursText(t.high)}`;
  $("range-count").textContent = t.rough ? "few matches" : `${t.matches} similar`;
  $("time").textContent = t.rough ? "Rough estimate: only a few close matches." : "";
}

function renderTicketType(r) {
  const pre = r.inquiry ? TICKET_TYPES[0] : TICKET_TYPES[1];
  const sel = $("ticket-type");
  sel.replaceChildren(...TICKET_TYPES.map((t) => new Option(t, t, t === pre, t === pre)), new Option("(don't fill)", NONE));
  const seg = $("type-seg");
  seg.replaceChildren(...[...sel.options].map((o) => {
    const b = el("button", "", o.value === NONE ? "Don't fill" : o.text);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => { sel.value = o.value; syncTicketType(); });
    b.dataset.value = o.value;
    return b;
  }));
  syncTicketType();
}

function syncTicketType() {
  const value = $("ticket-type").value;
  for (const b of $("type-seg").children) b.setAttribute("aria-checked", String(b.dataset.value === value));
  const hint = $("type-hint");
  hint.textContent = value === NONE ? "Won't be filled" : "Will be filled";
  hint.className = value === NONE ? "faint" : "ok";
}

function render(r) {
  $("result").hidden = false;
  $("empty").hidden = true;
  renderVerdict(r);
  renderTicketType(r);

  const info = $("info");
  info.replaceChildren();
  for (const [name, guesses] of Object.entries(r.fields)) {
    const row = el("div", "row");
    const [value, p] = guesses[0];
    row.append(el("span", "k", FIELD_TITLES[name] || name), el("span", "v", value),
      el("span", "p", guesses.length > 1 ? `${Math.round(p * 100)}%` : "default"));
    if (guesses.length > 1) row.title = guesses.map(([v, q]) => `${v} (${Math.round(q * 100)}%)`).join(", ");
    info.append(row);
  }

  $("suggest-box").hidden = !r.suggestion;
  $("no-suggest").hidden = !!r.suggestion;
  $("use-suggest").checked = false;
  if (r.suggestion) $("suggest-text").textContent = r.suggestion;

  const list = $("similar");
  list.replaceChildren();
  for (const s of r.similar) {
    const li = el("li");
    const head = el("div", "sim-head");
    head.append(el("b", "sim-id", s.id), el("span", "pill pill-soft", `${Math.round(s.sim * 100)}% match`));
    li.append(head, el("p", "sim-text", s.text.slice(0, 120)));
    list.append(li);
  }
}

function analyze() {
  const text = $("desc").value.trim();
  if (!model || text.length < 3) {
    $("result").hidden = true;
    $("empty").hidden = false;
    current = null;
  } else {
    current = predict(model, scrub(text));
    render(current);
  }
  updateFill();
}

$("desc").addEventListener("input", () => {
  chrome.storage.session.set({ draft: $("desc").value }); // the description only; the EID is never saved
  clearTimeout(timer);
  timer = setTimeout(analyze, 300);
});

$("clear").addEventListener("click", () => {
  $("desc").value = "";
  $("eid").value = "";
  chrome.storage.session.remove("draft");
  analyze();
});

$("open-settings").addEventListener("click", () => showSettings(true));
$("close-settings").addEventListener("click", () => showSettings(false));

$("fill").addEventListener("click", () => {
  if (!current) return;
  const values = { contactMethod: CONTACT_METHOD, eid: $("eid").value.trim(),
    location: $("location").value.trim(), assignmentGroup: $("group").value.trim(), assignedTo: $("assignee").value.trim() };
  values.shortDescription = $("use-suggest").checked && current.suggestion ? current.suggestion : $("desc").value.trim();
  values.ticketType = $("ticket-type").value;
  chrome.runtime.sendMessage({ type: "autofill", values });
  $("eid").value = ""; // never kept
  $("status").textContent = "Opening the new contact page...";
});

$("save-settings").addEventListener("click", async () => {
  const msg = $("url-msg");
  try {
    const u = new URL($("url").value.trim());
    if (u.protocol !== "https:") throw new Error("Use an https:// address.");
    const origin = `${u.origin}/*`;
    if (!(await chrome.permissions.contains({ origins: [origin] })) && !(await chrome.permissions.request({ origins: [origin] }))) {
      throw new Error("Permission to fill that site was not granted.");
    }
    await chrome.storage.local.set({ contactUrl: u.href, location: $("location").value.trim(), group: $("group").value.trim(), assignee: $("assignee").value.trim() });
    hasUrl = true;
    updateFill();
    msg.textContent = "Saved.";
  } catch (e) {
    msg.textContent = e.message || "Not a valid URL.";
  }
});

$("check").addEventListener("click", async () => {
  const out = $("report");
  out.hidden = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: inspectPage, args: [FORM_FIELDS.map((f) => f.label)] });
    const frames = res.map((r) => r.result).filter((r) => r && (r.labels || r.iframes || r.controls));
    out.value = JSON.stringify({ frames: frames.length ? frames : "no form fields found in any frame" }, null, 1);
  } catch (e) {
    out.value = "Could not read this page: " + e.message + "\n(Save the contact page URL in Settings first so Chrome allows access to that site.)";
  }
  out.select();
});

init();
