// Fixtures are hand-written with invented names, orders, cards and prices.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { blocked, chargesIn, outline, ParseError, parseOrderDetails, parseOrderList, parseProductCategory, parseTransactions } from "../src/amazon/parse";

const page = (name: string) => new JSDOM(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")).window.document;
const BASE = "https://www.amazon.com/your-orders/orders?timeFilter=year-2026";

describe("order list", () => {
  it("reads order numbers, dates and the next page", () => {
    const r = parseOrderList(page("orders-list.html"), BASE);
    expect(r.orders).toEqual([
      { orderId: "111-0000000-0000003", orderDate: "2026-03-12" },
      { orderId: "111-0000000-0000002", orderDate: "2026-03-01" },
      { orderId: "D01-0000000-0000009", orderDate: "2026-02-20" },
    ]);
    expect(r.nextUrl).toBe("https://www.amazon.com/your-orders/orders?timeFilter=year-2026&startIndex=10");
  });

  it("treats a year with no orders as empty, not broken", () => {
    expect(parseOrderList(page("orders-empty.html"), BASE)).toEqual({ orders: [], nextUrl: null });
  });

  it("says which part broke when the page is unrecognizable", () => {
    expect(() => parseOrderList(page("order-changed.html"), BASE)).toThrow(ParseError);
  });
});

describe("order details", () => {
  it("reads items by shipment, quantities and Amazon's charges (no refunds)", () => {
    const o = parseOrderDetails(page("order-new-layout.html"), "111-0000000-0000002");
    expect(o.orderDate).toBe("2026-03-01");
    expect(o.items).toEqual([
      { name: "Example Multivitamin, 120 Count", productId: "B000000001", cents: 2000, quantity: 1, shipmentKey: "1", shipDate: "2026-03-03" },
      { name: "Paper Towels, 12 Rolls", productId: "B000000002", cents: 1500, quantity: 2, shipmentKey: "1", shipDate: "2026-03-03" },
      { name: "Kids Rain Jacket", productId: "B000000003", cents: 103450, quantity: 1, shipmentKey: "2", shipDate: "2026-03-05" },
    ]);
    expect(o.charges).toEqual([
      { date: "2026-03-02", cents: 5400, last4: "0000" },
      { date: "2026-03-04", cents: 110521, last4: "0000" },
    ]);
  });

  it("never carries the shipping address or anything else from the page", () => {
    const o = parseOrderDetails(page("order-new-layout.html"), "111-0000000-0000002");
    const json = JSON.stringify(o);
    expect(json).not.toMatch(/Jordan|Invented Way/);
    expect(Object.keys(o).sort()).toEqual(["charges", "items", "orderDate", "orderId"]);
  });

  it("reads the older layout", () => {
    const o = parseOrderDetails(page("order-legacy.html"), "111-0000000-0000004");
    expect(o.orderDate).toBe("2026-02-27");
    expect(o.items).toEqual([{ name: "Building Bricks Castle Set", productId: "B000000004", cents: 6000, quantity: 1, shipmentKey: "1", shipDate: "2026-02-28" }]);
    expect(o.charges).toEqual([]);
  });

  it("reads card charges from the invoice and skips gift cards", () => {
    expect(chargesIn(page("invoice.html"))).toEqual([{ date: "2026-02-28", cents: 6495, last4: "0000" }]);
  });

  it("reports order_items when items can't be found", () => {
    try {
      parseOrderDetails(page("order-changed.html"), "x");
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ParseError).section).toBe("order_items");
    }
  });
});

describe("Amazon's locked pages", () => {
  it("calls an order list with locked boxes unreadable, never taking a stray order link from the page", () => {
    expect(() => parseOrderList(page("orders-locked.html"), BASE)).toThrow(ParseError);
  });

  it("tells Amazon's 'unable to load' banner apart from a changed page", () => {
    try {
      parseOrderDetails(page("order-unavailable.html"), "x");
      throw new Error("should have failed");
    } catch (e) {
      expect((e as ParseError).section).toBe("order_unavailable");
    }
  });
});

describe("current order page layout", () => {
  it("reads every item in a shipment, by shipment, with product ids and quantities", () => {
    const o = parseOrderDetails(page("order-current-layout.html"), "111-0000000-0000007");
    expect(o.orderDate).toBe("2026-11-15");
    expect(o.items).toEqual([
      { name: "Example Hockey Tape, 6 Pack", cents: 1200, quantity: 1, productId: "B000000011", shipmentKey: "1", shipDate: "2026-11-17" },
      { name: "Example Sweet Potatoes, 3 lb", cents: 1000, quantity: 2, productId: "B000000012", shipmentKey: "1", shipDate: "2026-11-17" },
      { name: "Example Dish Soap", cents: 450, quantity: 1, productId: "B000000013", shipmentKey: "2", shipDate: "2026-12-02" },
    ]);
    // The charges are behind "View related transactions" now, not on the page.
    expect(o.charges).toEqual([]);
    expect(JSON.stringify(o)).not.toMatch(/Jordan|Invented/);
  });
});

describe("Your Payments transactions", () => {
  it("reads each charge's date, amount, card and orders, leaving out refunds and rows without an order", () => {
    const r = parseTransactions(page("transactions.html"));
    expect(r.rows).toEqual([
      { date: "2026-11-19", cents: 2541, last4: "0000", orderIds: ["111-0000000-0000007"] },
      { date: "2026-11-19", cents: 487, last4: "0000", orderIds: ["111-0000000-0000007"] },
      { date: "2026-11-17", cents: 103450, last4: "9999", orderIds: ["111-0000000-0000005", "111-0000000-0000004"] },
    ]);
    expect(r.hasNext).toBe(true);
  });
});

describe("order list paging", () => {
  it("builds the next page from startIndex when a full page has no Next link", () => {
    const r = parseOrderList(page("orders-list-no-pager.html"), "https://www.amazon.com/your-orders/orders?timeFilter=year-2026&startIndex=10");
    expect(r.orders).toHaveLength(10);
    expect(r.nextUrl).toBe("https://www.amazon.com/your-orders/orders?timeFilter=year-2026&startIndex=20");
  });
});

describe("product category", () => {
  it("reads the breadcrumb trail", () => {
    expect(parseProductCategory(page("product.html"))).toBe("Grocery & Gourmet Food › Produce › Fresh Vegetables");
  });

  it("falls back to the store name, then to nothing", () => {
    expect(parseProductCategory(page("product-no-breadcrumb.html"))).toBe("Health & Household");
    expect(parseProductCategory(page("order-changed.html"))).toBeNull();
  });
});

describe("blocked pages", () => {
  it("spots sign-in and captcha pages", () => {
    expect(blocked(page("signin.html"), "https://www.amazon.com/ap/signin?x=1")).toBe("signin");
    expect(blocked(page("signin.html"), "https://www.amazon.com/your-orders/orders")).toBe("signin");
    expect(blocked(page("captcha.html"), "https://www.amazon.com/your-orders/orders")).toBe("captcha");
    expect(blocked(page("orders-list.html"), BASE)).toBeNull();
  });
});

describe("page outline", () => {
  it("masks names, addresses, prices and order numbers but keeps the structure", () => {
    const text = outline(page("order-new-layout.html"));
    expect(text).toContain('data-component="purchasedItems"');
    expect(text).toContain("Transactions");
    expect(text).not.toMatch(/Jordan|Invented|Multivitamin|Visa|111-0000000|\$[\d,.]*[1-9]/);
    expect(text).toContain("$00.00");
  });
});
