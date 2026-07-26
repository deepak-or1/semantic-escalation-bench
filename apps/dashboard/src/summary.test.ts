import { describe, expect, it } from "vitest";
import type { EngineName, TrialResult } from "@ssda/shared";
import { summarizeEngines } from "./summary";

/**
 * summarizeEngines reads a trial list the schema has already validated, so the
 * fixtures below are full TrialResults with only the fields under test varied.
 */
function trial(engine: EngineName, overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    scenarioId: "s-a",
    engine,
    trial: 1,
    runId: "bench-x",
    outcome: "pass",
    outcomeReason: "ok",
    outcomeClass: "pass",
    pipelineSuccess: true,
    extractionSuccess: true,
    validationSuccess: true,
    accuracy: null,
    durationMs: 1200,
    retries: 0,
    recoveredAfterFailure: false,
    artifactsDir: "/runs/bench-x/trials/t-1",
    ...overrides
  };
}

describe("summarizeEngines", () => {
  it("returns no rows for an empty trial list", () => {
    expect(summarizeEngines([])).toEqual([]);
  });

  it("emits one row per engine, in first-appearance order", () => {
    const rows = summarizeEngines([
      trial("hybrid"),
      trial("baseline"),
      trial("hybrid"),
      trial("stagehand"),
      trial("baseline")
    ]);
    expect(rows.map((r) => r.engine)).toEqual(["hybrid", "baseline", "stagehand"]);
    expect(rows.map((r) => r.trials)).toEqual([2, 2, 1]);
  });

  it("counts passes per engine, ignoring the trials judged fail", () => {
    const rows = summarizeEngines([
      trial("hybrid"),
      trial("hybrid", { outcome: "fail", outcomeClass: "hard-failure" }),
      trial("hybrid"),
      trial("baseline", { outcome: "fail", outcomeClass: "hard-failure" })
    ]);
    expect(rows[0]).toMatchObject({ engine: "hybrid", trials: 3, passes: 2 });
    expect(rows[1]).toMatchObject({ engine: "baseline", trials: 1, passes: 0 });
  });

  it("sums llmCalls, treating an absent or null tokens object as zero", () => {
    const rows = summarizeEngines([
      trial("hybrid", { tokens: { llmCalls: 4 } }),
      trial("hybrid", { tokens: null }),
      trial("hybrid"),
      trial("hybrid", { tokens: { llmCalls: 6, inputTokens: 100, outputTokens: 20 } }),
      trial("baseline", { tokens: null })
    ]);
    expect(rows[0]?.llmCalls).toBe(10);
    expect(rows[1]?.llmCalls).toBe(0);
  });

  it("sums retries per engine", () => {
    const rows = summarizeEngines([
      trial("hybrid", { retries: 2 }),
      trial("hybrid"),
      trial("hybrid", { retries: 1 }),
      trial("baseline", { retries: 3 })
    ]);
    expect(rows[0]?.retries).toBe(3);
    expect(rows[1]?.retries).toBe(3);
  });

  it("counts scripted recoveries as deterministic repairs, never as semantic", () => {
    const fallbackOnly = summarizeEngines([
      trial("stagehand", { deterministicFallbacks: ["dismiss-banner"] })
    ]);
    expect(fallbackOnly[0]).toMatchObject({ semanticInterventions: 0, deterministicRepairs: 1 });

    const repairOnly = summarizeEngines([
      trial("hybrid", { deterministicRepairSteps: ["reveal-table"] })
    ]);
    expect(repairOnly[0]).toMatchObject({ semanticInterventions: 0, deterministicRepairs: 1 });
  });

  it("counts each trial at most once per column, and skips trials with no repair evidence", () => {
    const rows = summarizeEngines([
      trial("hybrid", { healedSteps: ["login"] }),
      trial("hybrid", { healedSteps: ["login"], deterministicRepairSteps: ["reveal-table"] }),
      trial("hybrid", { healedSteps: [], deterministicFallbacks: [], deterministicRepairSteps: [] }),
      trial("hybrid"),
      trial("baseline")
    ]);
    expect(rows[0]).toMatchObject({
      engine: "hybrid",
      trials: 4,
      semanticInterventions: 2,
      deterministicRepairs: 1
    });
    expect(rows[1]).toMatchObject({ semanticInterventions: 0, deterministicRepairs: 0 });
  });
});
