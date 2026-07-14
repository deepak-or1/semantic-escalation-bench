import { describe, expect, it } from "vitest";
import { devig, downgradeConfidence, expectedValuePerUnit } from "./value";

describe("expectedValuePerUnit", () => {
  it("computes profit expectation of a 1-unit stake", () => {
    // 0.5 * (2.2 - 1) - 0.5 = 0.10.
    expect(expectedValuePerUnit(0.5, 2.2)).toBeCloseTo(0.1, 9);
  });

  it("is exactly zero at fair odds", () => {
    expect(expectedValuePerUnit(0.5, 2.0)).toBeCloseTo(0, 12);
  });
});

describe("devig", () => {
  it("removes the margin so a trio sums to 1", () => {
    const nv = devig([2.0, 3.5, 4.0]);
    expect(nv).toHaveLength(3);
    expect(nv.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    // Ordering is preserved: shortest odds -> highest no-vig probability.
    expect(nv[0]).toBeGreaterThan(nv[1] as number);
  });

  it("removes the margin so an over/under pair sums to 1", () => {
    const nv = devig([1.9, 1.95]);
    expect(nv.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
});

describe("downgradeConfidence", () => {
  it("steps down one rung and floors at low", () => {
    expect(downgradeConfidence("high")).toBe("medium");
    expect(downgradeConfidence("medium")).toBe("low");
    expect(downgradeConfidence("low")).toBe("low");
  });
});
