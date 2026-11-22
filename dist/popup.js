// src/ledger/api.ts
var LedgerError = class extends Error {
  constructor(kind, code, message, status = 0) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.status = status;
    this.name = "LedgerError";
  }
};
function normalizeAddress(raw) {
  let text = raw.trim();
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new LedgerError("refused", "bad_address", "That doesn't look like an address");
  }
  if (url.protocol !== "https:") throw new LedgerError("refused", "not_https", "Ledger's address must start with https://");
  if (url.username || url.password) throw new LedgerError("refused", "bad_address", "Leave the username out of the address");
  return url.origin + url.pathname.replace(/\/+$/, "");
}
var originPattern = (base) => `${new URL(base).origin}/*`;

// src/storage.ts
var KEYS = [
  "ledger",
  "token",
  "tokenExpiresAt",
  "autoSync",
  "accent",
  "lastRunAt",
  "lastStatus",
  "failedSection",
  "localProblem",
  "waitingSince",
  "ordersWaiting",
  "chargesSplitThisMonth",
  "syncedThrough",
  "syncFrom",
  "running",
  "runStartedAt",
  "lastCounts",
  "ledgerFrom"
];
async function load() {
  return await chrome.storage.local.get(KEYS);
}
async function save(patch) {
  await chrome.storage.local.set(patch);
}

