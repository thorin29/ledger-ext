/**
 * Everything the extension keeps, in chrome.storage.local. No order data: only the Ledger
 * address, the device token, and enough about the last sync to show it and to know where the
 * next one starts.
 */

import type { LocalProblem, Section, SyncStatus } from "./types";

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
}

const KEYS: Array<keyof Saved> = [
  "ledger", "token", "tokenExpiresAt", "autoSync", "accent", "lastRunAt", "lastStatus", "failedSection", "localProblem",
  "waitingSince", "ordersWaiting", "chargesSplitThisMonth", "syncedThrough", "syncFrom", "running",
];

export async function load(): Promise<Saved> {
  return (await chrome.storage.local.get(KEYS)) as Saved;
}

export async function save(patch: Partial<Saved>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Disconnect: forget the token and the sync history, keep the address and look. */
export async function forget(): Promise<void> {
  await chrome.storage.local.remove(KEYS.filter((k) => k !== "ledger" && k !== "accent" && k !== "autoSync"));
}
