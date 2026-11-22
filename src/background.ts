/**
 * The service worker: runs a sync every 6 hours and when Chrome starts, and answers the popup.
 * Amazon pages are fetched with the browser's own Amazon sign-in (the extension never reads
 * cookies) and parsed in the offscreen document, which only returns the fields Ledger needs.
 */

import * as api from "./ledger/api";
import { closeTab, readInTab, TabClosedError, type PageKind } from "./amazon/tab";
import { cachedCategory, clearFinished, forget, isFinished, load, markFinished, save, saveCategory } from "./storage";
import { runSync, type Loaded } from "./sync";
import type { ListPage, Section, SyncOrder, SyncStatus } from "./types";

declare const __VERSION__: string;
export const VERSION = __VERSION__;

const AMAZON = "https://www.amazon.com";
const ALARM = "sync";
const EVERY_MINUTES = 6 * 60;
const STALE_RUN_MS = 30 * 60_000;
const REFRESH_DAYS = 30;

// ---------- Schedule ----------

async function schedule(): Promise<void> {
  const s = await load();
  if (!s.token || s.autoSync === false) {
    await chrome.alarms.clear(ALARM);
    return;
  }
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: EVERY_MINUTES });
}

// A sync can't still be running when the extension (re)starts.
chrome.runtime.onInstalled.addListener(async (details) => {
  await save({ running: false });
  await schedule();
  // An update may fix the last problem: clear it and sync a minute later.
  if (details.reason === "update") {
    await chrome.storage.local.remove(["lastStatus", "failedSection", "localProblem"]);
    if ((await load()).token) await chrome.alarms.create("catch-up", { delayInMinutes: 1 });
  }
});
chrome.runtime.onStartup.addListener(async () => {
  await save({ running: false });
  await schedule();
  const s = await load();
  // Chrome was closed past a sync: catch up a minute after it opens.
  if (s.token && s.autoSync !== false && (!s.lastRunAt || Date.now() - Date.parse(s.lastRunAt) > EVERY_MINUTES * 60_000)) {
    await chrome.alarms.create("catch-up", { delayInMinutes: 1 });
  }
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM || alarm.name === "catch-up") void syncNow();
});

// ---------- Amazon pages ----------

async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.DOM_PARSER], justification: "Read Amazon order pages" });
}

async function closeOffscreen(): Promise<void> {
  await chrome.offscreen.closeDocument().catch(() => undefined);
}

type Parsed<T> = Loaded<T> | { outline: string };

async function parse<T>(kind: "list" | "order" | "charges" | "category" | "outline", html: string, url: string, orderId?: string): Promise<Parsed<T>> {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", kind, html, url, orderId });
}

/** Order pages: read in the background sync tab (Amazon only unlocks them in a real page). */
/**
 * Order pages are read with a plain request first. Only when Amazon answers with locked order
 * boxes or "unable to load your order details" does the sync switch to a background tab, for
 * the rest of that sync.
 */
let useTab = false;

async function readAmazon(url: string, kind: PageKind): Promise<{ html: string; url: string }> {
  if (useTab) return readInTab(url, kind);
  const page = await fetchAmazon(url);
  if ("blocked" in page) {
    // A robot check on a plain request: a real page in a tab may still get through.
    useTab = true;
    return readInTab(url, kind);
  }
  return page;
}

/** Amazon's answers that only a real page in a tab gets past. */
function needsTab(html: string, got: Loaded<unknown>): boolean {
  if (!("failed" in got)) return false;
  return got.failed === "order_unavailable" || (got.failed === "orders_list" && html.includes("csd-encrypted-sensitive"));
}

/** Product pages are public and complete as served, so a plain request is enough. */
async function fetchAmazon(url: string): Promise<{ html: string; url: string; status: number } | { blocked: "captcha" | "signin" }> {
  const res = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" });
  // Amazon answers a robot check with 503.
  if (res.status === 503) return { blocked: "captcha" };
  return { html: await res.text(), url: res.url || url, status: res.status };
}

const pause = () => new Promise<void>((r) => setTimeout(r, 1500 + Math.random() * 1500));

async function loadList(url: string): Promise<Loaded<ListPage>> {
  const page = await readAmazon(url, "list");
  const got = (await parse<ListPage>("list", page.html, page.url)) as Loaded<ListPage>;
  if (useTab || !needsTab(page.html, got)) return got;
  useTab = true;
  const again = await readInTab(url, "list");
  return (await parse<ListPage>("list", again.html, again.url)) as Loaded<ListPage>;
}

