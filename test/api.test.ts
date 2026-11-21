import { normalizeAddress, originPattern } from "../src/ledger/api";

describe("Ledger address", () => {
  it("adds https and trims slashes", () => {
    expect(normalizeAddress("ledger.example.com/")).toBe("https://ledger.example.com");
    expect(normalizeAddress(" https://example.com/ledger/ ")).toBe("https://example.com/ledger");
    expect(originPattern("https://example.com/ledger")).toBe("https://example.com/*");
  });

  it("refuses http and addresses with a username", () => {
    expect(() => normalizeAddress("http://ledger.example.com")).toThrow(/https/);
    expect(() => normalizeAddress("https://me:pw@ledger.example.com")).toThrow();
  });
});
