/**
 * The person's own Ledger server, over HTTPS only. Every call carries the device token as a
 * Bearer header and never a cookie, so the browser's Ledger or proxy sign-in is never sent.
 */

import type { SyncOrder, SyncStatus, UnsplitCharge } from "../types";

const TIMEOUT_MS = 20_000;

export class LedgerError extends Error {
  constructor(
    readonly kind: "unreachable" | "signed_out" | "refused" | "server",
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** "ledger.example.com" or "https://ledger.example.com/" → "https://ledger.example.com". Refuses http. */
export function normalizeAddress(raw: string): string {
  let text = raw.trim();
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new LedgerError("refused", "bad_address", "That doesn't look like an address");
  }
  if (url.protocol !== "https:") throw new LedgerError("refused", "not_https", "Ledger's address must start with https://");
  if (url.username || url.password) throw new LedgerError("refused", "bad_address", "Leave the username out of the address");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** The pattern Chrome's optional host permission needs for this address. */
export const originPattern = (base: string) => `${new URL(base).origin}/*`;

async function call<T>(base: string, path: string, init: { method?: string; token?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new LedgerError("unreachable", "unreachable", "Ledger can't be reached");
  }
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (res.ok) return data as T;
  const code = data?.error?.code ?? `http_${res.status}`;
  const message = data?.error?.message ?? `Ledger answered ${res.status}`;
  if (res.status === 401) throw new LedgerError("signed_out", code, message, 401);
  if (res.status >= 500) throw new LedgerError("server", code, message, res.status);
  throw new LedgerError("refused", code, message, res.status);
}

export interface Enrolled {
  token: string;
  expiresAt: string;
}

/** Password → proof → token. The password is sent once and not kept. */
export async function connect(base: string, username: string, password: string, code: string, name: string): Promise<Enrolled> {
  const { proof } = await call<{ proof: string }>(base, "/api/v1/auth/login", { method: "POST", body: { username, password } });
  const out = await call<Enrolled & { device: { scope?: string } }>(base, "/api/v1/auth/enroll", {
    method: "POST",
    body: { proof, code, name, scope: "amazon" },
  });
  if (out.device?.scope !== "amazon") throw new LedgerError("refused", "old_ledger", "Update Ledger to 0.106.0 or later first");
  return { token: out.token, expiresAt: out.expiresAt };
}

export const refresh = (base: string, token: string) => call<Enrolled>(base, "/api/v1/auth/refresh", { method: "POST", token });

export const logout = (base: string, token: string) => call<unknown>(base, "/api/v1/auth/logout", { method: "POST", token });

export interface Status {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: SyncStatus | null;
  chargesSplitThisMonth: number;
  ordersWaiting: number;
  syncFrom: string;
}

export const status = (base: string, token: string) => call<Status>(base, "/api/v1/amazon/status", { token });

/** Ledger 0.110.0 and later; null on an older Ledger. */
export async function unsplit(base: string, token: string): Promise<UnsplitCharge[] | null> {
  try {
    return (await call<{ charges: UnsplitCharge[] }>(base, "/api/v1/amazon/unsplit", { token })).charges;
  } catch (e) {
    if (e instanceof LedgerError && e.status === 404) return null;
    throw e;
  }
}

export interface OrdersResult {
  matched: number;
  split: number;
  waiting: number;
  waitingSince: string | null;
  /** Ledger 0.108.0 and later. */
  noMatch?: number;
  noChargeList?: number;
  /** Positions in the batch of orders whose charges are all found. */
  done?: number[];
}

export const sendOrders = (base: string, token: string, orders: SyncOrder[], key: string) =>
  call<OrdersResult>(base, "/api/v1/amazon/orders", { method: "POST", token, body: { orders }, idempotencyKey: key });

export const reportRun = (
  base: string,
  token: string,
  report: { status: SyncStatus; failedSection: string | null; extensionVersion: string; ordersWaiting: number },
  key: string,
) => call<unknown>(base, "/api/v1/amazon/runs", { method: "POST", token, body: report, idempotencyKey: key });