async function loadOrder(orderId: string): Promise<Loaded<SyncOrder>> {
  const url = `${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`;
  const page = await readAmazon(url, "order");
  let got = (await parse<SyncOrder>("order", page.html, page.url, orderId)) as Loaded<SyncOrder>;
  if (!useTab && needsTab(page.html, got)) {
    useTab = true;
    const again = await readInTab(url, "order");
    got = (await parse<SyncOrder>("order", again.html, again.url, orderId)) as Loaded<SyncOrder>;
  }
  if (!("ok" in got) || got.ok.charges.length) return got;
  // No charge list on the order page: the invoice usually has it.
  await pause();
  const invoice = await readAmazon(`${AMAZON}/gp/css/summary/print.html?orderID=${encodeURIComponent(orderId)}`, "invoice");
  const charges = (await parse<SyncOrder["charges"]>("charges", invoice.html, invoice.url)) as Loaded<SyncOrder["charges"]>;
  return "ok" in charges ? { ok: { ...got.ok, charges: charges.ok } } : got;
}

const listUrl = (year: number) => `${AMAZON}/your-orders/orders?timeFilter=year-${year}`;

/** A product's category: from the cache, else its product page (one GET), then cached. */
async function category(productId: string): Promise<{ ok: string | null } | { blocked: "captcha" | "signin" }> {
  if (!/^[A-Z0-9]{10}$/.test(productId)) return { ok: null };
  const cached = await cachedCategory(productId);
  if (cached.hit) return { ok: cached.category };
  await pause();
  const page = await fetchAmazon(`${AMAZON}/dp/${productId}`);
  if ("blocked" in page) return page;
  let found: string | null = null;
  if (page.status === 200) {
    const got = (await parse<string | null>("category", page.html, page.url)) as Loaded<string | null>;
    if ("blocked" in got) return got;
    found = "ok" in got ? got.ok : null;
  }
  await saveCategory(productId, found);
  return { ok: found };
}

// ---------- Sync ----------

let running: Promise<void> | null = null;

async function freshToken(ledger: string, token: string, expiresAt?: string): Promise<string> {
  if (expiresAt && Date.parse(expiresAt) - Date.now() > REFRESH_DAYS * 86_400_000) return token;
  try {
    const r = await api.refresh(ledger, token);
    await save({ token: r.token, tokenExpiresAt: r.expiresAt });
    return r.token;
  } catch {
    return token;
  }
}

