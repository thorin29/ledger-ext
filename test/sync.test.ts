// Invented orders only.
import { LedgerError } from "../src/ledger/api";
import { runSync, type SyncDeps } from "../src/sync";
import type { SyncOrder } from "../src/types";

const order = (id: string, date: string): SyncOrder => ({
  orderId: id,
  orderDate: date,
  items: [{ name: "Example Item", cents: 1000, quantity: 1, shipmentKey: "1", shipDate: date }],
  charges: [{ date, cents: 1083, last4: "0000" }],
});

function deps(over: Partial<SyncDeps> = {}) {
  const sent: SyncOrder[][] = [];
  const reports: Array<[string, string | null, number]> = [];
  const loaded: string[] = [];
  const d: SyncDeps = {
    listUrl: (y) => `list-${y}`,
    loadList: async (url) =>
      url === "list-2026"
        ? { ok: { orders: [{ orderId: "111-0000000-0000003", orderDate: "2026-03-12" }, { orderId: "D01-0000000-0000009", orderDate: "2026-03-10" }], nextUrl: "list-2026-p2" } }
        : url === "list-2026-p2"
          ? { ok: { orders: [{ orderId: "111-0000000-0000002", orderDate: "2026-03-01" }, { orderId: "111-0000000-0000001", orderDate: "2026-01-15" }], nextUrl: "list-2026-p3" } }
          : { ok: { orders: [], nextUrl: null } },
    loadOrder: async (id) => {
      loaded.push(id);
      return { ok: order(id, id.endsWith("3") ? "2026-03-12" : "2026-03-01") };
    },
    status: async () => ({ lastRunAt: null, lastSuccessAt: null, lastStatus: null, chargesSplitThisMonth: 4, ordersWaiting: 0, syncFrom: "2026-02-20" }),
    sendOrders: async (orders) => {
      sent.push(orders);
      return { matched: orders.length, split: 1, waiting: 1, waitingSince: "2026-03-12" };
    },
    reportRun: async (status, section, waiting) => void reports.push([status, section, waiting]),
    pause: async () => undefined,
    today: () => "2026-03-14",
    ...over,
  };
  return { d, sent, reports, loaded };
}

describe("runSync", () => {
  it("walks back to Ledger's start date, oldest order first, skips digital orders, and reports ok", async () => {
    const { d, sent, reports, loaded } = deps();
    const out = await runSync(d);
    expect(loaded).toEqual(["111-0000000-0000002", "111-0000000-0000003"]);
    expect(sent.flat().map((o) => o.orderId)).toEqual(["111-0000000-0000002", "111-0000000-0000003"]);
    expect(reports).toEqual([["ok", null, 1]]);
    expect(out).toMatchObject({ status: "ok", split: 1, waiting: 1, waitingSince: "2026-03-12", syncFrom: "2026-02-20" });
  });

  it("starts earlier when an order from last time is still waiting", async () => {
    const { d } = deps();
    const out = await runSync(d, { waitingSince: "2026-01-10" });
    expect(out.syncFrom).toBe("2026-01-10");
  });

  it("stops at a sign-in or captcha page and tells Ledger", async () => {
    const signin = deps({ loadList: async () => ({ blocked: "signin" }) });
    expect((await runSync(signin.d)).status).toBe("amazon_signed_out");
    expect(signin.reports[0]![0]).toBe("amazon_signed_out");
    const captcha = deps({ loadOrder: async () => ({ blocked: "captcha" }) });
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
