import { describe, expect, it } from "vitest";
import {
  americanToDecimal,
  decimalToAmerican,
  overround,
  parseOddsValue,
  removeVig
} from "./odds";

describe("americanToDecimal", () => {
  it("converts +120 to exactly 2.2", () => {
    expect(americanToDecimal(120)).toBe(2.2);
  });

  it("converts -145 to ~1.68966", () => {
    expect(americanToDecimal(-145)).toBeCloseTo(1.68966, 4);
  });

  it("throws on |odds| < 100", () => {
    expect(() => americanToDecimal(50)).toThrow();
  });
});

describe("decimalToAmerican", () => {
  it("converts 2.2 to 120", () => {
    expect(decimalToAmerican(2.2)).toBe(120);
  });

  it("converts 1.6897 to -145", () => {
    expect(decimalToAmerican(1.6897)).toBe(-145);
  });

  it("throws on decimal 1.0", () => {
    expect(() => decimalToAmerican(1.0)).toThrow();
  });

  it("throws on decimal 0", () => {
    expect(() => decimalToAmerican(0)).toThrow();
  });
});

describe("decimal -> american -> decimal round-trip", () => {
  it("stays within 0.011 across a spread of odds", () => {
    for (const decimal of [1.2, 1.29, 1.5, 1.91, 2.0, 2.5, 3.75, 10]) {
      const back = americanToDecimal(decimalToAmerican(decimal));
      expect(Math.abs(back - decimal)).toBeLessThanOrEqual(0.011);
    }
  });
});

describe("parseOddsValue", () => {
  it("parses '1.85' as decimal", () => {
    expect(parseOddsValue("1.85")).toEqual({ decimal: 1.85, format: "decimal" });
  });

  it("parses '2' as decimal 2", () => {
    expect(parseOddsValue("2")).toEqual({ decimal: 2, format: "decimal" });
  });

  it("parses '+120' as american decimal 2.2", () => {
    expect(parseOddsValue("+120")).toEqual({ decimal: 2.2, format: "american" });
  });

  it("parses '-105' as american ~1.95238", () => {
    const result = parseOddsValue("-105");
    expect(result?.format).toBe("american");
    expect(result?.decimal).toBeCloseTo(1.95238, 4);
  });

  it.each([
    ["—", "em-dash"],
    ["N/A", "not available"],
    ["abc", "letters"],
    ["0.62", "decimal <= 1"],
    ["+50", "american |odds| < 100"],
    ["1001", "decimal > 1000"]
  ])("returns null for %s (%s)", (raw) => {
    expect(parseOddsValue(raw)).toBeNull();
  });
});

describe("removeVig / overround", () => {
  it("removeVig output sums to 1", () => {
    const normalized = removeVig([0.5, 0.3, 0.25]);
    expect(normalized.reduce((a, p) => a + p, 0)).toBeCloseTo(1, 10);
  });

  it("overround([0.5, 0.3, 0.25]) ~ 0.05", () => {
    expect(overround([0.5, 0.3, 0.25])).toBeCloseTo(0.05, 10);
  });
});