// src/counts.ts
function countLines(c) {
  if (!c) return ["", ""];
  const parts = (pairs) => pairs.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`);
  const skipped = parts([["digital", c.digital], ["cancelled", c.cancelled], ["unreadable", c.unreadable]]);
  const skipTotal = c.digital + c.cancelled + c.unreadable;
  const first = [`Orders ${c.listed}`, `Sent ${c.sent}`, ...parts([["Done before", c.finished]]), ...skipTotal ? [`Skipped ${skipTotal} (${skipped.join(", ")})`] : []];
  const second = [`Split ${c.split}`, ...parts([["Waiting", c.waiting], ["No match", c.noMatch], ["No charge list", c.noChargeList]]), ...c.items ? [`Categories ${c.categorized}/${c.items}`] : []];
  return [first.join(" \xB7 "), second.join(" \xB7 ")];
}

// src/popup/popup.ts
var $ = (id) => document.getElementById(id);
var ACCENTS = [
  ["Cobalt", "#2851d6"],
  ["Violet", "#6d3fd1"],
  ["Graphite", "#1f2937"],
  ["Forest", "#2f6b3b"],
  ["Plum", "#86307a"]
];
var PROBLEMS = {
  amazon_signed_out: { title: "Sign in to Amazon", body: "Amazon signed you out. Sign in and sync picks back up.", action: "amazon" },
  captcha: { title: "Amazon wants a quick check", body: "Open Amazon and finish it.", action: "amazon" },
  parse_failed: { title: "Amazon changed its pages", body: "Update the extension", action: "outline" },
  ledger_error: { title: "Ledger couldn't save the orders", body: "It'll try again next sync.", action: "sync" },
  ledger_unreachable: { title: "Ledger can't be reached", body: "Check that it's running.", action: "sync" },
  reconnect: { title: "Reconnect to Ledger", body: "This extension was signed out.", action: "reconnect" },
  tab_closed: { title: "Sync stopped", body: "The sync tab was closed. It'll try again next sync.", action: "sync" },
  amazon_error: { title: "Couldn't open Amazon", body: "It'll try again next sync.", action: "sync" }
};
var ACTION_LABEL = { amazon: "Open Amazon", outline: "Copy Page Outline", sync: "Sync Now", reconnect: "Reconnect" };
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = (/* @__PURE__ */ new Date()).toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function nextLabel(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === (/* @__PURE__ */ new Date()).toDateString() ? `About ${time}` : `Tomorrow about ${time}`;
}
var dayLabel = (iso) => iso ? (/* @__PURE__ */ new Date(`${iso}T12:00:00`)).toLocaleDateString([], { month: "short", day: "numeric" }) : "";
function send(msg) {
  return chrome.runtime.sendMessage(msg);
}
function setAccent(color) {
  document.documentElement.style.setProperty("--accent", color);
}
var currentAction = "sync";
async function render() {
  const s = await load();
  setAccent(s.accent ?? ACCENTS[0][1]);
  const connected = !!s.token && s.localProblem !== "reconnect";
  $("setup").hidden = connected;
  $("connected").hidden = !connected;
  $("title").textContent = connected ? "Ledger for Amazon" : "Connect to Ledger";
  if (!connected) {
    if (s.ledger && !$("ledger").value) $("ledger").value = s.ledger;
    return;
  }
  const problemKey = s.localProblem ?? (s.lastStatus && s.lastStatus !== "ok" ? s.lastStatus : null);
  const problem = problemKey ? PROBLEMS[problemKey] : null;
  $("problem").hidden = !problem;
  $("dot").style.background = problem ? "var(--amber)" : "var(--good)";
  const running = !!s.running && !!s.runStartedAt && Date.now() - Date.parse(s.runStartedAt) < 30 * 6e4;
  $("status-word").textContent = running ? "Syncing" : problem ? "Sync paused" : "Connected";
  $("status-when").textContent = s.lastRunAt && !running ? `\xB7 last sync ${when(s.lastRunAt)}` : "";
  if (problem) {
    $("problem-title").textContent = problem.title;
    const unavailable = problemKey === "parse_failed" && s.failedSection === "order_unavailable";
    $("problem-title").textContent = unavailable ? "Amazon wouldn't show order details" : problem.title;
    $("problem-body").textContent = unavailable ? "It'll try again next sync." : problemKey === "parse_failed" && s.failedSection ? `${problem.body} \xB7 ${s.failedSection.replace(/_/g, " ")}` : problem.body;
  }
  currentAction = problem?.action ?? "sync";
  $("main-action").classList.toggle("no-icon", currentAction !== "sync");
  $("main-label").textContent = running && currentAction === "sync" ? "Syncing\u2026" : ACTION_LABEL[currentAction];
  $("main-action").disabled = running && currentAction === "sync";
  $("retry").hidden = currentAction === "sync" || running;
  $("split").textContent = String(s.chargesSplitThisMonth ?? 0);
  $("waiting").textContent = String(s.ordersWaiting ?? 0);
  const auto = s.autoSync !== false;
  $("auto").setAttribute("aria-checked", String(auto));
  const alarm = auto ? await chrome.alarms.get("sync") : void 0;
  $("next").textContent = !auto ? "Off" : alarm ? nextLabel(alarm.scheduledTime) : "Soon";
  $("through").textContent = s.syncedThrough ? `Synced through ${dayLabel(s.syncedThrough)}${s.syncFrom ? ` \xB7 started from ${dayLabel(s.syncFrom)}` : ""}` : "";
  const [runOrders, runResult] = countLines(s.lastCounts);
  $("run-orders").textContent = runOrders;
  $("run-result").textContent = runResult;
  const c = s.lastCounts;
  $("outline-link").hidden = !c || currentAction === "outline" || !(c.unreadable > 0 || c.listed <= 1);
  const swatches = $("swatches");
  swatches.replaceChildren(
    ...ACCENTS.map(([name, color]) => {
      const b = document.createElement("button");
      b.className = "swatch";
      b.style.background = color;
      b.setAttribute("aria-label", name);
      b.setAttribute("aria-pressed", String((s.accent ?? ACCENTS[0][1]) === color));
      b.addEventListener("click", () => void save({ accent: color }));
      return b;
    })
  );
}
$("version").textContent = `v${"0.3.1"}`;
$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("setup-error");
  err.hidden = true;
  const button = $("connect");
  const password = $("password");
  try {
    const ledger = normalizeAddress($("ledger").value);
    const granted = await chrome.permissions.request({ origins: [originPattern(ledger)] });
    if (!granted) throw new Error("Chrome needs permission to reach Ledger");
    button.disabled = true;
    button.textContent = "Connecting\u2026";
    const r = await send({ type: "connect", ledger, username: $("username").value, password: password.value, code: $("code").value });
    if (r.error) throw new Error(r.message ?? "Couldn't connect");
    $("code").value = "";
  } catch (error) {
    err.textContent = error instanceof LedgerError || error instanceof Error ? error.message : "Couldn't connect";
    err.hidden = false;
  } finally {
    password.value = "";
    button.disabled = false;
    button.textContent = "Connect";
    void render();
  }
});
$("main-action").addEventListener("click", async () => {
  switch (currentAction) {
    case "amazon":
      await chrome.tabs.create({ url: "https://www.amazon.com/your-orders/orders" });
      return;
    case "reconnect":
      await save({ token: void 0, localProblem: null });
      await chrome.storage.local.remove("token");
      return;
    case "outline":
      await copyOutline($("main-label"), ACTION_LABEL.outline);
      return;
    default:
      await send({ type: "sync" });
  }
});
async function copyOutline(label, restore) {
  label.textContent = "Reading the page\u2026";
  const r = await send({ type: "outline" });
  if (r.outline) {
    await navigator.clipboard.writeText(r.outline);
    label.textContent = "Copied";
  } else {
    label.textContent = "Couldn't read it";
  }
  setTimeout(() => {
    label.textContent = restore;
    void render();
  }, 2e3);
}
$("outline-link").addEventListener("click", () => void copyOutline($("outline-link"), "Copy Page Outline"));
$("auto").addEventListener("click", async () => {
  const on = $("auto").getAttribute("aria-checked") !== "true";
  await send({ type: "auto", on });
});
$("retry").addEventListener("click", async () => {
  await send({ type: "sync" });
});
$("open-ledger").addEventListener("click", async () => {
  const s = await load();
  if (s.ledger) await chrome.tabs.create({ url: s.ledger });
});
$("disconnect").addEventListener("click", async () => {
  await send({ type: "disconnect" });
});
chrome.storage.onChanged.addListener(() => void render());
void render();
