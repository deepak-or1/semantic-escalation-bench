import { describe, expect, it } from "vitest";
import { poissonCdf, poissonPmf } from "./poisson";

describe("poissonPmf", () => {
  it("matches hand-computed values", () => {
    // e^-1.5 exactly.
    expect(Math.abs(poissonPmf(1.5, 0) - 0.223130)).toBeLessThan(1e-5);
    // e^-2.3 * 2.3^3 / 3! — the spec's log-space formula (its stated 0.201681
    // is arithmetically wrong; the true Poisson value is 0.2033082).
    expect(Math.abs(poissonPmf(2.3, 3) - 0.2033082)).toBeLessThan(1e-5);
  });

  it("is a proper distribution (sums to ~1 over its support)", () => {
    let sum = 0;
    for (let k = 0; k <= 30; k++) sum += poissonPmf(2.7, k);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it("returns 0 for negative or non-integer k", () => {
    expect(poissonPmf(2, -1)).toBe(0);
    expect(poissonPmf(2, 1.5)).toBe(0);
  });

  it("handles a degenerate lambda of 0", () => {
    expect(poissonPmf(0, 0)).toBe(1);
    expect(poissonPmf(0, 3)).toBe(0);
  });
});

describe("poissonCdf", () => {
  it("is monotone non-decreasing and approaches 1", () => {
    let prev = -Infinity;
    for (let k = 0; k <= 20; k++) {
      const c = poissonCdf(1.5, k);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
    expect(Math.abs(poissonCdf(1.5, 40) - 1)).toBeLessThan(1e-9);
  });

  it("equals the pmf sum up to k", () => {
    const manual = poissonPmf(3.1, 0) + poissonPmf(3.1, 1) + poissonPmf(3.1, 2);
    expect(poissonCdf(3.1, 2)).toBeCloseTo(manual, 12);
  });
});
