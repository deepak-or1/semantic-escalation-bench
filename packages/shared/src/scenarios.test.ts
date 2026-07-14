import { describe, expect, it } from "vitest";
import { CHAOS_FLAGS } from "./chaos";
import { SCENARIOS } from "./scenarios";
import { ScenarioSpecSchema } from "./schemas/benchmark";

describe("SCENARIOS catalog", () => {
  it("has 24 scenarios that all parse", () => {
    expect(SCENARIOS).toHaveLength(24);
    for (const scenario of SCENARIOS) {
      expect(ScenarioSpecSchema.safeParse(scenario).success).toBe(true);
    }
  });

  it("splits into 17 core / 4 compound / 3 survival groups", () => {
    const counts = SCENARIOS.reduce<Record<string, number>>((acc, s) => {
      acc[s.group] = (acc[s.group] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ core: 17, compound: 4, survival: 3 });
  });

  it("defaults the original core scenarios to group 'core'", () => {
    expect(SCENARIOS.find((s) => s.id === "clean-extraction")?.group).toBe("core");
    expect(SCENARIOS.find((s) => s.id === "site-v2")?.group).toBe("survival");
    expect(SCENARIOS.find((s) => s.id === "compound-session-churn")?.group).toBe(
      "compound"
    );
  });

  it("has unique ids", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique seeds", () => {
    const seeds = SCENARIOS.map((s) => s.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it("exercises exactly the full set of CHAOS_FLAGS across its chaos arrays", () => {
    const union = new Set(SCENARIOS.flatMap((s) => s.chaos));
    expect(union).toEqual(new Set(CHAOS_FLAGS));
  });

  it("covers the fresh, reuse and expired session modes", () => {
    const modes = new Set(SCENARIOS.map((s) => s.session));
    expect(modes.has("fresh")).toBe(true);
    expect(modes.has("reuse")).toBe(true);
    expect(modes.has("expired")).toBe(true);
  });

  it("covers all three expected outcomes", () => {
    const outcomes = new Set(SCENARIOS.map((s) => s.expected));
    expect(outcomes).toEqual(
      new Set(["success", "validation-failure", "success-with-warnings"])
    );
  });
});
