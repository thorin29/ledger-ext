/**
 * Every place the extension looks on Amazon's pages, in one file, newest layout first. Amazon
 * changes its markup often; when a sync reports "parse_failed", this is the file to update.
 * Each list is tried in order and the first that finds something wins; the parser also falls
 * back to reading plain text patterns ("Order placed", "ending in 0000: $…").
 */

export const LIST = {
  /** One box per order on Your Orders. */
  orderCard: [".order-card", ".js-order-card", "#ordersContainer .order", ".a-box-group.order"],
  /** Where the order number is written inside a card. */
  orderId: ['[data-component="orderId"]', ".yohtmlc-order-id", ".order-header"],
  /** Links that carry an order number in their address. */
  orderLink: ['a[href*="orderID="]', 'a[href*="orderId="]'],
  /** The "Next →" link. */
  next: [".a-pagination .a-last:not(.a-disabled) a[href]", 'a[aria-label*="Next"][href]', 'ul.a-pagination li:last-child a[href]'],
  /** Shown when a year has no orders, so an empty page isn't mistaken for a broken one. */
  emptyText: /(?:^|\s)0 orders placed|have not placed any orders|no orders (?:placed|found)|looks like you haven't placed/i,
};

export const DETAILS = {
  orderDate: ['[data-component="orderDate"]', ".order-date-invoice-item", "#orderDetails .a-span3 .a-color-secondary"],
  orderDateText: /(?:ordered on|order placed)\s*:?\s*/i,
  /** One box per shipment. */
  shipment: ['[data-component="shipments"] > div', '[data-component="shipments"] .a-box', ".shipment", "#od-subtotals ~ .a-box"],
  shipmentDateText: /(?:shipped|delivered|arriving|now arriving|expected)\b/i,
  /** One block per item. */
  item: ['[data-component="purchasedItems"] > div', '[data-component="purchasedItems"] .a-fixed-left-grid', ".yohtmlc-item", ".a-fixed-left-grid.item-box"],
  itemTitle: ['[data-component="itemTitle"]', ".yohtmlc-product-title", 'a.a-link-normal[href*="/dp/"]', 'a[href*="/dp/"]', 'a[href*="/gp/product/"]'],
  itemPrice: ['[data-component="unitPrice"] .a-offscreen', '[data-component="unitPrice"]', ".a-color-price", ".yohtmlc-item .a-price .a-offscreen"],
  /** The product id (ASIN) in an item's link. */
  productLink: /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/,
  itemQuantity: [".od-item-view-qty", ".item-view-qty", '[data-component="quantity"]'],
  quantityText: /(?:qty|quantity)\s*:?\s*(\d{1,3})/i,
  /** "November 19, 2026 - Visa ending in 0000: $25.41" (order page). */
  chargeOnOrder: /([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*[-–:]\s*[^\n]{0,60}?ending in\s*(\d{4})\s*:\s*(\$\s*[\d,]+\.\d{2})/i,
  /** "Visa ending in 0000: November 19, 2026: $25.41" (invoice page). */
  chargeOnInvoice: /ending in\s*(\d{4})\s*:\s*([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\s*:\s*(\$\s*[\d,]+\.\d{2})/i,
  refundText: /refund|credit(?:ed)? to|returned/i,
  /** "We're unable to load your order details": Amazon refused this page for now. */
  unavailable: ['[data-component="errorbanner"] .a-alert-heading', "#orderDetails .a-alert-error .a-alert-heading"],
  cancelledText: /this order (?:has been|was) cancel|order cancell?ed/i,
};

export const PRODUCT = {
  /** The category trail above the product title: "Grocery & Gourmet Food › Produce › Potatoes". */
  breadcrumb: ["#wayfinding-breadcrumbs_feature_div ul li a", "#wayfinding-breadcrumbs_container ul li a", "#wayfinding-breadcrumbs_feature_div a", ".a-breadcrumb li a"],
  /** Fallback: the store name in the bar under the search box ("Grocery & Gourmet Food"). */
  storeName: ["#nav-subnav a.nav-b .nav-a-content", "#nav-subnav .nav-b", "#nav-subnav a:first-child"],
  /** Store names that aren't a category. */
  notCategory: /^(amazon\.com|all|departments?|deals|today'?s deals|back to results|see all)$/i,
};

export const BLOCKED = {
  signinUrl: /\/ap\/(?:signin|mfa|cvf)|\/ax\/claim/,
  signin: ['form[name="signIn"]', "#ap_email", "#ap_password", 'form[action*="/ap/signin"]'],
  captchaUrl: /validateCaptcha|\/errors\/|captcha/i,
  captcha: ['form[action*="validateCaptcha"]', "#captchacharacters", 'img[src*="captcha"]'],
  captchaText: /enter the characters you see|type the characters|solve this puzzle|verify (?:that )?you(?:'re| are) (?:a )?human/i,
};

/** Labels kept when a page outline is made for troubleshooting; every other word is masked. */
export const OUTLINE_WORDS = [
  "order", "orders", "placed", "ordered", "on", "total", "subtotal", "grand", "items", "item", "ship", "shipped", "to", "delivered",
  "arriving", "transactions", "transaction", "ending", "in", "qty", "quantity", "price", "refund", "payment", "method", "invoice",
  "details", "summary", "tax", "shipping", "handling", "before", "estimated", "next", "previous", "sold", "by", "return", "buy",
  "it", "again", "view", "your", "item", "track", "package", "credit", "card", "gift", "promotion", "applied",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
];
