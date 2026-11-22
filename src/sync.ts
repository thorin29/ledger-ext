/**
 * One sync. Ledger says which Amazon charges it hasn't split yet; the extension walks Your
 * Orders back far enough to cover them, reads only orders placed in the 30 days before one of
 * those charges, and stops as soon as every charge has turned up in an order's charge list.
 * Then it looks up each new product's category, sends the orders to Ledger, and reports how it
 * went. With nothing left to split, it doesn't open Amazon at all.
 *
 * The page loading and Ledger calls are passed in, so this is tested without a browser.
 */

import { LedgerError, type OrdersResult, type Status } from "./ledger/api";
import type { Blocked, ListPage, LocalProblem, RunCounts, Section, SyncCharge, SyncOrder, SyncStatus, UnsplitCharge } from "./types";

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
  /** Amazon charges Ledger hasn't split; null when Ledger is too old to say. */
  unsplit(): Promise<UnsplitCharge[] | null>;
  sendOrders(orders: SyncOrder[]): Promise<OrdersResult>;
  reportRun(status: SyncStatus, failedSection: Section | null, ordersWaiting: number): Promise<void>;
  /** Whether Amazon's pages had to be read in a tab this run. */
  usedTab(): boolean;
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

/** Amazon charges when an order ships, which can be weeks after it was placed. */
export const ORDER_LOOKBACK_DAYS = 30;

const DAY = 86_400_000;
const localFrom = (e: unknown): LocalProblem => (e instanceof LedgerError && e.kind === "signed_out" ? "reconnect" : "ledger_unreachable");
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const gap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;

/** The same test Ledger uses: amount within a cent, within five days, and the same card when both show it. */
export const sameCharge = (a: SyncCharge, b: UnsplitCharge) =>
  Math.abs(a.cents - b.cents) <= 1 && gap(a.date, b.date) <= 5 && !(a.last4 && b.last4 && a.last4 !== b.last4);

export const emptyCounts = (): RunCounts => ({
  listed: 0, finished: 0, read: 0, sent: 0, digital: 0, cancelled: 0, unreadable: 0,
  split: 0, waiting: 0, noMatch: 0, noChargeList: 0, items: 0, categorized: 0,
  unsplit: 0, found: 0, usedTab: 0,
});

export async function runSync(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncOutcome> {
  const maxOrders = opts.maxOrders ?? 150;
  const maxListPages = opts.maxListPages ?? 40;
  const batchSize = opts.batchSize ?? 20;
  const counts = emptyCounts();
  const out: SyncOutcome = { status: null, failedSection: null, localProblem: null, counts, waitingSince: null, syncFrom: null, ledgerFrom: null, chargesSplitThisMonth: null };

  let st: Status;
  let todoCharges: UnsplitCharge[] | null;
  try {
    st = await deps.status();
    todoCharges = await deps.unsplit();
  } catch (e) {
    out.localProblem = localFrom(e);
    return out;
  }
  out.chargesSplitThisMonth = st.chargesSplitThisMonth;
  out.ledgerFrom = st.syncFrom;
  // Ledger's start moved back: splits were removed, so finished orders need reading again.
  if (opts.previousLedgerFrom && st.syncFrom < opts.previousLedgerFrom) await deps.clearFinished();

  const finish = async (status: SyncStatus, section: Section | null): Promise<SyncOutcome> => {
    out.status = status;
    out.failedSection = section;
    counts.usedTab = deps.usedTab() ? 1 : 0;
    try {
      await deps.reportRun(status, section, counts.waiting);
    } catch (e) {
      out.localProblem = localFrom(e);
    }
    return out;
  };
  const stopFor = (b: Exclude<Blocked, null>) => finish(b === "signin" ? "amazon_signed_out" : "captcha", null);

  // What to look for: Ledger's unsplit charges (newer Ledger), or everything since its start day.
  counts.unsplit = todoCharges ? todoCharges.length : -1;
  if (todoCharges && !todoCharges.length) return finish("ok", null);
  const from = todoCharges
    ? todoCharges.map((c) => c.date).sort()[0]!
    : [st.syncFrom, opts.waitingSince].filter((d): d is string => !!d).sort()[0]!;
  out.syncFrom = from;
  const listFrom = shift(from, -ORDER_LOOKBACK_DAYS);
  /** Could this order have one of the charges still to find? */
  const wanted = (orderDate: string | null) =>
    !todoCharges || !orderDate || todoCharges.some((c) => orderDate <= shift(c.date, 1) && orderDate >= shift(c.date, -ORDER_LOOKBACK_DAYS));

  // Reading one order's page; its result counts toward what was found.
  const remaining = todoCharges ? [...todoCharges] : null;
  const orders: SyncOrder[] = [];
  const failures = new Map<Section, number>();
  let tried = 0;
  const readOrder = async (id: string): Promise<SyncOrder | Exclude<Blocked, null> | null> => {
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
  const keep = (o: SyncOrder) => {
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

  // 1. Your Orders, newest first, back to listFrom. An order whose date the list doesn't show
  // is opened right away to learn it, and the walk stops at the first one older than needed.
  const ids: string[] = [];
  const seen = new Set<string>();
  let pages = 0;
  /** Undated orders that couldn't be opened in a row: without dates the walk can't know where to stop. */
  let blind = 0;
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
      let fresh = 0;
      const dated = page.ok.orders.filter((o) => o.orderDate);
      for (const o of page.ok.orders) {
        if (o.orderDate && o.orderDate < listFrom) continue;
        if (seen.has(o.orderId)) continue;
        seen.add(o.orderId);
        fresh++;
        counts.listed++;
        // Digital orders (D01-…) have no shipped items and are charged differently.
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
        // Past the start: everything below it on the list is older still.
        if (read.orderDate < listFrom) break years;
        if (wanted(read.orderDate)) keep(read);
        if (allFound()) break years;
      }
      // Every dated order on the page is before the start: done. One odd date doesn't stop it.
      if (dated.length && dated.every((o) => o.orderDate! < listFrom)) break years;
      // The same page again (a pager Amazon ignored): this year is done.
      if (!fresh) break;
      url = page.ok.nextUrl;
    }
  }

  // 2. The rest of the orders the list dated, oldest first, until every missing charge turns up.
  const todo: string[] = [];
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
  counts.read = orders.length;
  // A page here and there can be odd; most failing, or none readable, means Amazon changed.
  if ((counts.unreadable >= 3 && counts.unreadable * 2 >= tried) || (counts.unreadable > 0 && counts.read === 0)) {
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
