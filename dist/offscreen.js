// src/amazon/selectors.ts
var LIST = {
  /** One box per order on Your Orders. */
  orderCard: [".order-card", ".js-order-card", "#ordersContainer .order", ".a-box-group.order"],
  /** Where the order number is written inside a card. */
  orderId: ['[data-component="orderId"]', ".yohtmlc-order-id", ".order-header"],
  /** Links that carry an order number in their address. */
  orderLink: ['a[href*="orderID="]', 'a[href*="orderId="]'],
  /** The "Next →" link. */
  next: [".a-pagination .a-last:not(.a-disabled) a[href]", 'a[aria-label*="Next"][href]', "ul.a-pagination li:last-child a[href]"],
  /** Shown when a year has no orders, so an empty page isn't mistaken for a broken one. */
  emptyText: /(?:^|\s)0 orders placed|have not placed any orders|no orders (?:placed|found)|looks like you haven't placed/i
};
var DETAILS = {
  orderDate: ['[data-component="orderDate"]', ".order-date-invoice-item", "#orderDetails .a-span3 .a-color-secondary"],
  orderDateText: /(?:ordered on|order placed)\s*:?\s*/i,
  /** One box per shipment. */
  shipment: ['[data-component="shipments"] > div', '[data-component="shipments"] .a-box', ".shipment", "#od-subtotals ~ .a-box"],
  shipmentDateText: /(?:shipped|delivered|arriving|now arriving|expected)\b/i,
  /** One block per item. */
  item: ['[data-component="purchasedItems"] > div', '[data-component="purchasedItems"] .a-fixed-left-grid', ".yohtmlc-item", ".a-fixed-left-grid.item-box"],
  itemTitle: ['[data-component="itemTitle"]', ".yohtmlc-product-title", 'a.a-link-normal[href*="/dp/"]', 'a[href*="/dp/"]', 'a[href*="/gp/product/"]'],
  itemPrice: ['[data-component="unitPrice"] .a-offscreen', '[data-component="unitPrice"]', ".a-color-price", ".yohtmlc-item .a-price .a-offscreen"],
  itemQuantity: [".od-item-view-qty", ".item-view-qty", '[data-component="quantity"]'],
  quantityText: /(?:qty|quantity)\s*:?\s*(\d{1,3})/i,
  /** "November 19, 2026 - Visa ending in 0000: $25.41" (order page). */
  chargeOnOrder: /([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*[-–:]\s*[^\n]{0,60}?ending in\s*(\d{4})\s*:\s*(\$\s*[\d,]+\.\d{2})/i,
  /** "Visa ending in 0000: November 19, 2026: $25.41" (invoice page). */
  chargeOnInvoice: /ending in\s*(\d{4})\s*:\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*:\s*(\$\s*[\d,]+\.\d{2})/i,
  refundText: /refund|credit(?:ed)? to|returned/i,
  cancelledText: /this order (?:has been|was) cancel|order cancell?ed/i
};
var BLOCKED = {
  signinUrl: /\/ap\/(?:signin|mfa|cvf)|\/ax\/claim/,
  signin: ['form[name="signIn"]', "#ap_email", "#ap_password", 'form[action*="/ap/signin"]'],
  captchaUrl: /validateCaptcha|\/errors\/|captcha/i,
  captcha: ['form[action*="validateCaptcha"]', "#captchacharacters", 'img[src*="captcha"]'],
  captchaText: /enter the characters you see|type the characters|solve this puzzle|verify (?:that )?you(?:'re| are) (?:a )?human/i
};
var OUTLINE_WORDS = [
  "order",
  "orders",
  "placed",
  "ordered",
  "on",
  "total",
  "subtotal",
  "grand",
  "items",
  "item",
  "ship",
  "shipped",
  "to",
  "delivered",
  "arriving",
  "transactions",
  "transaction",
  "ending",
  "in",
  "qty",
  "quantity",
  "price",
  "refund",
  "payment",
  "method",
  "invoice",
  "details",
  "summary",
  "tax",
  "shipping",
  "handling",
  "before",
  "estimated",
  "next",
  "previous",
  "sold",
  "by",
  "return",
  "buy",
  "it",
  "again",
  "view",
  "your",
  "item",
  "track",
  "package",
  "credit",
  "card",
  "gift",
  "promotion",
  "applied",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
];

// src/amazon/text.ts
var MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
var MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
var pad = (n) => String(n).padStart(2, "0");
var monthIndex = (name) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().replace(".", "").slice(0, 3)));
function fullDate(text) {
  const m = new RegExp(`${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i").exec(text);
  if (!m) return null;
  const month = monthIndex(m[1]);
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  return `${m[3]}-${pad(month + 1)}-${pad(day)}`;
}
function shortDate(text, after) {
  const full = fullDate(text);
  if (full) return full;
  const m = new RegExp(`${MONTH}\\s+(\\d{1,2})(?!\\d|,?\\s*\\d{4})`, "i").exec(text);
  if (!m) return null;
  const month = monthIndex(m[1]);
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  let year = Number(after.slice(0, 4));
  let iso = `${year}-${pad(month + 1)}-${pad(day)}`;
  if (iso < after) iso = `${++year}-${pad(month + 1)}-${pad(day)}`;
  return iso;
}
function cents(text) {
  const m = /\$\s*([\d,]+)(?:\.(\d{2}))?/.exec(text);
  if (!m) return null;
  return Number(m[1].replace(/,/g, "")) * 100 + Number(m[2] ?? 0);
}
var ORDER_ID = /\b(\d{3}-\d{7}-\d{7}|D\d{2}-\d{7}-\d{7})\b/;
var clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();

// src/amazon/parse.ts
var ParseError = class extends Error {
  constructor(section) {
    super(`Couldn't read ${section}`);
    this.section = section;
    this.name = "ParseError";
  }
};
function first(root, selectors) {
  for (const s of selectors) {
    const hit = root.querySelector(s);
    if (hit) return hit;
  }
  return null;
}
function all(root, selectors) {
  for (const s of selectors) {
    const hits = [...root.querySelectorAll(s)];
    if (hits.length) return hits;
  }
  return [];
}
var BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|FIELDSET|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|TABLE|TBODY|TD|TH|THEAD|TR|UL)$/;
function blockText(root) {
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) out.push(node.nodeValue ?? "");
    else if (node.nodeType === 1) {
      const el = node;
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
function blocked(doc, url) {
  if (BLOCKED.signinUrl.test(url) || first(doc, BLOCKED.signin)) return "signin";
  if (BLOCKED.captchaUrl.test(url) || first(doc, BLOCKED.captcha) || BLOCKED.captchaText.test(doc.body?.textContent ?? "")) return "captcha";
  return null;
}
function idsIn(el) {
  const ids = /* @__PURE__ */ new Set();
  for (const a of el.querySelectorAll("a[href]")) {
    const m = /orderI[Dd]=([A-Z0-9-]+)/.exec(a.getAttribute("href") ?? "");
    if (m && ORDER_ID.test(m[1])) ids.add(m[1]);
  }
  const text = ORDER_ID.exec(el.textContent ?? "");
  if (text) ids.add(text[1]);
  return [...ids];
}
function parseOrderList(doc, url) {
  const orders = [];
  const seen = /* @__PURE__ */ new Set();
  for (const card of all(doc, LIST.orderCard)) {
    const idEl = first(card, LIST.orderId);
    const id = (idEl && ORDER_ID.exec(idEl.textContent ?? "")?.[1]) ?? idsIn(card)[0];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = blockText(card);
    const placed = /order placed\s*\n?\s*(.{0,30})/i.exec(text);
    orders.push({ orderId: id, orderDate: (placed && fullDate(placed[1])) ?? fullDate(text) });
  }
  if (!orders.length) {
    for (const id of idsIn(doc.body ?? doc.documentElement)) if (!seen.has(id)) orders.push({ orderId: id, orderDate: null });
  }
  if (!orders.length && !LIST.emptyText.test(doc.body?.textContent ?? "")) throw new ParseError("orders_list");
  const next = first(doc, LIST.next)?.getAttribute("href") ?? null;
  return { orders, nextUrl: next ? new URL(next, url).toString() : null };
}
function orderDateOf(doc) {
  const el = first(doc, DETAILS.orderDate);
  const fromEl = el ? fullDate(el.textContent ?? "") : null;
  if (fromEl) return fromEl;
  const m = new RegExp(DETAILS.orderDateText.source + "(.{0,30})", "i").exec(blockText(doc.body ?? doc.documentElement));
  return m ? fullDate(m[1]) : null;
}
function quantityOf(block) {
  const el = first(block, DETAILS.itemQuantity);
  const raw = clean(el?.textContent);
  if (raw && /^\d{1,3}$/.test(raw)) return Number(raw);
  const m = DETAILS.quantityText.exec(raw || block.textContent || "");
  return m ? Number(m[1]) : 1;
}
function itemFrom(block) {
  const titleEl = first(block, DETAILS.itemTitle);
  const name = clean(titleEl?.textContent);
  if (!name || name.length > 300) return null;
  const priceEl = first(block, DETAILS.itemPrice);
  const price = cents(priceEl?.textContent ?? "") ?? cents(block.textContent ?? "");
  if (price === null) return null;
  return { name, cents: price, quantity: quantityOf(block) };
}
function chargesIn(doc) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const line of blockText(doc.body ?? doc.documentElement).split("\n")) {
    if (DETAILS.refundText.test(line)) continue;
    let date = null;
    let last4 = null;
    let amount = null;
    const a = DETAILS.chargeOnOrder.exec(line);
    const b = a ? null : DETAILS.chargeOnInvoice.exec(line);
    if (a) [date, last4, amount] = [fullDate(a[1]), a[2], cents(a[3])];
    else if (b) [date, last4, amount] = [fullDate(b[2]), b[1], cents(b[3])];
    if (!date || amount === null || amount <= 0) continue;
    const key = `${date}|${last4}|${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date, cents: amount, last4 });
  }
  return out;
}
function isCancelled(doc) {
  return DETAILS.cancelledText.test(doc.body?.textContent ?? "");
}
function parseOrderDetails(doc, orderId) {
  const orderDate = orderDateOf(doc);
  if (!orderDate) throw new ParseError("order_date");
  const items = [];
  const boxes = all(doc, DETAILS.shipment);
  const groups = boxes.length ? boxes.map((root, i) => {
    const line = blockText(root).split("\n").find((l) => DETAILS.shipmentDateText.test(l)) ?? "";
    return { key: String(i + 1), root, shipDate: shortDate(line, orderDate) };
  }) : [{ key: "1", root: doc.body ?? doc.documentElement, shipDate: null }];
  const taken = /* @__PURE__ */ new Set();
  for (const g of groups) {
    for (const block of all(g.root, DETAILS.item)) {
      if (taken.has(block)) continue;
      taken.add(block);
      const it = itemFrom(block);
      if (it) items.push({ ...it, shipmentKey: g.key, shipDate: g.shipDate });
    }
  }
  if (!items.length && boxes.length) {
    for (const block of all(doc, DETAILS.item)) {
      const it = itemFrom(block);
      if (it) items.push({ ...it, shipmentKey: "1", shipDate: groups[0]?.shipDate ?? null });
    }
  }
  if (!items.length) throw new ParseError("order_items");
  return { orderId, orderDate, items, charges: chargesIn(doc) };
}
function outline(doc) {
  const keep = new Set(OUTLINE_WORDS);
  const mask = (text) => text.replace(/[A-Za-z0-9'’]+/g, (w) => keep.has(w.toLowerCase()) ? w : w.replace(/[A-Za-z]/g, "x").replace(/\d/g, "0"));
  const lines = [];
  const walk = (el, depth) => {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME|LINK|META)$/i.test(el.tagName) || depth > 40) return;
    const attrs = ["id", "class", "data-component", "role", "aria-label"].map((a) => {
      const v = el.getAttribute(a);
      if (!v) return "";
      const safe = a === "aria-label" ? mask(v) : v.replace(/\d{3}-\d{7}-\d{7}/g, "000-0000000-0000000").replace(/\d{4,}/g, "0000");
      return ` ${a}="${safe.slice(0, 120)}"`;
    }).join("");
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => clean(n.nodeValue)).join(" ");
    lines.push(`${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${attrs}>${own ? " " + mask(own).slice(0, 120) : ""}`);
    for (const child of el.children) walk(child, depth + 1);
  };
  if (doc.body) walk(doc.body, 0);
  return lines.join("\n");
}

// src/offscreen.ts
function handle(msg) {
  const doc = new DOMParser().parseFromString(msg.html, "text/html");
  const stop = blocked(doc, msg.url);
  if (stop) return { blocked: stop };
  try {
    switch (msg.kind) {
      case "list":
        return { ok: parseOrderList(doc, msg.url) };
      case "order":
        if (isCancelled(doc)) return { skip: true };
        return { ok: parseOrderDetails(doc, msg.orderId ?? "") };
      case "charges":
        return { ok: chargesIn(doc) };
      case "outline":
        return { outline: outline(doc) };
    }
  } catch (e) {
    if (e instanceof ParseError) return { failed: e.section };
    return { failed: msg.kind === "list" ? "orders_list" : "order_items" };
  }
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== "offscreen") return false;
  reply(handle(msg));
  return false;
});
