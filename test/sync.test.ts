// Invented orders and products only.
import { LedgerError } from "../src/ledger/api";
import { runSync, type SyncDeps } from "../src/sync";
import type { SyncOrder } from "../src/types";

const order = (id: string, date: string, productId: string | null = "B000000001"): SyncOrder => ({
  orderId: id,
  orderDate: date,
  items: [{ name: "Example Item", cents: 1000, quantity: 1, shipmentKey: "1", shipDate: date, productId }],
  charges: [{ date, cents: 1083, last4: "0000" }],
});

function deps(over: Partial<SyncDeps> = {}) {
  const sent: SyncOrder[][] = [];
  const reports: Array<[string, string | null, number]> = [];
  const loaded: string[] = [];
  const asked: string[] = [];
  const finished = new Set<string>();
  let cleared = 0;
  const d: SyncDeps = {
    listUrl: (y) => `list-${y}`,
    loadList: async (url) =>
      url === "list-2026"
        ? { ok: { orders: [{ orderId: "111-0000000-0000003", orderDate: "2026-03-12" }, { orderId: "D01-0000000-0000009", orderDate: "2026-03-10" }], nextUrl: "list-2026-p2" } }
        : url === "list-2026-p2"
          ? {
              ok: {
                orders: [
                  { orderId: "111-0000000-0000002", orderDate: "2026-03-01" },
                  // Placed before the start day but charged later: still read.
                  { orderId: "111-0000000-0000001", orderDate: "2026-02-05" },
                  { orderId: "111-0000000-0000000", orderDate: "2025-12-15" },
                ],
                nextUrl: "list-2026-p3",
              },
            }
          : { ok: { orders: [], nextUrl: null } },
    loadOrder: async (id) => {
      loaded.push(id);
      return { ok: order(id, "2026-03-01") };
    },
    category: async (id) => {
      asked.push(id);
      return { ok: "Grocery & Gourmet Food › Produce" };
    },
    isFinished: async (id) => finished.has(id),
    markFinished: async (ids) => void ids.forEach((id) => finished.add(id)),
    clearFinished: async () => {
      cleared++;
      finished.clear();
    },
    status: async () => ({ lastRunAt: null, lastSuccessAt: null, lastStatus: null, chargesSplitThisMonth: 4, ordersWaiting: 0, syncFrom: "2026-02-20" }),
    unsplit: async () => null,
    usedTab: () => false,
    sendOrders: async (orders) => {
      sent.push(orders);
      return { matched: orders.length, split: 1, waiting: 1, waitingSince: "2026-03-12", noMatch: 0, noChargeList: 1, done: [0] };
    },
    reportRun: async (status, section, waiting) => void reports.push([status, section, waiting]),
    pause: async () => undefined,
    today: () => "2026-03-14",
    ...over,
  };
  return { d, sent, reports, loaded, asked, finished, cleared: () => cleared };
}

describe("runSync with Ledger's unsplit charges", () => {
  const charge = (date: string, cents = 1083) => ({ date, cents, last4: "0000" });

  it("doesn't open Amazon when nothing is left to split", async () => {
    const { d, loaded, reports } = deps({ unsplit: async () => [], loadList: async () => { throw new Error("should not load"); } });
    const out = await runSync(d);
    expect(loaded).toHaveLength(0);
    expect(reports).toEqual([["ok", null, 0]]);
    expect(out.counts).toMatchObject({ unsplit: 0, listed: 0 });
  });

  it("reads only orders placed in the 30 days before a missing charge, and stops once all are found", async () => {
    const loaded: string[] = [];
    const { d } = deps({
      unsplit: async () => [charge("2026-03-01")],
      loadList: async () => ({
        ok: {
          orders: [
            { orderId: "111-0000000-0000005", orderDate: "2026-03-12" }, // after the charge: skipped
            { orderId: "111-0000000-0000004", orderDate: "2026-02-27" },
            { orderId: "111-0000000-0000003", orderDate: "2026-02-20" },
            { orderId: "111-0000000-0000002", orderDate: "2026-01-10" }, // more than 30 days before: skipped
          ],
          nextUrl: null,
        },
      }),
      loadOrder: async (id) => {
        loaded.push(id);
        return { ok: { ...order(id, "2026-02-27"), charges: [charge("2026-03-02")] } };
      },
    });
    const out = await runSync(d);
    // Oldest first; the first order read has the charge, so the second is never opened.
    expect(loaded).toEqual(["111-0000000-0000003"]);
    expect(out.counts).toMatchObject({ unsplit: 1, found: 1, read: 1 });
    expect(out.syncFrom).toBe("2026-03-01");
  });

  it("counts orders with no charge list and charges still missing", async () => {
    const { d } = deps({
      unsplit: async () => [charge("2026-03-01"), charge("2026-03-02", 555)],
      loadList: async () => ({ ok: { orders: [{ orderId: "111-0000000-0000004", orderDate: "2026-02-27" }], nextUrl: null } }),
      loadOrder: async (id) => ({ ok: { ...order(id, "2026-02-27"), charges: [] } }),
    });
    const out = await runSync(d);
    expect(out.counts).toMatchObject({ unsplit: 2, found: 0, noChargeList: 1, read: 1 });
  });

  it("notes when Amazon's pages needed a tab", async () => {
    const { d } = deps({ unsplit: async () => [charge("2026-03-01")], usedTab: () => true });
    expect((await runSync(d)).counts.usedTab).toBe(1);
  });
});

