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
  "running"
];
async function load() {
  return await chrome.storage.local.get(KEYS);
}
async function save(patch) {
  await chrome.storage.local.set(patch);
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
  reconnect: { title: "Reconnect to Ledger", body: "This extension was signed out.", action: "reconnect" }
};
var ACTION_LABEL = { amazon: "Open Amazon", outline: "Copy Page Outline", sync: "Sync Now", reconnect: "Reconnect" };
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = (/* @__PURE__ */ new Date()).toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
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
  $("status-word").textContent = s.running ? "Syncing" : problem ? "Sync paused" : "Connected";
  $("status-when").textContent = s.lastRunAt && !s.running ? `\xB7 last sync ${when(s.lastRunAt)}` : "";
  if (problem) {
    $("problem-title").textContent = problem.title;
    $("problem-body").textContent = problemKey === "parse_failed" && s.failedSection ? `${problem.body} \xB7 ${s.failedSection.replace(/_/g, " ")}` : problem.body;
  }
  currentAction = problem?.action ?? "sync";
  $("main-action").classList.toggle("no-icon", currentAction !== "sync");
  $("main-label").textContent = s.running && currentAction === "sync" ? "Syncing\u2026" : ACTION_LABEL[currentAction];
  $("main-action").disabled = !!s.running && currentAction === "sync";
  $("split").textContent = String(s.chargesSplitThisMonth ?? 0);
  $("waiting").textContent = String(s.ordersWaiting ?? 0);
  const auto = s.autoSync !== false;
  $("auto").setAttribute("aria-checked", String(auto));
  const alarm = auto ? await chrome.alarms.get("sync") : void 0;
  $("next").textContent = !auto ? "Off" : alarm ? `About ${when(new Date(alarm.scheduledTime).toISOString())}` : "Soon";
  $("through").textContent = s.syncedThrough ? `Synced through ${dayLabel(s.syncedThrough)}${s.syncFrom ? ` \xB7 started from ${dayLabel(s.syncFrom)}` : ""}` : "";
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
$("version").textContent = `v${"0.1.0"}`;
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
    case "outline": {
      $("main-label").textContent = "Reading the page\u2026";
      const r = await send({ type: "outline" });
      if (r.outline) {
        await navigator.clipboard.writeText(r.outline);
        $("main-label").textContent = "Copied";
      } else {
        $("main-label").textContent = "Couldn't read it";
      }
      setTimeout(() => void render(), 2e3);
      return;
    }
    default:
      await send({ type: "sync" });
  }
});
$("auto").addEventListener("click", async () => {
  const on = $("auto").getAttribute("aria-checked") !== "true";
  await send({ type: "auto", on });
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
