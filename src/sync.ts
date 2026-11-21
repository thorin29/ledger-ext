/**
 * One sync: ask Ledger where to start, walk Your Orders back to that day, read each order's
 * page, send the orders to Ledger in batches, then tell Ledger how it went. The page loading
 * and Ledger calls are passed in, so this is tested without a browser.
 */

import { LedgerError, type OrdersResult, type Status } from "./ledger/api";
import type { Blocked, ListPage, LocalProblem, Section, SyncOrder, SyncStatus } from "./types";

export type Loaded<T> = { ok: T } | { blocked: Exclude<Blocked, null> } | { failed: Section } | { skip: true };

export interface SyncDeps {
  listUrl(year: number): string;
  loadList(url: string): Promise<Loaded<ListPage>>;
  loadOrder(orderId: string): Promise<Loaded<SyncOrder>>;
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
  maxOrders?: number;
  maxListPages?: number;
  batchSize?: number;
}

export interface SyncOutcome {
  status: SyncStatus | null;
  failedSection: Section | null;
  /** Set when Ledger itself couldn't be used, so nothing could be reported. */
  localProblem: LocalProblem | null;
  ordersRead: number;
  split: number;
  waiting: number;
  waitingSince: string | null;
  syncFrom: string | null;
  chargesSplitThisMonth: number | null;
}

const localFrom = (e: unknown): LocalProblem => (e instanceof LedgerError && e.kind === "signed_out" ? "reconnect" : "ledger_unreachable");

export async function runSync(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncOutcome> {
  const maxOrders = opts.maxOrders ?? 150;
  const maxListPages = opts.maxListPages ?? 40;
  const batchSize = opts.batchSize ?? 20;
  const out: SyncOutcome = { status: null, failedSection: null, localProblem: null, ordersRead: 0, split: 0, waiting: 0, waitingSince: null, syncFrom: null, chargesSplitThisMonth: null };

  let st: Status;
  try {
    st = await deps.status();
  } catch (e) {
    out.localProblem = localFrom(e);
    return out;
  }
  out.chargesSplitThisMonth = st.chargesSplitThisMonth;
  const from = [st.syncFrom, opts.waitingSince].filter((d): d is string => !!d).sort()[0]!;
  out.syncFrom = from;

  const finish = async (status: SyncStatus, section: Section | null): Promise<SyncOutcome> => {
    out.status = status;
    out.failedSection = section;
    try {
      await deps.reportRun(status, section, out.waiting);
    } catch (e) {
      out.localProblem = localFrom(e);
    }
    return out;
  };

  // 1. Your Orders, newest first, back to `from`.
  const ids: string[] = [];
  const seen = new Set<string>();
  let pages = 0;
  const thisYear = Number(deps.today().slice(0, 4));
  years: for (let year = thisYear; year >= Number(from.slice(0, 4)); year--) {
    let url: string | null = deps.listUrl(year);
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
        // Digital orders (D01-…) have no shipped items and are charged differently.
        if (!seen.has(o.orderId) && !o.orderId.startsWith("D")) {
          seen.add(o.orderId);
          ids.push(o.orderId);
        }
      }
      if (older) break years;
      url = page.ok.nextUrl;
    }
  }

  // 2. Each order's page, oldest first, so a long first sync moves forward run by run.
  const orders: SyncOrder[] = [];
  const failures = new Map<Section, number>();
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
  // A page here and there can be odd (digital orders, odd layouts); most failing means Amazon changed.
  if (failed >= 3 && failed * 2 >= tried) {
    const worst = [...failures.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    return finish("parse_failed", worst);
  }

  // 3. Ledger, in batches.
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