describe("runSync", () => {
  it("reads orders placed up to 30 days before the start day, oldest first, and skips digital ones", async () => {
    const { d, loaded, reports } = deps();
    const out = await runSync(d);
    expect(loaded).toEqual(["111-0000000-0000001", "111-0000000-0000002", "111-0000000-0000003"]);
    expect(reports).toEqual([["ok", null, 1]]);
    expect(out.counts).toMatchObject({ listed: 4, digital: 1, read: 3, sent: 3, split: 1, waiting: 1, noChargeList: 0, items: 3, categorized: 3, unsplit: -1 });
  });

  it("looks up each product's category once and sends it", async () => {
    const { d, sent, asked } = deps();
    await runSync(d);
    expect(asked).toEqual(["B000000001"]);
    expect(sent[0]![0]!.items[0]!.category).toBe("Grocery & Gourmet Food › Produce");
  });

  it("skips orders finished last time, and rereads them after Ledger's splits are removed", async () => {
    const first = deps();
    await runSync(first.d);
    expect(first.finished.has("111-0000000-0000001")).toBe(true);
    const again = await runSync(first.d);
    expect(again.counts.finished).toBe(1);
    first.loaded.length = 0;
    await runSync({ ...first.d, status: async () => ({ lastRunAt: null, lastSuccessAt: null, lastStatus: null, chargesSplitThisMonth: 0, ordersWaiting: 0, syncFrom: "2025-12-20" }) }, { previousLedgerFrom: "2026-02-20" });
    expect(first.cleared()).toBe(1);
    expect(first.loaded).toContain("111-0000000-0000001");
  });

  it("doesn't stop at one odd date on a page", async () => {
    const { d, loaded } = deps({
      loadList: async (url) =>
        url === "list-2026"
          ? { ok: { orders: [{ orderId: "111-0000000-0000003", orderDate: "2026-03-12" }, { orderId: "111-0000000-0000004", orderDate: "2019-01-01" }, { orderId: "111-0000000-0000002", orderDate: "2026-03-01" }], nextUrl: null } }
          : { ok: { orders: [], nextUrl: null } },
    });
    await runSync(d);
    expect(loaded).toEqual(["111-0000000-0000002", "111-0000000-0000003"]);
  });

  it("calls it broken when no order page could be read", async () => {
    const { d, reports } = deps({ loadList: async () => ({ ok: { orders: [{ orderId: "111-0000000-0000005", orderDate: "2026-03-05" }], nextUrl: null } }), loadOrder: async () => ({ failed: "order_items" }) });
    expect((await runSync(d)).status).toBe("parse_failed");
    expect(reports[0]).toEqual(["parse_failed", "order_items", 0]);
  });

  it("stops when a pager repeats the same page", async () => {
    const { d, loaded } = deps({ loadList: async () => ({ ok: { orders: [{ orderId: "111-0000000-0000005", orderDate: "2026-03-05" }], nextUrl: "same" } }) });
    await runSync(d);
    expect(loaded).toEqual(["111-0000000-0000005"]);
  });

  it("counts cancelled and unreadable orders", async () => {
    let n = 0;
    const { d } = deps({ loadOrder: async (id) => (n++ === 0 ? { skip: "cancelled" } : { ok: order(id, "2026-03-01", null) }) });
    const out = await runSync(d);
    expect(out.counts).toMatchObject({ cancelled: 1, read: 2, categorized: 0 });
  });

  it("stops at a sign-in or captcha page and tells Ledger", async () => {
    const signin = deps({ loadList: async () => ({ blocked: "signin" }) });
    expect((await runSync(signin.d)).status).toBe("amazon_signed_out");
    expect(signin.reports[0]![0]).toBe("amazon_signed_out");
    const captcha = deps({ category: async () => ({ blocked: "captcha" }) });
    expect((await runSync(captcha.d)).status).toBe("captcha");
    expect(captcha.sent).toHaveLength(0);
  });

  it("reports which section broke when most order pages can't be read", async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ orderId: `111-0000000-000001${i}`, orderDate: "2026-03-05" }));
    const { d, reports } = deps({
      loadList: async () => ({ ok: { orders: many, nextUrl: null } }),
      loadOrder: async () => ({ failed: "order_items" }),
    });
    expect((await runSync(d)).status).toBe("parse_failed");
    expect(reports).toEqual([["parse_failed", "order_items", 0]]);
  });

  it("reports a broken order list right away", async () => {
    const { d, reports } = deps({ loadList: async () => ({ failed: "orders_list" }) });
    await runSync(d);
    expect(reports).toEqual([["parse_failed", "orders_list", 0]]);
  });

  it("keeps a Ledger it can't reach, or a revoked token, to itself", async () => {
    const down = deps({ status: async () => { throw new LedgerError("unreachable", "unreachable", "x"); } });
    expect((await runSync(down.d)).localProblem).toBe("ledger_unreachable");
    expect(down.reports).toHaveLength(0);
    const revoked = deps({ status: async () => { throw new LedgerError("signed_out", "device_revoked", "x", 401); } });
    expect((await runSync(revoked.d)).localProblem).toBe("reconnect");
  });

  it("reports ledger_error when Ledger fails to save", async () => {
    const { d, reports } = deps({ sendOrders: async () => { throw new LedgerError("server", "internal", "x", 500); } });
    expect((await runSync(d)).status).toBe("ledger_error");
    expect(reports[0]![0]).toBe("ledger_error");
  });
});
