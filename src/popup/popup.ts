/** The popup: setup, then the sync status. Everything shown is set with textContent. */

import { normalizeAddress, originPattern, LedgerError } from "../ledger/api";
import { load, save, type Saved } from "../storage";
import { countLines } from "../counts";

declare const __VERSION__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Ledger's accents (teal left out). */
const ACCENTS: Array<[string, string]> = [
  ["Cobalt", "#2851d6"],
  ["Violet", "#6d3fd1"],
  ["Graphite", "#1f2937"],
  ["Forest", "#2f6b3b"],
  ["Plum", "#86307a"],
];

const PROBLEMS: Record<string, { title: string; body: string; action: "amazon" | "outline" | "sync" | "reconnect" }> = {
  amazon_signed_out: { title: "Sign in to Amazon", body: "Amazon signed you out. Sign in and sync picks back up.", action: "amazon" },
  captcha: { title: "Amazon wants a quick check", body: "Open Amazon and finish it.", action: "amazon" },
  parse_failed: { title: "Amazon changed its pages", body: "Update the extension", action: "outline" },
  ledger_error: { title: "Ledger couldn't save the orders", body: "It'll try again next sync.", action: "sync" },
  ledger_unreachable: { title: "Ledger can't be reached", body: "Check that it's running.", action: "sync" },
  reconnect: { title: "Reconnect to Ledger", body: "This extension was signed out.", action: "reconnect" },
  tab_closed: { title: "Sync stopped", body: "The sync tab was closed. It'll try again next sync.", action: "sync" },
  amazon_error: { title: "Couldn't open Amazon", body: "It'll try again next sync.", action: "sync" },
};

const ACTION_LABEL = { amazon: "Open Amazon", outline: "Copy Page Outline", sync: "Sync Now", reconnect: "Reconnect" };

function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "About 8:15 PM", or "Tomorrow about 1:10 AM". */
function nextLabel(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `About ${time}` : `Tomorrow about ${time}`;
}

const dayLabel = (iso: string | null | undefined) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "");

function send<T = { ok?: boolean; error?: string; message?: string; outline?: string }>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg);
}

function setAccent(color: string) {
  document.documentElement.style.setProperty("--accent", color);
}

let currentAction: keyof typeof ACTION_LABEL = "sync";

async function render() {
  const s = await load();
  setAccent(s.accent ?? ACCENTS[0]![1]);
  const connected = !!s.token && s.localProblem !== "reconnect";
  $("setup").hidden = connected;
  $("connected").hidden = !connected;
  $("title").textContent = connected ? "Ledger for Amazon" : "Connect to Ledger";
  if (!connected) {
    if (s.ledger && !$<HTMLInputElement>("ledger").value) $<HTMLInputElement>("ledger").value = s.ledger;
    return;
  }

  const problemKey = s.localProblem ?? (s.lastStatus && s.lastStatus !== "ok" ? s.lastStatus : null);
  const problem = problemKey ? PROBLEMS[problemKey] : null;
  $("problem").hidden = !problem;
  $("dot").style.background = problem ? "var(--amber)" : "var(--good)";
  // A sync that started over 30 minutes ago and never finished has stopped.
  const running = !!s.running && !!s.runStartedAt && Date.now() - Date.parse(s.runStartedAt) < 30 * 60_000;
  $("status-word").textContent = running ? "Syncing" : problem ? "Sync paused" : "Connected";
  $("status-when").textContent = s.lastRunAt && !running ? `· last sync ${when(s.lastRunAt)}` : "";
  if (problem) {
    $("problem-title").textContent = problem.title;
    const unavailable = problemKey === "parse_failed" && s.failedSection === "order_unavailable";
    $("problem-title").textContent = unavailable ? "Amazon wouldn't show order details" : problem.title;
    $("problem-body").textContent = unavailable
      ? "It'll try again next sync."
      : problemKey === "parse_failed" && s.failedSection
        ? `${problem.body} · ${s.failedSection.replace(/_/g, " ")}`
        : problem.body;
  }
  currentAction = problem?.action ?? "sync";
  $("main-action").classList.toggle("no-icon", currentAction !== "sync");
  $("main-label").textContent = running && currentAction === "sync" ? "Syncing…" : ACTION_LABEL[currentAction];
  $<HTMLButtonElement>("main-action").disabled = running && currentAction === "sync";
  // When the main button does something else, Sync Now is still one click away.
  $("retry").hidden = currentAction === "sync" || running;

  $("split").textContent = String(s.chargesSplitThisMonth ?? 0);
  $("waiting").textContent = String(s.ordersWaiting ?? 0);

  const auto = s.autoSync !== false;
  $("auto").setAttribute("aria-checked", String(auto));
  const alarm = auto ? await chrome.alarms.get("sync") : undefined;
  $("next").textContent = !auto ? "Off" : alarm ? nextLabel(alarm.scheduledTime) : "Soon";

  $("through").textContent = s.syncedThrough ? `Synced through ${dayLabel(s.syncedThrough)}${s.syncFrom ? ` · started from ${dayLabel(s.syncFrom)}` : ""}` : "";

  const [runOrders, runResult] = countLines(s.lastCounts);
  $("run-orders").textContent = runOrders;
  $("run-result").textContent = runResult;
  // A sync that read little or nothing: offer the masked outline even without a problem shown.
  const c = s.lastCounts;
  $("outline-link").hidden = !c || currentAction === "outline" || !(c.unreadable > 0 || c.listed <= 1);

  const swatches = $("swatches");
  swatches.replaceChildren(
    ...ACCENTS.map(([name, color]) => {
      const b = document.createElement("button");
      b.className = "swatch";
      b.style.background = color;
      b.setAttribute("aria-label", name);
      b.setAttribute("aria-pressed", String((s.accent ?? ACCENTS[0]![1]) === color));
      b.addEventListener("click", () => void save({ accent: color }));
      return b;
    }),
  );
}

$("version").textContent = `v${__VERSION__}`;

$<HTMLFormElement>("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("setup-error");
  err.hidden = true;
  const button = $<HTMLButtonElement>("connect");
  const password = $<HTMLInputElement>("password");
  try {
    const ledger = normalizeAddress($<HTMLInputElement>("ledger").value);
    // Asked here, while the click counts: lets the extension reach this one address and nothing else.
    const granted = await chrome.permissions.request({ origins: [originPattern(ledger)] });
    if (!granted) throw new Error("Chrome needs permission to reach Ledger");
    button.disabled = true;
    button.textContent = "Connecting…";
    const r = await send({ type: "connect", ledger, username: $<HTMLInputElement>("username").value, password: password.value, code: $<HTMLInputElement>("code").value });
    if (r.error) throw new Error(r.message ?? "Couldn't connect");
    $<HTMLInputElement>("code").value = "";
  } catch (error) {
    err.textContent = error instanceof LedgerError || error instanceof Error ? error.message : "Couldn't connect";
    err.hidden = false;
  } finally {
    // The password is never kept, not even in the form.
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
      await save({ token: undefined, localProblem: null });
      await chrome.storage.local.remove("token");
      return;
    case "outline":
      await copyOutline($("main-label"), ACTION_LABEL.outline);
      return;
    default:
      await send({ type: "sync" });
  }
});

async function copyOutline(label: HTMLElement, restore: string) {
  label.textContent = "Reading the page…";
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
  }, 2000);
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
  const s: Saved = await load();
  if (s.ledger) await chrome.tabs.create({ url: s.ledger });
});

$("disconnect").addEventListener("click", async () => {
  await send({ type: "disconnect" });
});

chrome.storage.onChanged.addListener(() => void render());
void render();
