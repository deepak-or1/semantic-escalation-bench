import { describe, expect, it } from "vitest";
import { ChaosParamsSchema, validateChaosConfig, validateChaosParamsCompat } from "./chaosParams";

const FULL_ORDER = ["P", "W", "D", "L", "GF", "GA", "GD", "Pts", "Form"];

describe("ChaosParamsSchema (§3 perturbation parameters)", () => {
  it("parses a valid full parameter set", () => {
    const p = ChaosParamsSchema.parse({
      classDriftLevel: 3,
      decoyLevel: 2,
      decoyCopy: { "next-page": "Older", "reveal-table": "Everything" },
      decoyPlacement: "after",
      pageSize: 2,
      headerVocab: { points: "Pnts", team: "Club" },
      uiCopy: { nextButton: "Onward", fullTableTab: "Everything" },
      columnOrder: ["Pts", "P", "W", "D", "L", "GF", "GA", "GD", "Form"],
      layoutCondition: "cards",
      delayRangeMs: [100, 500],
      networkDelayRangeMs: [0, 250]
    });
    expect(p.classDriftLevel).toBe(3);
    expect(p.decoyPlacement).toBe("after");
    expect(p.columnOrder).toHaveLength(9);
    expect(p.delayRangeMs).toEqual([100, 500]);
  });

  it("accepts an empty object (every field is optional)", () => {
    expect(ChaosParamsSchema.parse({})).toEqual({});
  });

  it("rejects out-of-range levels and page sizes", () => {
    expect(ChaosParamsSchema.safeParse({ classDriftLevel: 5 }).success).toBe(false);
    expect(ChaosParamsSchema.safeParse({ classDriftLevel: -1 }).success).toBe(false);
    expect(ChaosParamsSchema.safeParse({ decoyLevel: 4 }).success).toBe(false);
    expect(ChaosParamsSchema.safeParse({ pageSize: 1 }).success).toBe(false);
    expect(ChaosParamsSchema.safeParse({ pageSize: 11 }).success).toBe(false);
  });

  it("rejects unknown copy keys, column keys, and decoy controls", () => {
    expect(ChaosParamsSchema.safeParse({ uiCopy: { bogus: "x" } }).success).toBe(false);
    expect(ChaosParamsSchema.safeParse({ columnOrder: ["ZZ"] }).success).toBe(false);
    expect(ChaosParamsSchema.safeParse({ decoyCopy: { modal: "x" } }).success).toBe(false);
    expect(ChaosParamsSchema.safeParse({ decoyPlacement: "middle" }).success).toBe(false);
    expect(ChaosParamsSchema.safeParse({ layoutCondition: "grid" }).success).toBe(false);
  });
});

describe("validateChaosParamsCompat (§3 flag-XOR-param precedence)", () => {
  it("flags each contradictory flag+param pair for the same surface", () => {
    expect(validateChaosParamsCompat(["columnShuffle"], { columnOrder: FULL_ORDER as never })).toHaveLength(1);
    expect(validateChaosParamsCompat(["copyDrift"], { uiCopy: { nextButton: "x" } })).toHaveLength(1);
    expect(validateChaosParamsCompat(["classDrift"], { classDriftLevel: 2 })).toHaveLength(1);
    expect(validateChaosParamsCompat(["layoutVariant"], { layoutCondition: "cards" })).toHaveLength(1);
    expect(validateChaosParamsCompat(["pagination"], { pageSize: 3 })).toHaveLength(1);
  });

  it("returns no error when a flag and a param are used separately (or unrelated)", () => {
    expect(validateChaosParamsCompat(["columnShuffle"], {})).toEqual([]);
    expect(validateChaosParamsCompat([], { columnOrder: FULL_ORDER as never })).toEqual([]);
    // pagination flag with an UNRELATED param (classDriftLevel) is fine.
    expect(validateChaosParamsCompat(["pagination"], { classDriftLevel: 1 })).toEqual([]);
  });

  it("accumulates every contradiction across multiple surfaces", () => {
    const errors = validateChaosParamsCompat(
      ["classDrift", "pagination"],
      { classDriftLevel: 1, pageSize: 2 }
    );
    expect(errors).toHaveLength(2);
  });

  it("names the offending flag and param in the error text", () => {
    const [msg] = validateChaosParamsCompat(["pagination"], { pageSize: 2 });
    expect(msg).toContain("pagination");
    expect(msg).toContain("pageSize");
  });
});

describe("validateChaosConfig (§3 full config validator — single source)", () => {
  it("is a superset of validateChaosParamsCompat (the XOR pairs still fire)", () => {
    expect(validateChaosConfig(["pagination"], { pageSize: 3 }).some((s) => s.includes("mutually exclusive"))).toBe(true);
  });

  it("flags a non-permutation columnOrder (duplicate + missing key)", () => {
    const bad = ["P", "P", "W", "D", "L", "GF", "GA", "GD", "Form"] as never; // dup P, no Pts
    expect(validateChaosConfig([], { columnOrder: bad }).some((s) => s.includes("permutation"))).toBe(true);
  });

  it("flags a decoy without its pagination scaffold, and decoy composed with a layout", () => {
    expect(validateChaosConfig([], { decoyLevel: 1 }).some((s) => s.includes("next-page"))).toBe(true);
    expect(
      validateChaosConfig(["pagination"], { decoyLevel: 1, layoutCondition: "cards" }).some((s) =>
        s.includes("Layout suppresses pagination")
      )
    ).toBe(true);
  });

  it("flags a decoyLevel 2 missing the hiddenTab scaffold", () => {
    expect(validateChaosConfig(["pagination"], { decoyLevel: 2 }).some((s) => s.includes("hiddenTab"))).toBe(true);
  });

  it("flags timing params missing their flags and inverted ranges", () => {
    expect(validateChaosConfig([], { delayRangeMs: [100, 200] }).some((s) => s.includes("delayedRender"))).toBe(true);
    expect(validateChaosConfig(["delayedRender"], { delayRangeMs: [500, 100] }).some((s) => s.includes("inverted"))).toBe(true);
  });

  it("returns [] for an admissible config (decoy with its full scaffold)", () => {
    expect(validateChaosConfig(["pagination", "hiddenTab"], { decoyLevel: 2 })).toEqual([]);
  });
});
