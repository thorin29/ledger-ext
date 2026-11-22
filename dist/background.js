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
var localFrom = (e) => e instanceof LedgerError && e.kind === "signed_out" ? "reconnect" : "ledger_unreachable";
var minusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
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
  categorized: 0
});
async function runSync(deps, opts = {}) {
  const maxOrders = opts.maxOrders ?? 150;
  const maxListPages = opts.maxListPages ?? 40;
  const batchSize = opts.batchSize ?? 20;
  const counts = emptyCounts();
  const out = { status: null, failedSection: null, localProblem: null, counts, waitingSince: null, syncFrom: null, ledgerFrom: null, chargesSplitThisMonth: null };
  let st;
  try {
    st = await deps.status();
  } catch (e) {
    out.localProblem = localFrom(e);
    return out;
  }
  out.chargesSplitThisMonth = st.chargesSplitThisMonth;
  out.ledgerFrom = st.syncFrom;
  if (opts.previousLedgerFrom && st.syncFrom < opts.previousLedgerFrom) await deps.clearFinished();
  const from = [st.syncFrom, opts.waitingSince].filter((d) => !!d).sort()[0];
  out.syncFrom = from;
  const listFrom = minusDays(from, ORDER_LOOKBACK_DAYS);
  const finish = async (status2, section) => {
    out.status = status2;
    out.failedSection = section;
    try {
      await deps.reportRun(status2, section, counts.waiting);
    } catch (e) {
      out.localProblem = localFrom(e);
    }
    return out;
  };
  const stopFor = (b) => finish(b === "signin" ? "amazon_signed_out" : "captcha", null);
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  let pages = 0;
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
        if (o.orderId.startsWith("D")) counts.digital++;
        else ids.push(o.orderId);
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
  const orders = [];
  const failures = /* @__PURE__ */ new Map();
  let tried = 0;
  for (const id of todo.slice(0, maxOrders)) {
    await deps.pause();
    tried++;
    const got = await deps.loadOrder(id);
    if ("blocked" in got) return stopFor(got.blocked);
    if ("failed" in got) {
      counts.unreadable++;
      failures.set(got.failed, (failures.get(got.failed) ?? 0) + 1);
      continue;
    }
    if ("skip" in got) {
      counts.cancelled++;
      continue;
    }
    orders.push(got.ok);
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
      counts.noChargeList += r.noChargeList ?? 0;
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
var VERSION = "0.3.1";
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
    if ((await load()).token) await chrome.alarms.create("catch-up", { delayInMinutes: 1 });
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
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM || alarm.name === "catch-up") void syncNow();
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
async function readAmazon(url, kind) {
  return readInTab(url, kind);
}
async function fetchAmazon(url) {
  const res = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" });
  if (res.status === 503) return { blocked: "captcha" };
  return { html: await res.text(), url: res.url || url, status: res.status };
}
var pause = () => new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
async function loadList(url) {
  const page = await readAmazon(url, "list");
  return await parse("list", page.html, page.url);
}
async function loadOrder(orderId) {
  const page = await readAmazon(`${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`, "order");
  const got = await parse("order", page.html, page.url, orderId);
  if (!("ok" in got) || got.ok.charges.length) return got;
  await pause();
  const invoice = await readAmazon(`${AMAZON}/gp/css/summary/print.html?orderID=${encodeURIComponent(orderId)}`, "invoice");
  const charges = await parse("charges", invoice.html, invoice.url);
  return "ok" in charges ? { ok: { ...got.ok, charges: charges.ok } } : got;
}
var listUrl = (year) => `${AMAZON}/your-orders/orders?timeFilter=year-${year}`;
async function category(productId) {
  if (!/^[A-Z0-9]{10}$/.test(productId)) return { ok: null };
  const cached = await cachedCategory(productId);
  if (cached.hit) return { ok: cached.category };
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
    try {
      const ledger = s.ledger;
      const token = await freshToken(ledger, s.token, s.tokenExpiresAt);
      const outcome = await runSync(
        {
          listUrl,
          loadList,
          loadOrder,
          category,
          isFinished,
          markFinished: (ids) => markFinished(ids),
          clearFinished,
          status: () => status(ledger, token),
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
    case "auto":
      await save({ autoSync: msg.on });
      await schedule();
      return { ok: true };
    case "outline": {
      const list = await readAmazon(listUrl((/* @__PURE__ */ new Date()).getFullYear()), "list");
      const parts = [];
      const listOutline = await parse("outline", list.html, list.url);
      parts.push(`== Your Orders ==
${listOutline.outline ?? ""}`);
      const page = await parse("list", list.html, list.url);
      const id = "ok" in page ? page.ok.orders.find((o) => !o.orderId.startsWith("D"))?.orderId : void 0;
      if (id) {
        await pause();
        const order = await readAmazon(`${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(id)}`, "order");
        const o = await parse("outline", order.html, order.url);
        parts.push(`== Order page ==
${o.outline ?? ""}`);
      }
      await closeTab();
      await closeOffscreen();
      return { outline: parts.join("\n\n") };
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
