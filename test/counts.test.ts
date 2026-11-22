import { countLines } from "../src/counts";
import { emptyCounts } from "../src/sync";

describe("count lines", () => {
  it("shows what was missing, what was read and what was split, zeros left out", () => {
    const c = { ...emptyCounts(), unsplit: 25, found: 18, read: 30, noChargeList: 4, digital: 2, cancelled: 1, split: 18, items: 61, categorized: 58, usedTab: 1 };
    expect(countLines(c)).toEqual([
      "Unsplit 25 · Found 18 · Still missing 7",
      "Orders read 30 · No charge list 4 · Skipped 3 (digital 2, cancelled 1)",
      "Split 18 · Categories 58/61 · Read in a tab",
    ]);
  });

  it("keeps it to one line when nothing is left", () => {
    expect(countLines({ ...emptyCounts(), unsplit: 0 })).toEqual(["Nothing left to split"]);
    expect(countLines(undefined)).toEqual([]);
  });
});
