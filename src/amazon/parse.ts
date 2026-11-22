/**
 * Reads Amazon's order pages. Takes a parsed Document (DOMParser in the extension, jsdom in
 * tests) and returns only what Ledger needs; everything else on the page is ignored and
 * nothing is kept. Page scripts never run: DOMParser doesn't execute them.
 */

import { BLOCKED, DETAILS, LIST, OUTLINE_WORDS, PRODUCT } from "./selectors";
import { cents, clean, fullDate, ORDER_ID, shortDate } from "./text";
import type { Blocked, ListPage, Section, SyncCharge, SyncItem, SyncOrder } from "../types";

export class ParseError extends Error {
  constructor(readonly section: Section) {
    super(`Couldn't read ${section}`);
    this.name = "ParseError";
  }
}

function first(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const s of selectors) {
    const hit = root.querySelector(s);
    if (hit) return hit;
  }
  return null;
}

function all(root: ParentNode, selectors: readonly string[]): Element[] {
  for (const s of selectors) {
    const hits = [...root.querySelectorAll(s)];
    if (hits.length) return hits;
  }
  return [];
}

const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIELDSET|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|TABLE|TBODY|TD|TH|THEAD|TR|UL)$/;

/** The text of an element with a line break at every block, so patterns don't run across boxes. */
export function blockText(root: Node): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) out.push(node.nodeValue ?? "");
    else if (node.nodeType === 1) {
      const el = node as Element;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) return;
      const block = BLOCK.test(el.tagName);
      if (block) out.push("\n");
      for (const child of el.childNodes) walk(child);
      if (block) out.push("\n");
    }
  };
  walk(root);
  return out.join("").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** A sign-in or captcha page instead of the page asked for. */
export function blocked(doc: Document, url: string): Blocked {
  if (BLOCKED.signinUrl.test(url) || first(doc, BLOCKED.signin)) return "signin";
  if (BLOCKED.captchaUrl.test(url) || first(doc, BLOCKED.captcha) || BLOCKED.captchaText.test(doc.body?.textContent ?? "")) return "captcha";
  return null;
}

function idsIn(el: Element): string[] {
  const ids = new Set<string>();
  for (const a of el.querySelectorAll("a[href]")) {
    const m = /orderI[Dd]=([A-Z0-9-]+)/.exec(a.getAttribute("href") ?? "");
    if (m && ORDER_ID.test(m[1]!)) ids.add(m[1]!);
  }
  const text = ORDER_ID.exec(el.textContent ?? "");
  if (text) ids.add(text[1]!);
  return [...ids];
}

