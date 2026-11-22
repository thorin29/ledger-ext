import type { RunCounts } from "./types";

/**
 * The last sync in a few short lines, zeros left out:
 *   "Unsplit 25 · Found 18 · Still missing 7"
 *   "Orders read 30 · No charge list 4 · Skipped 3 (digital 2, cancelled 1)"
 *   "Split 18 · Categories 58/61 · Read in a tab"
 */
export function countLines(c: RunCounts | undefined): string[] {
  if (!c) return [];
  const parts = (pairs: Array<[string, number]>) => pairs.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`);
  const lines: string[] = [];
  const unsplit = c.unsplit ?? -1;
  if (unsplit === 0) lines.push("Nothing left to split");
  else if (unsplit > 0) lines.push([`Unsplit ${unsplit}`, `Found ${c.found ?? 0}`, ...parts([["Still missing", unsplit - (c.found ?? 0)]])].join(" · "));
  if (unsplit !== 0) {
    const skipped = parts([["digital", c.digital], ["cancelled", c.cancelled], ["unreadable", c.unreadable]]);
    const skipTotal = c.digital + c.cancelled + c.unreadable;
    lines.push(
      [`Orders read ${c.read}`, ...parts([["Done before", c.finished], ["No charge list", c.noChargeList]]), ...(skipTotal ? [`Skipped ${skipTotal} (${skipped.join(", ")})`] : [])].join(" · "),
    );
    lines.push(
      [`Split ${c.split}`, ...parts([["Waiting", c.waiting], ["No match", c.noMatch]]), ...(c.items ? [`Categories ${c.categorized}/${c.items}`] : []), ...(c.usedTab ? ["Read in a tab"] : [])].join(" · "),
    );
  }
  return lines;
}
