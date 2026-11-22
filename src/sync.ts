/**
 * One sync: ask Ledger where to start, walk Your Orders back past that day, read each order's
 * page (skipping orders already finished), look up each new product's category, send the
 * orders to Ledger in batches, then tell Ledger how it went. The page loading and Ledger calls
 * are passed in, so this is tested without a browser.
 */

import { LedgerError, type OrdersResult, type Status } from "./ledger/api";
import type { Blocked, ListPage, LocalProblem, RunCounts, Section, SyncOrder, SyncStatus } from "./types";

export type Loaded<T> = { ok: T } | { blocked: Exclude<Blocked, null> } | { failed: Section } | { skip: "cancelled" | true };

export interface SyncDeps {
  listUrl(year: number): string;
  loadList(url: string): Promise<Loaded<ListPage>>;
  loadOrder(orderId: string): Promise<Loaded<SyncOrder>>;
  /** A product's category (cached, or read from its page). Null when the page has none. */
  category(productId: string): Promise<{ ok: string | null } | { blocked: Exclude<Blocked, null> }>;
  /** Orders finished on an earlier sync (every charge found). */
  isFinished(orderId: string): Promise<boolean>;
  markFinished(orderIds: string[]): Promise<void>;
  clearFinished(): Promise<void>;
  status(): Promise<Status>;
  sendOrders(orders: SyncOrder[]): Promise<OrdersResult>;
  reportRun(status: SyncStatus, failedSection: Section | null, ordersWaiting: number): Promise<void>;
  /** Waits between Amazon pages so the sync stays gentle. */
  pause(): Promise<void>;
  today(): string;
}

export interface SyncOptions {
  /** The oldest order still waiting from the last sync. */
  waitingSince?: string | null;
  /** Ledger's start day on the last sync. */
  previousLedgerFrom?: string | null;
  maxOrders?: number;
  maxListPages?: number;
  batchSize?: number;
}

export interface SyncOutcome {
  status: SyncStatus | null;
  failedSection: Section | null;
  /** Set when Ledger itself couldn't be used, so nothing could be reported. */
  localProblem: LocalProblem | null;
  counts: RunCounts;
  waitingSince: string | null;
  syncFrom: string | null;
  /** Ledger's own start day this time. */
  ledgerFrom: string | null;
  chargesSplitThisMonth: number | null;
}

/**
 * Amazon charges when an order ships, which can be weeks after it was placed, so orders placed
 * this long before the start day are read too. Finished ones are skipped, so this costs little.
 */
export const ORDER_LOOKBACK_DAYS = 30;

const localFrom = (e: unknown): LocalProblem => (e instanceof LedgerError && e.kind === "signed_out" ? "reconnect" : "ledger_unreachable");
const minusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

export const emptyCounts = (): RunCounts => ({
  listed: 0, finished: 0, read: 0, sent: 0, digital: 0, cancelled: 0, unreadable: 0,
  split: 0, waiting: 0, noMatch: 0, noChargeList: 0, items: 0, categorized: 0,
});

export async function runSync(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncOutcome> {
  const maxOrders = opts.maxOrders ?? 150;
  const maxListPages = opts.maxListPages ?? 40;
  const batchSize = opts.batchSize ?? 20;
  const counts = emptyCounts();
  const out: SyncOutcome = { status: null, failedSection: null, localProblem: null, counts, waitingSince: null, syncFrom: null, ledgerFrom: null, chargesSplitThisMonth: null };

  let st: Status;
  try {
    st = await deps.status();
  } catch (e) {
    out.localProblem = localFrom(e);
    return out;
  }
  out.chargesSplitThisMonth = st.chargesSplitThisMonth;
  out.ledgerFrom = st.syncFrom;
  // Ledger's start moved back: splits were removed, so finished orders need reading again.
  if (opts.previousLedgerFrom && st.syncFrom < opts.previousLedgerFrom) await deps.clearFinished();
  const from = [st.syncFrom, opts.waitingSince].filter((d): d is string => !!d).sort()[0]!;
  out.syncFrom = from;
  const listFrom = minusDays(from, ORDER_LOOKBACK_DAYS);

  const finish = async (status: SyncStatus, section: Section | null): Promise<SyncOutcome> => {
    out.status = status;
    out.failedSection = section;
    try {
      await deps.reportRun(status, section, counts.waiting);
    } catch (e) {
      out.localProblem = localFrom(e);
    }
    return out;
  };
  const stopFor = (b: Exclude<Blocked, null>) => finish(b === "signin" ? "amazon_signed_out" : "captcha", null);

  // 1. Your Orders, newest first, back to listFrom.
  const ids: string[] = [];
  const seen = new Set<string>();
  let pages = 0;
  const thisYear = Number(deps.today().slice(0, 4));
  years: for (let year = thisYear; year >= Number(listFrom.slice(0, 4)); year--) {
    let url: string | null = deps.listUrl(year);
    while (url) {
      if (pages++ >= maxListPages) break years;
      if (pages > 1) await deps.pause();
      const page = await deps.loadList(url);
      if ("blocked" in page) return stopFor(page.blocked);
      if ("failed" in page) return finish("parse_failed", page.failed);
      if ("skip" in page) break;
      let older = false;
      let fresh = 0;
      for (const o of page.ok.orders) {
        if (o.orderDate && o.orderDate < listFrom) {
          older = true;
          continue;
        }
        if (seen.has(o.orderId)) continue;
        seen.add(o.orderId);
        fresh++;
        counts.listed++;
        // Digital orders (D01-…) have no shipped items and are charged differently.
        if (o.orderId.startsWith("D")) counts.digital++;
        else ids.push(o.orderId);
      }
      // Past the start, or the same page again (a pager Amazon ignored): this year is done.
      if (older) break years;
      if (!fresh) break;
      url = page.ok.nextUrl;
    }
  }

  // 2. Each unfinished order's page, oldest first, so a long first sync moves forward run by run.
  const todo: string[] = [];
  for (const id of ids.reverse()) {
    if (await deps.isFinished(id)) counts.finished++;
    else todo.push(id);
  }
  const orders: SyncOrder[] = [];
  const failures = new Map<Section, number>();
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
  // A page here and there can be odd; most failing means Amazon changed its pages.
  if (counts.unreadable >= 3 && counts.unreadable * 2 >= tried) {
    const worst = [...failures.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    return finish("parse_failed", worst);
  }

  // 3. Amazon's category for each product, one page per product not seen before.
  const asked = new Map<string, string | null>();
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

  // 4. Ledger, in batches.
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
      const done = (r.done ?? []).map((n) => batch[n]?.orderId).filter((id): id is string => !!id);
      if (done.length) await deps.markFinished(done);
    } catch (e) {
      if (e instanceof LedgerError && (e.kind === "server" || e.kind === "refused")) return finish("ledger_error", null);
      out.localProblem = localFrom(e);
      return out;
    }
  }
  return finish("ok", null);
}
