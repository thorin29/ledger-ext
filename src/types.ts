/** What one order sends to Ledger. Nothing else from Amazon is read or kept. */
export interface SyncItem {
  name: string;
  /** One unit's price in cents, before tax and shipping. */
  cents: number;
  quantity: number;
  /** Which shipment on the order page the item was in ("1", "2", …). */
  shipmentKey: string;
  shipDate: string | null;
  /** Amazon's product id (ASIN), from the item's link. */
  productId?: string | null;
  /** Amazon's category path from the product page, "Grocery & Gourmet Food › Produce". */
  category?: string | null;
}

export interface SyncCharge {
  /** YYYY-MM-DD */
  date: string;
  cents: number;
  last4: string | null;
}

export interface SyncOrder {
  orderId: string;
  orderDate: string;
  items: SyncItem[];
  charges: SyncCharge[];
}

/** How a sync ended; the same codes Ledger keeps. */
export type SyncStatus = "ok" | "amazon_signed_out" | "captcha" | "parse_failed" | "ledger_error";

/** Problems only the extension sees (Ledger can't be told about these). */
export type LocalProblem = "ledger_unreachable" | "reconnect" | "tab_closed" | "amazon_error";

/** Which part of a page couldn't be read. Sent to Ledger as a code, never page content. */
export type Section = "orders_list" | "order_date" | "order_items" | "order_charges" | "order_unavailable";

/** What the last sync did, shown in the popup. Counts only. */
export interface RunCounts {
  /** Orders in the date range on Your Orders. */
  listed: number;
  /** Already finished last time, so their pages weren't read again. */
  finished: number;
  read: number;
  sent: number;
  digital: number;
  cancelled: number;
  unreadable: number;
  split: number;
  waiting: number;
  noMatch: number;
  noChargeList: number;
  /** Items sent, and how many had Amazon's category. */
  items: number;
  categorized: number;
}

export interface ListPage {
  orders: Array<{ orderId: string; orderDate: string | null }>;
  nextUrl: string | null;
}

export type Blocked = "signin" | "captcha" | null;
