/**
 * Everything the extension keeps, in chrome.storage.local. No order data: the Ledger address,
 * the device token, the last sync's counts, a cache of product categories (product data, not
 * orders), and salted hashes of finished orders so their pages aren't read again.
 */

import type { LocalProblem, RunCounts, Section, SyncStatus } from "./types";

export interface Saved {
  ledger?: string;
  token?: string;
  tokenExpiresAt?: string;
  autoSync?: boolean;
  accent?: string;
  lastRunAt?: string;
  lastStatus?: SyncStatus;
  failedSection?: Section | null;
  localProblem?: LocalProblem | null;
  /** The oldest order still waiting for its bank charge (YYYY-MM-DD). */
  waitingSince?: string | null;
  ordersWaiting?: number;
  chargesSplitThisMonth?: number;
  syncedThrough?: string | null;
  syncFrom?: string | null;
  running?: boolean;
  runStartedAt?: string;
  ledgerFrom?: string | null;
  lastCounts?: RunCounts;
}

const KEYS: Array<keyof Saved> = [
  "ledger", "token", "tokenExpiresAt", "autoSync", "accent", "lastRunAt", "lastStatus", "failedSection", "localProblem",
  "waitingSince", "ordersWaiting", "chargesSplitThisMonth", "syncedThrough", "syncFrom", "running", "runStartedAt", "lastCounts", "ledgerFrom",
];

export async function load(): Promise<Saved> {
  return (await chrome.storage.local.get(KEYS)) as Saved;
}

export async function save(patch: Partial<Saved>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Disconnect: forget the token and the sync history, keep the address and look. */
export async function forget(): Promise<void> {
  await chrome.storage.local.remove([...KEYS.filter((k) => k !== "ledger" && k !== "accent" && k !== "autoSync"), FINISHED, SALT]);
}

// ---------- Product categories (product data, not orders) ----------

const CATEGORIES = "categories";
const DAY = 86_400_000;
const CATEGORY_MAX = 2000;
const CATEGORY_DAYS = 180;
/** A product page without a category is asked again sooner. */
const NONE_DAYS = 30;

type CategoryCache = Record<string, { c: string | null; t: number }>;

export async function cachedCategory(productId: string, now = Date.now()): Promise<{ hit: boolean; category: string | null }> {
  const cache = ((await chrome.storage.local.get(CATEGORIES))[CATEGORIES] ?? {}) as CategoryCache;
  const e = cache[productId];
  if (!e) return { hit: false, category: null };
  const days = (now / DAY) - e.t;
  return days <= (e.c ? CATEGORY_DAYS : NONE_DAYS) ? { hit: true, category: e.c } : { hit: false, category: null };
}

export async function saveCategory(productId: string, category: string | null, now = Date.now()): Promise<void> {
  const cache = ((await chrome.storage.local.get(CATEGORIES))[CATEGORIES] ?? {}) as CategoryCache;
  cache[productId] = { c: category, t: Math.floor(now / DAY) };
  const today = now / DAY;
  let entries = Object.entries(cache).filter(([, e]) => today - e.t <= CATEGORY_DAYS);
  if (entries.length > CATEGORY_MAX) entries = entries.sort((a, b) => b[1].t - a[1].t).slice(0, CATEGORY_MAX);
  await chrome.storage.local.set({ [CATEGORIES]: Object.fromEntries(entries) });
}

// ---------- Finished orders (salted hashes only) ----------

const FINISHED = "finished";
const SALT = "salt";
const FINISHED_MAX = 1500;
const FINISHED_DAYS = 180;

async function salt(): Promise<string> {
  const got = (await chrome.storage.local.get(SALT))[SALT] as string | undefined;
  if (got) return got;
  const fresh = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await chrome.storage.local.set({ [SALT]: fresh });
  return fresh;
}

async function hash(orderId: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${await salt()}:${orderId}`));
  return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isFinished(orderId: string): Promise<boolean> {
  const set = ((await chrome.storage.local.get(FINISHED))[FINISHED] ?? {}) as Record<string, number>;
  return (await hash(orderId)) in set;
}

export async function markFinished(orderIds: string[], now = Date.now()): Promise<void> {
  const set = ((await chrome.storage.local.get(FINISHED))[FINISHED] ?? {}) as Record<string, number>;
  const today = Math.floor(now / DAY);
  for (const id of orderIds) set[await hash(id)] = today;
  let entries = Object.entries(set).filter(([, t]) => today - t <= FINISHED_DAYS);
  if (entries.length > FINISHED_MAX) entries = entries.sort((a, b) => b[1] - a[1]).slice(0, FINISHED_MAX);
  await chrome.storage.local.set({ [FINISHED]: Object.fromEntries(entries) });
}

/** After Ledger's Amazon splits are removed, every order needs reading again. */
export async function clearFinished(): Promise<void> {
  await chrome.storage.local.remove(FINISHED);
}