/** Your Orders: the orders on this page (newest first) and the next page's address. */
export function parseOrderList(doc: Document, url: string): ListPage {
  // Locked order boxes: the real orders aren't on this copy of the page, and any order number
  // elsewhere on it (a banner, an ad) isn't one of them. Report it so a real page is used.
  const locked = [...doc.querySelectorAll(LIST.locked)].filter((el) => !el.children.length && !clean(el.textContent));
  if (locked.length) throw new ParseError("orders_list");
  const orders: ListPage["orders"] = [];
  const seen = new Set<string>();
  for (const card of all(doc, LIST.orderCard)) {
    const idEl = first(card, LIST.orderId);
    const id = (idEl && ORDER_ID.exec(idEl.textContent ?? "")?.[1]) ?? idsIn(card)[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = blockText(card);
    const placed = /order placed\s*\n?\s*(.{0,30})/i.exec(text);
    orders.push({ orderId: id, orderDate: (placed && fullDate(placed[1]!)) ?? fullDate(text) });
  }
  // No order boxes on the page at all: any order links on it, without dates.
  if (!orders.length && !all(doc, LIST.orderCard).length) {
    for (const id of idsIn(doc.body ?? doc.documentElement)) if (!seen.has(id)) orders.push({ orderId: id, orderDate: null });
  }
  if (!orders.length && !LIST.emptyText.test(doc.body?.textContent ?? "")) throw new ParseError("orders_list");
  const next = first(doc, LIST.next)?.getAttribute("href") ?? null;
  return { orders, nextUrl: next ? new URL(next, url).toString() : fullPageNext(url, orders.length) };
}

/**
 * No "Next" link found but the page is full (Amazon shows 10 at a time): the next page by its
 * startIndex, so a changed pager doesn't quietly stop the sync at the first page.
 */
function fullPageNext(url: string, count: number): string | null {
  if (count < 10) return null;
  const next = new URL(url);
  next.searchParams.set("startIndex", String(Number(next.searchParams.get("startIndex") ?? 0) + count));
  return next.toString();
}

function orderDateOf(doc: Document): string | null {
  const el = first(doc, DETAILS.orderDate);
  const fromEl = el ? fullDate(el.textContent ?? "") : null;
  if (fromEl) return fromEl;
  const m = new RegExp(DETAILS.orderDateText.source + "(.{0,30})", "i").exec(blockText(doc.body ?? doc.documentElement));
  return m ? fullDate(m[1]!) : null;
}

function quantityOf(block: Element): number {
  const el = first(block, DETAILS.itemQuantity);
  const raw = clean(el?.textContent);
  if (raw && /^\d{1,3}$/.test(raw)) return Number(raw);
  const m = DETAILS.quantityText.exec(raw || block.textContent || "");
  return m ? Number(m[1]) : 1;
}

function productIdOf(block: Element): string | null {
  for (const a of block.querySelectorAll("a[href]")) {
    const m = DETAILS.productLink.exec(a.getAttribute("href") ?? "");
    if (m) return m[1]!;
  }
  return null;
}

function itemFrom(block: Element): Omit<SyncItem, "shipmentKey" | "shipDate"> | null {
  const titleEl = first(block, DETAILS.itemTitle);
  const name = clean(titleEl?.textContent);
  if (!name || name.length > 300) return null;
  const priceEl = first(block, DETAILS.itemPrice);
  const price = cents(priceEl?.textContent ?? "") ?? cents(block.textContent ?? "");
  if (price === null) return null;
  return { name, cents: price, quantity: quantityOf(block), productId: productIdOf(block) };
}

/**
 * A product page's category trail, "Grocery & Gourmet Food › Produce", at most 200 characters.
 * Null when the page doesn't show one (that's not an error).
 */
export function parseProductCategory(doc: Document): string | null {
  const crumbs = all(doc, PRODUCT.breadcrumb)
    .map((a) => clean(a.textContent))
    .filter((t) => t && t !== "›" && !PRODUCT.notCategory.test(t));
  let path = [...new Set(crumbs)].join(" › ");
  if (!path) {
    const store = clean(first(doc, PRODUCT.storeName)?.textContent);
    path = store && !PRODUCT.notCategory.test(store) ? store : "";
  }
  if (!path) return null;
  while (path.length > 200 && path.includes(" › ")) path = path.slice(0, path.lastIndexOf(" › "));
  return path.slice(0, 200);
}

/** The charges an order page or invoice lists, refunds and gift cards left out. */
export function chargesIn(doc: Document): SyncCharge[] {
  const out: SyncCharge[] = [];
  const seen = new Set<string>();
  for (const line of blockText(doc.body ?? doc.documentElement).split("\n")) {
    if (DETAILS.refundText.test(line)) continue;
    let date: string | null = null;
    let last4: string | null = null;
    let amount: number | null = null;
    const a = DETAILS.chargeOnOrder.exec(line);
    const b = a ? null : DETAILS.chargeOnInvoice.exec(line);
    if (a) [date, last4, amount] = [fullDate(a[1]!), a[2]!, cents(a[3]!)];
    else if (b) [date, last4, amount] = [fullDate(b[2]!), b[1]!, cents(b[3]!)];
    if (!date || amount === null || amount <= 0) continue;
    const key = `${date}|${last4}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, cents: amount, last4 });
  }
  return out;
}

export function isCancelled(doc: Document): boolean {
  return DETAILS.cancelledText.test(doc.body?.textContent ?? "");
}

/**
 * An order's details page. Items are grouped by the shipment box they're in. Throws a
 * ParseError naming the section when the page is an order page but can't be read.
 */
export function parseOrderDetails(doc: Document, orderId: string): SyncOrder {
  const orderDate = orderDateOf(doc);
  if (!orderDate) {
    // Amazon's own "unable to load your order details" banner, not a page we can't read.
    if (first(doc, DETAILS.unavailable)) throw new ParseError("order_unavailable");
    throw new ParseError("order_date");
  }
  const items: SyncItem[] = [];
  const boxes = all(doc, DETAILS.shipment);
  const groups: Array<{ key: string; root: Element; shipDate: string | null }> = boxes.length
    ? boxes.map((root, i) => {
        const line = blockText(root).split("\n").find((l) => DETAILS.shipmentDateText.test(l)) ?? "";
        return { key: String(i + 1), root, shipDate: shortDate(line, orderDate) };
      })
    : [{ key: "1", root: doc.body ?? doc.documentElement, shipDate: null }];
  const taken = new Set<Element>();
  for (const g of groups) {
    for (const block of all(g.root, DETAILS.item)) {
      if (taken.has(block)) continue;
      taken.add(block);
      const it = itemFrom(block);
      if (it) items.push({ ...it, shipmentKey: g.key, shipDate: g.shipDate });
    }
  }
  // Items listed apart from the shipment boxes: read them from the whole page as one shipment.
  if (!items.length && boxes.length) {
    for (const block of all(doc, DETAILS.item)) {
      const it = itemFrom(block);
      if (it) items.push({ ...it, shipmentKey: "1", shipDate: groups[0]?.shipDate ?? null });
    }
  }
  if (!items.length) throw new ParseError("order_items");
  return { orderId, orderDate, items, charges: chargesIn(doc) };
}

/**
 * The page's structure with every word masked except a few layout labels, for fixing the
 * selectors when Amazon changes its pages. Letters become x, digits 0; links and images lose
 * their addresses. Safe to paste into a chat or a bug report.
 */
export function outline(doc: Document): string {
  const keep = new Set(OUTLINE_WORDS);
  const mask = (text: string) =>
    text.replace(/[A-Za-z0-9'’]+/g, (w) => (keep.has(w.toLowerCase()) ? w : w.replace(/[A-Za-z]/g, "x").replace(/\d/g, "0")));
  const lines: string[] = [];
  const walk = (el: Element, depth: number) => {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME|LINK|META|HEADER|FOOTER)$/i.test(el.tagName) || depth > 40 || lines.length >= 1500) return;
    // Amazon's site-wide header, menus and footer say nothing about the order.
    if (/^(nav|rhf|skiplink|navFooter|navbar|hmenu)/i.test(el.id)) return;
    const attrs = ["id", "class", "data-component", "role", "aria-label"]
      .map((a) => {
        const v = el.getAttribute(a);
        if (!v) return "";
        const safe = a === "aria-label" ? mask(v) : v.replace(/\d{3}-\d{7}-\d{7}/g, "000-0000000-0000000").replace(/\d{4,}/g, "0000");
        return ` ${a}="${safe.slice(0, 120)}"`;
      })
      .join("");
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => clean(n.nodeValue)).join(" ");
    lines.push(`${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${attrs}>${own ? " " + mask(own).slice(0, 120) : ""}`);
    for (const child of el.children) walk(child, depth + 1);
  };
  if (doc.body) walk(doc.body, 0);
  return lines.join("\n");
}
