import { countLines } from "../src/counts";
import { emptyCounts } from "../src/sync";

describe("count lines", () => {
  it("leaves zeros out", () => {
    const c = { ...emptyCounts(), listed: 42, sent: 30, digital: 9, cancelled: 3, split: 13, noChargeList: 3, items: 30, categorized: 28 };
    expect(countLines(c)).toEqual(["Orders 42 · Sent 30 · Skipped 12 (digital 9, cancelled 3)", "Split 13 · No charge list 3 · Categories 28/30"]);
    expect(countLines(undefined)).toEqual(["", ""]);
  });
});
