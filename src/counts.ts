import type { RunCounts } from "./types";

/** "Orders 42 · Sent 30 · Skipped 12 (digital 9, cancelled 3)" and "Split 13 · No match 2 · …", zeros left out. */
export function countLines(c: RunCounts | undefined): [string, string] {
  if (!c) return ["", ""];
  const parts = (pairs: Array<[string, number]>) => pairs.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`);
  const skipped = parts([["digital", c.digital], ["cancelled", c.cancelled], ["unreadable", c.unreadable]]);
  const skipTotal = c.digital + c.cancelled + c.unreadable;
  const first = [`Orders ${c.listed}`, `Sent ${c.sent}`, ...parts([["Done before", c.finished]]), ...(skipTotal ? [`Skipped ${skipTotal} (${skipped.join(", ")})`] : [])];
  const second = [`Split ${c.split}`, ...parts([["Waiting", c.waiting], ["No match", c.noMatch], ["No charge list", c.noChargeList]]), ...(c.items ? [`Categories ${c.categorized}/${c.items}`] : [])];
  return [first.join(" · "), second.join(" · ")];
}
