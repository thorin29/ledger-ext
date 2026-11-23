// src/ledger/api.ts
var TIMEOUT_MS = 2e4;
var LedgerError = class extends Error {
  constructor(kind, code, message, status2 = 0) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.status = status2;
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
async function call(base, path, init = {}) {
  const headers = { Accept: "application/json" };
  if (init.body !== void 0) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === void 0 ? void 0 : JSON.stringify(init.body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    throw new LedgerError("unreachable", "unreachable", "Ledger can't be reached");
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const code = data?.error?.code ?? `http_${res.status}`;
  const message = data?.error?.message ?? `Ledger answered ${res.status}`;
  if (res.status === 401) throw new LedgerError("signed_out", code, message, 401);
  if (res.status >= 500) throw new LedgerError("server", code, message, res.status);
  throw new LedgerError("refused", code, message, res.status);
}
async function connect(base, username, password, code, name) {
  const { proof } = await call(base, "/api/v1/auth/login", { method: "POST", body: { username, password } });
  const out = await call(base, "/api/v1/auth/enroll", {
    method: "POST",
    body: { proof, code, name, scope: "amazon" }
  });
  if (out.device?.scope !== "amazon") throw new LedgerError("refused", "old_ledger", "Update Ledger to 0.106.0 or later first");
  return { token: out.token, expiresAt: out.expiresAt };
}
var refresh = (base, token) => call(base, "/api/v1/auth/refresh", { method: "POST", token });
var logout = (base, token) => call(base, "/api/v1/auth/logout", { method: "POST", token });
var status = (base, token) => call(base, "/api/v1/amazon/status", { token });
async function unsplit(base, token) {
  try {
    return (await call(base, "/api/v1/amazon/unsplit", { token })).charges;
  } catch (e) {
    if (e instanceof LedgerError && e.status === 404) return null;
    throw e;
  }
}
var sendOrders = (base, token, orders, key) => call(base, "/api/v1/amazon/orders", { method: "POST", token, body: { orders }, idempotencyKey: key });
var reportRun = (base, token, report, key) => call(base, "/api/v1/amazon/runs", { method: "POST", token, body: report, idempotencyKey: key });

// src/amazon/tab.ts
var TabClosedError = class extends Error {
  constructor() {
    super("The sync tab was closed");
    this.name = "TabClosedError";
  }
};
var LOAD_TIMEOUT_MS = 3e4;
var READY_TIMEOUT_MS = 2e4;
var POLL_MS = 500;
var tabId = null;
var cancelled = false;
chrome.tabs.onRemoved.addListener((removed) => {
  if (removed === tabId) {
    tabId = null;
    cancelled = true;
  }
});
function resetTab() {
  cancelled = false;
}
async function stopTab() {
  cancelled = true;
  await closeTab();
}
function checkStopped() {
  if (cancelled) throw new TabClosedError();
}
function probe(kind) {
  const d = document;
  const has = (s) => !!d.querySelector(s);
  const text = d.body?.innerText ?? "";
  let ready = d.readyState === "complete";
  if (has('form[name="signIn"], #ap_email, #ap_password, #captchacharacters')) ready = true;
  else if (kind === "list") {
    const locked = [...d.querySelectorAll(".csd-encrypted-sensitive")].filter((el) => !el.children.length && !(el.textContent ?? "").trim());
    const cards = d.querySelectorAll(".order-card, .js-order-card").length;
    ready = ready && (cards > 0 && locked.length === 0 || /0 orders placed|haven't placed|have not placed/i.test(text));
  } else if (kind === "transactions") {
    ready = ready && (/Order #|no transactions|you have no/i.test(text) || has("form[name*='signIn']"));
  } else if (kind === "order") {
    ready = ready && (has('[data-component="purchasedItems"], .yohtmlc-item, [data-component="orderDate"], [data-component="errorbanner"]') || /ordered on|order placed/i.test(text));
  }
  return { ready, html: d.documentElement.outerHTML, url: location.href };
}
function waitForLoad(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    }
    function onUpdated(changed, info) {
      if (changed === id && info.status === "complete") done();
    }
    function onRemoved(removed) {
      if (removed !== id) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      reject(new TabClosedError());
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}
async function tabExists(id) {
  try {
    await chrome.tabs.get(id);
    return true;
  } catch {
    return false;
  }
}
async function openTab(url) {
  checkStopped();
  if (tabId !== null && await tabExists(tabId)) {
    await chrome.tabs.update(tabId, { url });
    return tabId;
  }
  let windowId;
  try {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
  } catch {
    windowId = void 0;
  }
  if (windowId === void 0) {
    const win = await chrome.windows.create({ url, state: "minimized", focused: false });
    tabId = win.tabs?.[0]?.id ?? null;
  } else {
    const tab = await chrome.tabs.create({ url, active: false, windowId });
    tabId = tab.id ?? null;
  }
  if (tabId === null) throw new TabClosedError();
  await chrome.tabs.update(tabId, { muted: true }).catch(() => void 0);
  return tabId;
}
async function readInTab(url, kind) {
  const id = await openTab(url);
  await waitForLoad(id);
  const started = Date.now();
  for (; ; ) {
    let result;
    try {
      const [frame] = await chrome.scripting.executeScript({ target: { tabId: id }, func: probe, args: [kind] });
      result = frame?.result;
    } catch {
      if (!await tabExists(id)) throw new TabClosedError();
    }
    if (result && (result.ready || Date.now() - started > READY_TIMEOUT_MS)) return { html: result.html, url: result.url };
    if (!result && Date.now() - started > READY_TIMEOUT_MS) throw new Error("Couldn't read the page");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
async function closeTab() {
  if (tabId === null) return;
  const id = tabId;
  tabId = null;
  await chrome.tabs.remove(id).catch(() => void 0);
}
function clickNext() {
  const byName = document.querySelector('input[name*="NextPage"], input[name*="nextPage"]');
  const byText = [...document.querySelectorAll("a, button, span.a-button-text, input[type=submit]")].find(
    (el) => /^next( page)?\s*(→|›)?$/i.test((el.textContent || el.value || "").trim())
  );
  const target = byName ?? byText;
  if (!target || target.closest(".a-button-disabled, .a-disabled, [aria-disabled='true']")) return false;
  (target.closest("span.a-button")?.querySelector("input, a, button") ?? target).click();
  return true;
}
function fingerprint() {
  return (document.body?.innerText ?? "").slice(0, 3e3);
}
async function nextPageInTab(kind) {
  checkStopped();
  if (tabId === null) return null;
  const id = tabId;
  const [before] = await chrome.scripting.executeScript({ target: { tabId: id }, func: fingerprint });
  const [clicked] = await chrome.scripting.executeScript({ target: { tabId: id }, func: clickNext });
  if (!clicked?.result) return null;
  const started = Date.now();
  for (; ; ) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!await tabExists(id)) throw new TabClosedError();
    try {
      const [now] = await chrome.scripting.executeScript({ target: { tabId: id }, func: fingerprint });
      const [frame] = await chrome.scripting.executeScript({ target: { tabId: id }, func: probe, args: [kind] });
      const result = frame?.result;
      if (result && now?.result !== before?.result && result.ready) return { html: result.html, url: result.url };
    } catch {
    }
    if (Date.now() - started > READY_TIMEOUT_MS) return null;
  }
}

// src/amazon/selectors.ts
var TRANSACTIONS = {
  url: "https://www.amazon.com/cpe/yourpayments/transactions",
  /** The "Next page" button (a form submit). */
  next: ['input[name*="NextPage"]', 'span.a-button input[name*="nextPage" i]', ".a-pagination .a-last a[href]"],
  nextText: /^next( page)?\s*(→|›)?$/i,
  last4: /(?:\*{2,}|•{2,}|·{2,}|ending in\s*)\s*(\d{4})/i,
  amount: /([+\-−–]?)\s*\$\s*([\d,]+\.\d{2})/,
  refund: /refund|\+\s*\$/i
};

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
async function forget() {
  await chrome.storage.local.remove([...KEYS.filter((k) => k !== "ledger" && k !== "accent" && k !== "autoSync"), FINISHED, SALT]);
}
var CATEGORIES = "categories";
var DAY = 864e5;
var CATEGORY_MAX = 2e3;
var CATEGORY_DAYS = 180;
var NONE_DAYS = 30;
async function cachedCategory(productId, now = Date.now()) {
  const cache = (await chrome.storage.local.get(CATEGORIES))[CATEGORIES] ?? {};
  const e = cache[productId];
  if (!e) return { hit: false, category: null };
  const days = now / DAY - e.t;
  return days <= (e.c ? CATEGORY_DAYS : NONE_DAYS) ? { hit: true, category: e.c } : { hit: false, category: null };
}
async function saveCategory(productId, category2, now = Date.now()) {
  const cache = (await chrome.storage.local.get(CATEGORIES))[CATEGORIES] ?? {};
  cache[productId] = { c: category2, t: Math.floor(now / DAY) };
  const today = now / DAY;
  let entries = Object.entries(cache).filter(([, e]) => today - e.t <= CATEGORY_DAYS);
  if (entries.length > CATEGORY_MAX) entries = entries.sort((a, b) => b[1].t - a[1].t).slice(0, CATEGORY_MAX);
  await chrome.storage.local.set({ [CATEGORIES]: Object.fromEntries(entries) });
}
var FINISHED = "finished";
var SALT = "salt";
var FINISHED_MAX = 1500;
var FINISHED_DAYS = 180;
async function salt() {
  const got = (await chrome.storage.local.get(SALT))[SALT];
  if (got) return got;
  const fresh = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await chrome.storage.local.set({ [SALT]: fresh });
  return fresh;
}
async function hash(orderId) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${await salt()}:${orderId}`));
  return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function isFinished(orderId) {
  const set = (await chrome.storage.local.get(FINISHED))[FINISHED] ?? {};
  return await hash(orderId) in set;
}
async function markFinished(orderIds, now = Date.now()) {
  const set = (await chrome.storage.local.get(FINISHED))[FINISHED] ?? {};
  const today = Math.floor(now / DAY);
  for (const id of orderIds) set[await hash(id)] = today;
  let entries = Object.entries(set).filter(([, t]) => today - t <= FINISHED_DAYS);
  if (entries.length > FINISHED_MAX) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, FINISHED_MAX);
  await chrome.storage.local.set({ [FINISHED]: Object.fromEntries(entries) });
}
async function clearFinished() {
  await chrome.storage.local.remove(FINISHED);
}

// src/sync.ts
var ORDER_LOOKBACK_DAYS = 30;
var DAY2 = 864e5;
var localFrom = (e) => e instanceof LedgerError && e.kind === "signed_out" ? "reconnect" : "ledger_unreachable";
var shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY2).toISOString().slice(0, 10);
var gap = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY2;
var sameCharge = (a, b) => Math.abs(a.cents - b.cents) <= 1 && gap(a.date, b.date) <= 5 && !(a.last4 && b.last4 && a.last4 !== b.last4);
var emptyCounts = () => ({
  listed: 0,
  finished: 0,
  read: 0,
  sent: 0,
  digital: 0,
  cancelled: 0,
  unreadable: 0,
  split: 0,
  waiting: 0,
  noMatch: 0,
  noChargeList: 0,
  items: 0,
  categorized: 0,
  unsplit: 0,
  found: 0,
  usedTab: 0
});
async function runSync(deps, opts = {}) {
  const maxOrders = opts.maxOrders ?? 150;
  const maxListPages = opts.maxListPages ?? 40;
  const batchSize = opts.batchSize ?? 20;
  const counts = emptyCounts();
  const out = { status: null, failedSection: null, localProblem: null, counts, waitingSince: null, syncFrom: null, ledgerFrom: null, chargesSplitThisMonth: null };
  let st;
  let todoCharges;
  try {
    st = await deps.status();
    todoCharges = await deps.unsplit();
  } catch (e) {
    out.localProblem = localFrom(e);
    return out;
  }
  out.chargesSplitThisMonth = st.chargesSplitThisMonth;
  out.ledgerFrom = st.syncFrom;
  if (opts.previousLedgerFrom && st.syncFrom < opts.previousLedgerFrom) await deps.clearFinished();
  const finish = async (status2, section) => {
    out.status = status2;
    out.failedSection = section;
    counts.usedTab = deps.usedTab() ? 1 : 0;
    try {
      await deps.reportRun(status2, section, counts.waiting);
    } catch (e) {
      out.localProblem = localFrom(e);
    }
    return out;
  };
  const stopFor = (b) => finish(b === "signin" ? "amazon_signed_out" : "captcha", null);
  counts.unsplit = todoCharges ? todoCharges.length : -1;
  if (todoCharges && !todoCharges.length) return finish("ok", null);
  const from = todoCharges ? todoCharges.map((c) => c.date).sort()[0] : [st.syncFrom, opts.waitingSince].filter((d) => !!d).sort()[0];
  out.syncFrom = from;
  const listFrom = shift(from, -ORDER_LOOKBACK_DAYS);
  const wanted = (orderDate) => !todoCharges || !orderDate || todoCharges.some((c) => orderDate <= shift(c.date, 1) && orderDate >= shift(c.date, -ORDER_LOOKBACK_DAYS));
  const remaining = todoCharges ? [...todoCharges] : null;
  const orders = [];
  const failures = /* @__PURE__ */ new Map();
  let tried = 0;
  const readOrder = async (id) => {
    await deps.pause();
    tried++;
    const got = await deps.loadOrder(id);
    if ("blocked" in got) return got.blocked;
    if ("failed" in got) {
      counts.unreadable++;
      failures.set(got.failed, (failures.get(got.failed) ?? 0) + 1);
      return null;
    }
    if ("skip" in got) {
      counts.cancelled++;
      return null;
    }
    return got.ok;
  };
  const keep = (o) => {
    if (!o.charges.length) counts.noChargeList++;
    if (remaining) {
      for (const c of o.charges) {
        const i = remaining.findIndex((u) => sameCharge(c, u));
        if (i >= 0) {
          remaining.splice(i, 1);
          counts.found++;
        }
      }
    }
    orders.push(o);
  };
  const allFound = () => !!remaining && !remaining.length;
  let viaPayments = false;
  if (todoCharges && deps.loadTransactions) {
    const tx = await deps.loadTransactions(shift(from, -5));
    if ("blocked" in tx) return stopFor(tx.blocked);
    if ("ok" in tx && tx.ok.length) {
      viaPayments = true;
      const chargesOf = /* @__PURE__ */ new Map();
      for (const r of tx.ok) {
        for (const id of r.orderIds) chargesOf.set(id, [...chargesOf.get(id) ?? [], { date: r.date, cents: r.cents, last4: r.last4 }]);
      }
      const pool = tx.ok.filter((r) => r.orderIds.length);
      const needed = [];
      for (const u of todoCharges) {
        const i = pool.findIndex((r) => sameCharge({ date: r.date, cents: r.cents, last4: r.last4 }, u));
        if (i < 0) continue;
        counts.found++;
        for (const id of pool[i].orderIds) if (!needed.includes(id)) needed.push(id);
        pool.splice(i, 1);
      }
      for (const id of needed) {
        counts.listed++;
        if (id.startsWith("D")) {
          counts.digital++;
          continue;
        }
        if (tried >= maxOrders) break;
        const read = await readOrder(id);
        if (typeof read === "string") return stopFor(read);
        if (!read) continue;
        read.charges = chargesOf.get(id) ?? read.charges;
        if (!read.charges.length) counts.noChargeList++;
        orders.push(read);
      }
    }
  }
  if (!viaPayments) {
    const ids = [];
    const seen = /* @__PURE__ */ new Set();
    let pages = 0;
    let blind = 0;
    const thisYear = Number(deps.today().slice(0, 4));
    years: for (let year = thisYear; year >= Number(listFrom.slice(0, 4)); year--) {
      let url = deps.listUrl(year);
      while (url) {
        if (pages++ >= maxListPages) break years;
        if (pages > 1) await deps.pause();
        const page = await deps.loadList(url);
        if ("blocked" in page) return stopFor(page.blocked);
        if ("failed" in page) return finish("parse_failed", page.failed);
        if ("skip" in page) break;
        let fresh = 0;
        const dated = page.ok.orders.filter((o) => o.orderDate);
        for (const o of page.ok.orders) {
          if (o.orderDate && o.orderDate < listFrom) continue;
          if (seen.has(o.orderId)) continue;
          seen.add(o.orderId);
          fresh++;
          counts.listed++;
          if (o.orderId.startsWith("D")) {
            counts.digital++;
            continue;
          }
          if (o.orderDate) {
            if (wanted(o.orderDate)) ids.push(o.orderId);
            continue;
          }
          if (await deps.isFinished(o.orderId)) {
            counts.finished++;
            continue;
          }
          if (tried >= maxOrders || allFound()) break years;
          const read = await readOrder(o.orderId);
          if (typeof read === "string") return stopFor(read);
          if (!read) {
            if (++blind >= 3) break years;
            continue;
          }
          blind = 0;
          if (read.orderDate < listFrom) break years;
          if (wanted(read.orderDate)) keep(read);
          if (allFound()) break years;
        }
        if (dated.length && dated.every((o) => o.orderDate < listFrom)) break years;
        if (!fresh) break;
        url = page.ok.nextUrl;
      }
    }
    const todo = [];
    for (const id of ids.reverse()) {
      if (await deps.isFinished(id)) counts.finished++;
      else todo.push(id);
    }
    for (const id of todo) {
      if (allFound() || tried >= maxOrders) break;
      const read = await readOrder(id);
      if (typeof read === "string") return stopFor(read);
      if (read) keep(read);
    }
  }
  counts.read = orders.length;
  if (counts.unreadable >= 3 && counts.unreadable * 2 >= tried || counts.unreadable > 0 && counts.read === 0) {
    const worst = [...failures.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return finish("parse_failed", worst);
  }
  const asked = /* @__PURE__ */ new Map();
  for (const it of orders.flatMap((o) => o.items)) {
    counts.items++;
    if (!it.productId) continue;
    if (!asked.has(it.productId)) {
      const c = await deps.category(it.productId);
      if ("blocked" in c) return stopFor(c.blocked);
      asked.set(it.productId, c.ok);
    }
    it.category = asked.get(it.productId) ?? null;
    if (it.category) counts.categorized++;
  }
  for (let i = 0; i < orders.length; i += batchSize) {
    const batch = orders.slice(i, i + batchSize);
    try {
      const r = await deps.sendOrders(batch);
      counts.sent += batch.length;
      counts.split += r.split;
      counts.waiting += r.waiting;
      counts.noMatch += r.noMatch ?? 0;
      if (r.waitingSince && (!out.waitingSince || r.waitingSince < out.waitingSince)) out.waitingSince = r.waitingSince;
      const done = (r.done ?? []).map((n) => batch[n]?.orderId).filter((id) => !!id);
      if (done.length) await deps.markFinished(done);
    } catch (e) {
      if (e instanceof LedgerError && (e.kind === "server" || e.kind === "refused")) return finish("ledger_error", null);
      out.localProblem = localFrom(e);
      return out;
    }
  }
  return finish("ok", null);
}

// src/background.ts
var VERSION = "0.5.0";
var AMAZON = "https://www.amazon.com";
var ALARM = "sync";
var EVERY_MINUTES = 6 * 60;
var STALE_RUN_MS = 30 * 6e4;
var REFRESH_DAYS = 30;
async function schedule() {
  const s = await load();
  if (!s.token || s.autoSync === false) {
    await chrome.alarms.clear(ALARM);
    return;
  }
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: EVERY_MINUTES });
}
chrome.runtime.onInstalled.addListener(async (details) => {
  await save({ running: false });
  await schedule();
  if (details.reason === "update") {
    await chrome.storage.local.remove(["lastStatus", "failedSection", "localProblem"]);
    const s = await load();
    if (s.token && s.autoSync !== false) await chrome.alarms.create("catch-up", { delayInMinutes: 1 });
  }
});
chrome.runtime.onStartup.addListener(async () => {
  await save({ running: false });
  await schedule();
  const s = await load();
  if (s.token && s.autoSync !== false && (!s.lastRunAt || Date.now() - Date.parse(s.lastRunAt) > EVERY_MINUTES * 6e4)) {
    await chrome.alarms.create("catch-up", { delayInMinutes: 1 });
  }
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM && alarm.name !== "catch-up") return;
  if ((await load()).autoSync === false) return;
  void syncNow();
});
async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.DOM_PARSER], justification: "Read Amazon order pages" });
}
async function closeOffscreen() {
  await chrome.offscreen.closeDocument().catch(() => void 0);
}
async function parse(kind, html, url, orderId) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", kind, html, url, orderId });
}
var useTab = false;
async function readAmazon(url, kind) {
  checkStopped();
  if (useTab) return readInTab(url, kind);
  const page = await fetchAmazon(url);
  if ("blocked" in page) {
    useTab = true;
    return readInTab(url, kind);
  }
  return page;
}
function needsTab(html, got) {
  if (!("failed" in got)) return false;
  return got.failed === "order_unavailable" || got.failed === "orders_list" && html.includes("csd-encrypted-sensitive");
}
async function fetchAmazon(url) {
  const res = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" });
  if (res.status === 503) return { blocked: "captcha" };
  return { html: await res.text(), url: res.url || url, status: res.status };
}
var pause = () => new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
async function loadList(url) {
  const page = await readAmazon(url, "list");
  const got = await parse("list", page.html, page.url);
  if (useTab || !needsTab(page.html, got)) return got;
  useTab = true;
  const again = await readInTab(url, "list");
  return await parse("list", again.html, again.url);
}
async function loadOrder(orderId) {
  const url = `${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`;
  const page = await readAmazon(url, "order");
  let got = await parse("order", page.html, page.url, orderId);
  if (!useTab && needsTab(page.html, got)) {
    useTab = true;
    const again = await readInTab(url, "order");
    got = await parse("order", again.html, again.url, orderId);
  }
  if (!("ok" in got) || got.ok.charges.length) return got;
  await pause();
  const invoice = await readAmazon(`${AMAZON}/gp/css/summary/print.html?orderID=${encodeURIComponent(orderId)}`, "invoice");
  const charges = await parse("charges", invoice.html, invoice.url);
  return "ok" in charges ? { ok: { ...got.ok, charges: charges.ok } } : got;
}
var MAX_TX_PAGES = 8;
async function loadTransactions(since) {
  const rows = /* @__PURE__ */ new Map();
  const add = (list) => list.forEach((r) => rows.set(`${r.date}|${r.cents}|${r.orderIds.join(",")}`, r));
  const enough = (page2) => !page2.hasNext || page2.rows.some((r) => r.date < since);
  let page = await readAmazon(TRANSACTIONS.url, "transactions");
  let got = await parse("transactions", page.html, page.url);
  if ("blocked" in got) return got;
  if (!useTab && (!("ok" in got) || !got.ok.rows.length || !enough(got.ok))) {
    useTab = true;
    page = await readInTab(TRANSACTIONS.url, "transactions");
    got = await parse("transactions", page.html, page.url);
    if ("blocked" in got) return got;
  }
  if (!("ok" in got)) return { failed: "orders_list" };
  add(got.ok.rows);
  for (let n = 1; n < MAX_TX_PAGES && !enough(got.ok); n++) {
    await pause();
    const next = await nextPageInTab("transactions");
    if (!next) break;
    const more = await parse("transactions", next.html, next.url);
    if (!("ok" in more)) break;
    got = more;
    add(more.ok.rows);
  }
  return { ok: [...rows.values()] };
}
var listUrl = (year) => `${AMAZON}/your-orders/orders?timeFilter=year-${year}`;
async function category(productId) {
  if (!/^[A-Z0-9]{10}$/.test(productId)) return { ok: null };
  const cached = await cachedCategory(productId);
  if (cached.hit) return { ok: cached.category };
  checkStopped();
  await pause();
  const page = await fetchAmazon(`${AMAZON}/dp/${productId}`);
  if ("blocked" in page) return page;
  let found = null;
  if (page.status === 200) {
    const got = await parse("category", page.html, page.url);
    if ("blocked" in got) return got;
    found = "ok" in got ? got.ok : null;
  }
  await saveCategory(productId, found);
  return { ok: found };
}
var running = null;
async function freshToken(ledger, token, expiresAt) {
  if (expiresAt && Date.parse(expiresAt) - Date.now() > REFRESH_DAYS * 864e5) return token;
  try {
    const r = await refresh(ledger, token);
    await save({ token: r.token, tokenExpiresAt: r.expiresAt });
    return r.token;
  } catch {
    return token;
  }
}
function syncNow() {
  if (running) return running;
  running = (async () => {
    const s = await load();
    if (!s.ledger || !s.token) return;
    if (s.running && s.runStartedAt && Date.now() - Date.parse(s.runStartedAt) < STALE_RUN_MS) return;
    await save({ running: true, runStartedAt: (/* @__PURE__ */ new Date()).toISOString() });
    useTab = false;
    resetTab();
    try {
      const ledger = s.ledger;
      const token = await freshToken(ledger, s.token, s.tokenExpiresAt);
      const outcome = await runSync(
        {
          listUrl,
          loadList,
          loadOrder,
          loadTransactions,
          category,
          isFinished,
          markFinished: (ids) => markFinished(ids),
          clearFinished,
          status: () => status(ledger, token),
          unsplit: () => unsplit(ledger, token),
          usedTab: () => useTab,
          sendOrders: (orders) => sendOrders(ledger, token, orders, crypto.randomUUID()),
          reportRun: async (status2, section, waiting) => {
            await reportRun(ledger, token, { status: status2, failedSection: section, extensionVersion: VERSION, ordersWaiting: waiting }, crypto.randomUUID());
          },
          pause,
          today: () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)
        },
        { waitingSince: s.waitingSince ?? null, previousLedgerFrom: s.ledgerFrom ?? null }
      );
      const st = outcome.status === "ok" ? await status(ledger, token).catch(() => null) : null;
      await save({
        lastRunAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastStatus: outcome.status ?? s.lastStatus,
        failedSection: outcome.failedSection,
        localProblem: outcome.localProblem,
        ...outcome.status ? { lastCounts: outcome.counts } : {},
        ...outcome.ledgerFrom ? { ledgerFrom: outcome.ledgerFrom } : {},
        ...outcome.status === "ok" ? { waitingSince: outcome.waitingSince, ordersWaiting: outcome.counts.waiting, syncedThrough: (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA"), syncFrom: outcome.syncFrom } : {},
        ...st ? { chargesSplitThisMonth: st.chargesSplitThisMonth } : outcome.chargesSplitThisMonth !== null ? { chargesSplitThisMonth: outcome.chargesSplitThisMonth } : {}
      });
    } catch (e) {
      const problem = e instanceof TabClosedError ? "tab_closed" : e instanceof LedgerError ? "ledger_unreachable" : "amazon_error";
      await save({ lastRunAt: (/* @__PURE__ */ new Date()).toISOString(), localProblem: problem });
    } finally {
      await save({ running: false });
      await closeTab();
      await closeOffscreen();
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
async function handle(msg) {
  switch (msg.type) {
    case "connect": {
      const ledger = normalizeAddress(msg.ledger);
      const r = await connect(ledger, msg.username.trim(), msg.password, msg.code, "Amazon extension");
      await save({ ledger, token: r.token, tokenExpiresAt: r.expiresAt, localProblem: null, lastStatus: void 0, failedSection: null });
      await schedule();
      void syncNow();
      return { ok: true };
    }
    case "disconnect": {
      const s = await load();
      if (s.ledger && s.token) await logout(s.ledger, s.token).catch(() => void 0);
      await forget();
      await chrome.alarms.clear(ALARM);
      if (s.ledger) await chrome.permissions.remove({ origins: [originPattern(s.ledger)] }).catch(() => void 0);
      return { ok: true };
    }
    case "sync":
      void syncNow();
      return { ok: true };
    case "stop":
      await stopTab();
      return { ok: true };
    case "auto":
      await save({ autoSync: msg.on });
      await schedule();
      return { ok: true };
    case "outline": {
      useTab = false;
      resetTab();
      const outlineOf = async (page) => (await parse("outline", page.html, page.url)).outline ?? "";
      const readOrder = async (url, orderId) => {
        let page = await readAmazon(url, "order");
        let got = await parse("order", page.html, page.url, orderId);
        if (!useTab && needsTab(page.html, got)) {
          useTab = true;
          page = await readInTab(url, "order");
          got = await parse("order", page.html, page.url, orderId);
        }
        return { page, got };
      };
      try {
        const listAddress = listUrl((/* @__PURE__ */ new Date()).getFullYear());
        let list = await readAmazon(listAddress, "list");
        let parsed = await parse("list", list.html, list.url);
        if (!useTab && needsTab(list.html, parsed)) {
          useTab = true;
          list = await readInTab(listAddress, "list");
          parsed = await parse("list", list.html, list.url);
        }
        const parts = [`== Your Orders${useTab ? " (tab)" : ""} ==
${await outlineOf(list)}`];
        const ids = "ok" in parsed ? parsed.ok.orders.filter((o) => !o.orderId.startsWith("D")).slice(0, 5).map((o) => o.orderId) : [];
        let first = null;
        for (const id of ids) {
          await pause();
          const { page, got } = await readOrder(`${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(id)}`, id);
          first ??= await outlineOf(page);
          if ("ok" in got && !got.ok.charges.length) {
            parts.push(`== Order page without a charge list${useTab ? " (tab)" : ""} ==
${await outlineOf(page)}`);
            await pause();
            const invoice = await readAmazon(`${AMAZON}/gp/css/summary/print.html?orderID=${encodeURIComponent(id)}`, "invoice");
            parts.push(`== Its invoice ==
${await outlineOf(invoice)}`);
            first = null;
            break;
          }
        }
        if (first) parts.push(`== Order page${useTab ? " (tab)" : ""} ==
${first}`);
        await pause();
        let tx = await readAmazon(TRANSACTIONS.url, "transactions");
        const txGot = await parse("transactions", tx.html, tx.url);
        if (!useTab && (!("ok" in txGot) || !txGot.ok.rows.length)) {
          useTab = true;
          tx = await readInTab(TRANSACTIONS.url, "transactions");
        }
        parts.push(`== Transactions${useTab ? " (tab)" : ""} ==
${await outlineOf(tx)}`);
        return { outline: parts.join("\n\n") };
      } finally {
        await closeTab();
        await closeOffscreen();
      }
    }
  }
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object" || "target" in msg) return false;
  handle(msg).then(
    (r) => reply(r),
    (e) => reply({ error: e instanceof LedgerError ? e.code : "failed", message: e instanceof Error ? e.message : "Something went wrong" })
  );
  return true;
});
export {
  VERSION,
  syncNow
};
