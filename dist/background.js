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
async function forget() {
  await chrome.storage.local.remove(KEYS.filter((k) => k !== "ledger" && k !== "accent" && k !== "autoSync"));
}

// src/sync.ts
var localFrom = (e) => e instanceof LedgerError && e.kind === "signed_out" ? "reconnect" : "ledger_unreachable";
async function runSync(deps, opts = {}) {
  const maxOrders = opts.maxOrders ?? 150;
  const maxListPages = opts.maxListPages ?? 40;
  const batchSize = opts.batchSize ?? 20;
  const out = { status: null, failedSection: null, localProblem: null, ordersRead: 0, split: 0, waiting: 0, waitingSince: null, syncFrom: null, chargesSplitThisMonth: null };
  let st;
  try {
    st = await deps.status();
  } catch (e) {
    out.localProblem = localFrom(e);
    return out;
  }
  out.chargesSplitThisMonth = st.chargesSplitThisMonth;
  const from = [st.syncFrom, opts.waitingSince].filter((d) => !!d).sort()[0];
  out.syncFrom = from;
  const finish = async (status2, section) => {
    out.status = status2;
    out.failedSection = section;
    try {
      await deps.reportRun(status2, section, out.waiting);
    } catch (e) {
      out.localProblem = localFrom(e);
    }
    return out;
  };
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  let pages = 0;
  const thisYear = Number(deps.today().slice(0, 4));
  years: for (let year = thisYear; year >= Number(from.slice(0, 4)); year--) {
    let url = deps.listUrl(year);
    while (url) {
      if (pages++ >= maxListPages) break years;
      if (pages > 1) await deps.pause();
      const page = await deps.loadList(url);
      if ("blocked" in page) return finish(page.blocked === "signin" ? "amazon_signed_out" : "captcha", null);
      if ("failed" in page) return finish("parse_failed", page.failed);
      if ("skip" in page) break;
      let older = false;
      for (const o of page.ok.orders) {
        if (o.orderDate && o.orderDate < from) {
          older = true;
          continue;
        }
        if (!seen.has(o.orderId) && !o.orderId.startsWith("D")) {
          seen.add(o.orderId);
          ids.push(o.orderId);
        }
      }
      if (older) break years;
      url = page.ok.nextUrl;
    }
  }
  const orders = [];
  const failures = /* @__PURE__ */ new Map();
  let tried = 0;
  for (const id of ids.reverse().slice(0, maxOrders)) {
    await deps.pause();
    tried++;
    const got = await deps.loadOrder(id);
    if ("blocked" in got) return finish(got.blocked === "signin" ? "amazon_signed_out" : "captcha", null);
    if ("failed" in got) {
      failures.set(got.failed, (failures.get(got.failed) ?? 0) + 1);
      continue;
    }
    if ("skip" in got) continue;
    if (got.ok.orderDate >= from) orders.push(got.ok);
  }
  out.ordersRead = orders.length;
  const failed = [...failures.values()].reduce((s, n) => s + n, 0);
  if (failed >= 3 && failed * 2 >= tried) {
    const worst = [...failures.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return finish("parse_failed", worst);
  }
  for (let i = 0; i < orders.length; i += batchSize) {
    try {
      const r = await deps.sendOrders(orders.slice(i, i + batchSize));
      out.split += r.split;
      out.waiting += r.waiting;
      if (r.waitingSince && (!out.waitingSince || r.waitingSince < out.waitingSince)) out.waitingSince = r.waitingSince;
    } catch (e) {
      if (e instanceof LedgerError && (e.kind === "server" || e.kind === "refused")) return finish("ledger_error", null);
      out.localProblem = localFrom(e);
      return out;
    }
  }
  return finish("ok", null);
}

// src/background.ts
var VERSION = "0.1.0";
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
chrome.runtime.onInstalled.addListener(() => void schedule());
chrome.runtime.onStartup.addListener(async () => {
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
async function fetchAmazon(url) {
  const res = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" });
  if (res.status === 503) return { blocked: "captcha" };
  return { html: await res.text(), url: res.url || url };
}
var pause = () => new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
async function loadList(url) {
  const page = await fetchAmazon(url);
  if ("blocked" in page) return page;
  return await parse("list", page.html, page.url);
}
async function loadOrder(orderId) {
  const page = await fetchAmazon(`${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`);
  if ("blocked" in page) return page;
  const got = await parse("order", page.html, page.url, orderId);
  if (!("ok" in got) || got.ok.charges.length) return got;
  await pause();
  const invoice = await fetchAmazon(`${AMAZON}/gp/css/summary/print.html?orderID=${encodeURIComponent(orderId)}`);
  if ("blocked" in invoice) return invoice;
  const charges = await parse("charges", invoice.html, invoice.url);
  return "ok" in charges ? { ok: { ...got.ok, charges: charges.ok } } : got;
}
var listUrl = (year) => `${AMAZON}/your-orders/orders?timeFilter=year-${year}`;
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
    if (s.running && s.lastRunAt && Date.now() - Date.parse(s.lastRunAt) < STALE_RUN_MS) return;
    await save({ running: true });
    try {
      const ledger = s.ledger;
      const token = await freshToken(ledger, s.token, s.tokenExpiresAt);
      const outcome = await runSync(
        {
          listUrl,
          loadList,
          loadOrder,
          status: () => status(ledger, token),
          sendOrders: (orders) => sendOrders(ledger, token, orders, crypto.randomUUID()),
          reportRun: async (status2, section, waiting) => {
            await reportRun(ledger, token, { status: status2, failedSection: section, extensionVersion: VERSION, ordersWaiting: waiting }, crypto.randomUUID());
          },
          pause,
          today: () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)
        },
        { waitingSince: s.waitingSince ?? null }
      );
      const st = outcome.status === "ok" ? await status(ledger, token).catch(() => null) : null;
      await save({
        lastRunAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastStatus: outcome.status ?? s.lastStatus,
        failedSection: outcome.failedSection,
        localProblem: outcome.localProblem,
        ...outcome.status === "ok" ? { waitingSince: outcome.waitingSince, ordersWaiting: outcome.waiting, syncedThrough: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), syncFrom: outcome.syncFrom } : {},
        ...st ? { chargesSplitThisMonth: st.chargesSplitThisMonth } : outcome.chargesSplitThisMonth !== null ? { chargesSplitThisMonth: outcome.chargesSplitThisMonth } : {}
      });
    } catch {
      await save({ lastRunAt: (/* @__PURE__ */ new Date()).toISOString(), localProblem: "ledger_unreachable" });
    } finally {
      await save({ running: false });
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
      const s = await load();
      const list = await fetchAmazon(listUrl(Number((/* @__PURE__ */ new Date()).toISOString().slice(0, 4))));
      if ("blocked" in list) return { error: list.blocked };
      if (s.failedSection === "orders_list") return parse("outline", list.html, list.url);
      const page = await parse("list", list.html, list.url);
      const id = "ok" in page ? page.ok.orders[0]?.orderId : void 0;
      if (!id) return parse("outline", list.html, list.url);
      const order = await fetchAmazon(`${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(id)}`);
      if ("blocked" in order) return { error: order.blocked };
      const result = await parse("outline", order.html, order.url);
      await closeOffscreen();
      return result;
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