export function syncNow(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const s = await load();
    if (!s.ledger || !s.token) return;
    if (s.running && s.runStartedAt && Date.now() - Date.parse(s.runStartedAt) < STALE_RUN_MS) return;
    await save({ running: true, runStartedAt: new Date().toISOString() });
    useTab = false;
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
          status: () => api.status(ledger, token),
          unsplit: () => api.unsplit(ledger, token),
          usedTab: () => useTab,
          sendOrders: (orders) => api.sendOrders(ledger, token, orders, crypto.randomUUID()),
          reportRun: async (status: SyncStatus, section: Section | null, waiting: number) => {
            await api.reportRun(ledger, token, { status, failedSection: section, extensionVersion: VERSION, ordersWaiting: waiting }, crypto.randomUUID());
          },
          pause,
          today: () => new Date().toISOString().slice(0, 10),
        },
        { waitingSince: s.waitingSince ?? null, previousLedgerFrom: s.ledgerFrom ?? null },
      );
      const st = outcome.status === "ok" ? await api.status(ledger, token).catch(() => null) : null;
      await save({
        lastRunAt: new Date().toISOString(),
        lastStatus: outcome.status ?? s.lastStatus,
        failedSection: outcome.failedSection,
        localProblem: outcome.localProblem,
        ...(outcome.status ? { lastCounts: outcome.counts } : {}),
        ...(outcome.ledgerFrom ? { ledgerFrom: outcome.ledgerFrom } : {}),
        ...(outcome.status === "ok"
          ? { waitingSince: outcome.waitingSince, ordersWaiting: outcome.counts.waiting, syncedThrough: new Date().toLocaleDateString("en-CA"), syncFrom: outcome.syncFrom }
          : {}),
        ...(st ? { chargesSplitThisMonth: st.chargesSplitThisMonth } : outcome.chargesSplitThisMonth !== null ? { chargesSplitThisMonth: outcome.chargesSplitThisMonth } : {}),
      });
    } catch (e) {
      const problem = e instanceof TabClosedError ? "tab_closed" : e instanceof api.LedgerError ? "ledger_unreachable" : "amazon_error";
      await save({ lastRunAt: new Date().toISOString(), localProblem: problem });
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

// ---------- Popup ----------

type Request =
  | { type: "connect"; ledger: string; username: string; password: string; code: string }
  | { type: "disconnect" }
  | { type: "sync" }
  | { type: "auto"; on: boolean }
  | { type: "outline" };

async function handle(msg: Request): Promise<unknown> {
  switch (msg.type) {
    case "connect": {
      const ledger = api.normalizeAddress(msg.ledger);
      const r = await api.connect(ledger, msg.username.trim(), msg.password, msg.code, "Amazon extension");
      await save({ ledger, token: r.token, tokenExpiresAt: r.expiresAt, localProblem: null, lastStatus: undefined, failedSection: null });
      await schedule();
      void syncNow();
      return { ok: true };
    }
    case "disconnect": {
      const s = await load();
      if (s.ledger && s.token) await api.logout(s.ledger, s.token).catch(() => undefined);
      await forget();
      await chrome.alarms.clear(ALARM);
      if (s.ledger) await chrome.permissions.remove({ origins: [api.originPattern(s.ledger)] }).catch(() => undefined);
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
      // What the sync sees, every word masked: Your Orders, then the first order whose page
      // has no charge list (with its invoice), or else the first order.
      useTab = false;
      const outlineOf = async (page: { html: string; url: string }) => ((await parse("outline", page.html, page.url)) as { outline?: string }).outline ?? "";
      const readOrder = async (url: string, orderId: string) => {
        let page = await readAmazon(url, "order");
        let got = (await parse<SyncOrder>("order", page.html, page.url, orderId)) as Loaded<SyncOrder>;
        if (!useTab && needsTab(page.html, got)) {
          useTab = true;
          page = await readInTab(url, "order");
          got = (await parse<SyncOrder>("order", page.html, page.url, orderId)) as Loaded<SyncOrder>;
        }
        return { page, got };
      };
      try {
        const listAddress = listUrl(new Date().getFullYear());
        let list = await readAmazon(listAddress, "list");
        let parsed = (await parse<ListPage>("list", list.html, list.url)) as Loaded<ListPage>;
        if (!useTab && needsTab(list.html, parsed)) {
          useTab = true;
          list = await readInTab(listAddress, "list");
          parsed = (await parse<ListPage>("list", list.html, list.url)) as Loaded<ListPage>;
        }
        const parts = [`== Your Orders${useTab ? " (tab)" : ""} ==\n${await outlineOf(list)}`];
        const ids = "ok" in parsed ? parsed.ok.orders.filter((o) => !o.orderId.startsWith("D")).slice(0, 5).map((o) => o.orderId) : [];
        let first: string | null = null;
        for (const id of ids) {
          await pause();
          const { page, got } = await readOrder(`${AMAZON}/gp/your-account/order-details?orderID=${encodeURIComponent(id)}`, id);
          first ??= await outlineOf(page);
          if ("ok" in got && !got.ok.charges.length) {
            parts.push(`== Order page without a charge list${useTab ? " (tab)" : ""} ==\n${await outlineOf(page)}`);
            await pause();
            const invoice = await readAmazon(`${AMAZON}/gp/css/summary/print.html?orderID=${encodeURIComponent(id)}`, "invoice");
            parts.push(`== Its invoice ==\n${await outlineOf(invoice)}`);
            first = null;
            break;
          }
        }
        if (first) parts.push(`== Order page${useTab ? " (tab)" : ""} ==\n${first}`);
        return { outline: parts.join("\n\n") };
      } finally {
        await closeTab();
        await closeOffscreen();
      }
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only the extension's own popup; offscreen messages are for the offscreen page.
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object" || "target" in msg) return false;
  handle(msg as Request).then(
    (r) => reply(r),
    (e) => reply({ error: e instanceof api.LedgerError ? e.code : "failed", message: e instanceof Error ? e.message : "Something went wrong" }),
  );
  return true;
});
