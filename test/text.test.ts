import { cents, fullDate, shortDate } from "../src/amazon/text";

describe("Amazon text", () => {
  it("reads full and short dates", () => {
    expect(fullDate("Ordered on November 19, 2026")).toBe("2026-11-19");
    expect(fullDate("Sept 3, 2026")).toBe("2026-09-03");
    expect(shortDate("Delivered January 4", "2026-12-28")).toBe("2027-01-04");
    expect(shortDate("Delivered March 3", "2026-03-01")).toBe("2026-03-03");
  });

  it("reads dollar amounts", () => {
    expect(cents("$1,234.56")).toBe(123456);
    expect(cents("$7")).toBe(700);
    expect(cents("none")).toBeNull();
  });
});
