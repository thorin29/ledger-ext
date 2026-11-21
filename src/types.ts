/** What one order sends to Ledger. Nothing else from Amazon is read or kept. */
export interface SyncItem {
  name: string;
  /** One unit's price in cents, before tax and shipping. */
  cents: number;
  quantity: number;
  /** Which shipment on the order page the item was in ("1", "2", …). */
  shipmentKey: string;
  shipDate: string | null;
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
export type LocalProblem = "ledger_unreachable" | "reconnect";

/** Which part of a page couldn't be read. Sent to Ledger as a code, never page content. */
export type Section = "orders_list" | "order_date" | "order_items" | "order_charges";

export interface ListPage {
  orders: Array<{ orderId: string; orderDate: string | null }>;
  nextUrl: string | null;
}

export type Blocked = "signin" | "captcha" | null;
