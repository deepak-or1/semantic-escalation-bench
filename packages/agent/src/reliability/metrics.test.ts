import type { AccuracyReport, PipelineResult, ScenarioSpec, TrialResult } from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { buildComparison, classifyOutcome, summarizeEngine } from "./metrics";
import { judge } from "./runner";

function trial(overrides: Partial<TrialResult>): TrialResult {
  return {
    scenarioId: "clean-extraction",
    engine: "baseline",
    trial: 1,
    runId: "clean-extraction-baseline-t1",
    outcome: "pass",
    outcomeReason: "success",
    outcomeClass: "pass",
    pipelineSuccess: true,
    extractionSuccess: true,
    validationSuccess: true,
    accuracy: { overall: 1 },
    durationMs: 100,
    retries: 0,
    recoveredAfterFailure: false,
    artifactsDir: "runs/x",
    tokens: null,
    ...overrides
  };
}

function scenario(id: string): ScenarioSpec {
  return {
    id,
    name: id,
    description: id,
    chaos: [],
    seed: 1,
    session: "fresh",
    expected: "success",
    group: "core"
  };
}

describe("summarizeEngine", () => {
  it("returns all-null rates for a skipped engine with 0 trials", () => {
    const summary = summarizeEngine("stagehand", [], "no key");
    expect(summary).toEqual({
      engine: "stagehand",
      trials: 0,
      skippedReason: "no key",
      taskSuccessRate: null,
      extractionSuccessRate: null,
      validationSuccessRate: null,
      meanAccuracy: null,
      meanDurationMs: null,
      totalRetries: 0,
      recovery: { firstAttemptFailures: 0, recovered: 0, recoveryRate: null },
      retryRecoveries: 0,
      failuresByCategory: {},
      outcomeClasses: {},
      silentCorruptionRate: null,
      tokens: null
    });
  });

  it("computes exact rates, recovery, accuracy and failure counts", () => {
    const trials: TrialResult[] = [
      trial({ outcome: "pass", accuracy: { overall: 1 }, durationMs: 100, retries: 0 }),
      trial({
        outcome: "pass",
        accuracy: { overall: 0.5 },
        durationMs: 200,
        retries: 1,
        recoveredAfterFailure: true
      }),
      trial({
        outcome: "fail",
        extractionSuccess: false,
        validationSuccess: false,
        accuracy: null,
        durationMs: 300,
        retries: 1,
        failureCategory: "not_found"
      }),
      trial({
        outcome: "fail",
        extractionSuccess: true,
        validationSuccess: false,
        accuracy: { overall: 0 },
        durationMs: 400,
        retries: 0,
        failureCategory: "validation"
      })
    ];
    const summary = summarizeEngine("baseline", trials);
    expect(summary.trials).toBe(4);
    expect(summary.taskSuccessRate).toBe(0.5);
    expect(summary.extractionSuccessRate).toBe(0.75);
    expect(summary.validationSuccessRate).toBe(0.5);
    expect(summary.meanAccuracy).toBeCloseTo(0.5, 10); // (1 + 0.5 + 0) / 3
    expect(summary.meanDurationMs).toBe(250);
    expect(summary.totalRetries).toBe(2);
    expect(summary.recovery).toEqual({
      firstAttemptFailures: 2,
      recovered: 1,
      recoveryRate: 0.5
    });
    // retryRecoveries mirrors recovery.recovered (8d): a retry-only success.
    expect(summary.retryRecoveries).toBe(1);
    expect(summary.failuresByCategory).toEqual({ not_found: 1, validation: 1 });
    expect(summary.tokens).toBeNull();
  });

  it("reports recoveryRate null and meanAccuracy null when there is nothing to average", () => {
    const trials: TrialResult[] = [
      trial({ retries: 0, accuracy: null }),
      trial({ retries: 0, accuracy: null })
    ];
    const summary = summarizeEngine("baseline", trials);
    expect(summary.recovery).toEqual({
      firstAttemptFailures: 0,
      recovered: 0,
      recoveryRate: null
    });
    expect(summary.meanAccuracy).toBeNull();
  });

  it("sums token usage across trials when any trial reports tokens", () => {
    const trials: TrialResult[] = [
      trial({ tokens: { llmCalls: 2, inputTokens: 100, outputTokens: 50 } }),
      trial({ tokens: { llmCalls: 3, inputTokens: 200 } }),
      trial({ tokens: null })
    ];
    const summary = summarizeEngine("stagehand", trials);
    expect(summary.tokens).toEqual({
      llmCalls: 5,
      inputTokens: 300,
      outputTokens: 50
    });
  });

  it("counts healedTrials only for trials that recorded a healed step", () => {
    const noHeal = summarizeEngine("baseline", [trial({}), trial({})]);
    expect(noHeal.healedTrials).toBeUndefined();

    const withHeal = summarizeEngine("hybrid", [
      trial({ engine: "hybrid", healedSteps: ["reveal-table"] }),
      trial({ engine: "hybrid", healedSteps: [] }),
      trial({ engine: "hybrid" })
    ]);
    expect(withHeal.healedTrials).toBe(1);
  });

  it("counts deterministicRepairTrials only for B2 trials with a deterministic repair", () => {
    const none = summarizeEngine("baseline", [trial({}), trial({})]);
    expect(none.deterministicRepairTrials).toBeUndefined();

    const withB2 = summarizeEngine("hybrid", [
      trial({ engine: "hybrid", deterministicRepairSteps: ["login"] }),
      trial({ engine: "hybrid", deterministicRepairSteps: ["extract-stats"] }),
      trial({ engine: "hybrid", deterministicRepairSteps: [] }),
      trial({ engine: "hybrid" })
    ]);
    expect(withB2.deterministicRepairTrials).toBe(2);
    // B2 never writes healedSteps, so healedTrials stays omitted (orthogonal).
    expect(withB2.healedTrials).toBeUndefined();
  });

  it("tallies outcomeClasses and the silent-corruption rate (count/trials)", () => {
    const trials: TrialResult[] = [
      trial({ outcomeClass: "pass" }),
      trial({ outcomeClass: "pass" }),
      trial({ outcomeClass: "safe-failure", outcome: "fail", pipelineSuccess: false }),
      trial({
        outcomeClass: "silent-corruption",
        outcome: "fail",
        pipelineSuccess: true,
        accuracy: { overall: 0.5 }
      })
    ];
    const summary = summarizeEngine("baseline", trials);
    expect(summary.outcomeClasses).toEqual({
      pass: 2,
      "safe-failure": 1,
      "silent-corruption": 1
    });
    expect(summary.silentCorruptionRate).toBe(0.25);
  });

  it("reports a zero silent-corruption rate when no trial is corrupt", () => {
    const summary = summarizeEngine("baseline", [
      trial({ outcomeClass: "pass" }),
      trial({ outcomeClass: "hard-failure", outcome: "fail", pipelineSuccess: false })
    ]);
    expect(summary.silentCorruptionRate).toBe(0);
    expect(summary.outcomeClasses).toEqual({ pass: 1, "hard-failure": 1 });
  });
});

describe("classifyOutcome", () => {
  it("classes a clean first-attempt success as pass", () => {
    expect(
      classifyOutcome({ pipelineSuccess: true, overall: 1, expected: "success" })
    ).toBe("pass");
  });

  it("classes a retry-only perfect success (no heal) as pass, not recovered (8d)", () => {
    // 8d: 'recovered' now requires a semantic repair. A win that only needed a
    // whole-attempt retry stays 'pass' (the retry is reported via retryRecoveries).
    expect(
      classifyOutcome({ pipelineSuccess: true, overall: 1, expected: "success" })
    ).toBe("pass");
  });

  it("classes a perfect success that healed a step as recovered", () => {
    expect(
      classifyOutcome({
        pipelineSuccess: true,
        overall: 1,
        expected: "success",
        healedSteps: ["reveal-table"]
      })
    ).toBe("recovered");
  });

  it("classes a perfect B2 deterministic-repair success as pass, not recovered", () => {
    // B2 records deterministicRepairSteps but NEVER healedSteps, and classifyOutcome
    // keys `recovered` off healedSteps only — so a perfect B2 success stays `pass`
    // (PROTOCOL_2A §2). classifyOutcome takes no deterministicRepairSteps input.
    expect(
      classifyOutcome({ pipelineSuccess: true, overall: 1, expected: "success", healedSteps: [] })
    ).toBe("pass");
  });

  it("classes accepted output on a validation-failure scenario as silent-corruption (8b)", () => {
    // The oracle demanded refusal; a successful pipeline is silent corruption
    // regardless of how accurate the (wrongly-accepted) data looks.
    expect(
      classifyOutcome({
        pipelineSuccess: true,
        overall: 1,
        expected: "validation-failure"
      })
    ).toBe("silent-corruption");
    expect(
      classifyOutcome({
        pipelineSuccess: true,
        overall: 1,
        expected: "validation-failure",
        healedSteps: ["reveal-table"]
      })
    ).toBe("silent-corruption");
  });

  it("classes a success below perfect accuracy as silent-corruption", () => {
    expect(
      classifyOutcome({ pipelineSuccess: true, overall: 0.96, expected: "success" })
    ).toBe("silent-corruption");
  });

  it("classes a success with no accuracy sample as silent-corruption", () => {
    expect(
      classifyOutcome({ pipelineSuccess: true, overall: undefined, expected: "success" })
    ).toBe("silent-corruption");
  });

  it("classes a caught validation/extraction failure as safe-failure", () => {
    expect(
      classifyOutcome({
        pipelineSuccess: false,
        overall: 0.95,
        expected: "success",
        failureCategory: "validation"
      })
    ).toBe("safe-failure");
    expect(
      classifyOutcome({
        pipelineSuccess: false,
        overall: undefined,
        expected: "success",
        failureCategory: "extraction"
      })
    ).toBe("safe-failure");
  });

  it("classes any other reported failure as hard-failure", () => {
    for (const failureCategory of ["not_found", "auth", "timeout", "internal"] as const) {
      expect(
        classifyOutcome({
          pipelineSuccess: false,
          overall: undefined,
          expected: "success",
          failureCategory
        })
      ).toBe("hard-failure");
    }
  });

  it("treats 0.999999999 as perfect but 0.95 as corrupt (1e-9 tolerance)", () => {
    expect(
      classifyOutcome({ pipelineSuccess: true, overall: 0.999999999, expected: "success" })
    ).toBe("pass");
    expect(
      classifyOutcome({ pipelineSuccess: true, overall: 0.95, expected: "success" })
    ).toBe("silent-corruption");
  });
});

describe("buildComparison", () => {
  const TWO: Parameters<typeof buildComparison>[2] = ["stagehand", "baseline"];

  it("takes a majority vote per engine and marks skipped engines skipped", () => {
    const scenarios = [scenario("clean-extraction")];
    const trials: TrialResult[] = [
      trial({ scenarioId: "clean-extraction", engine: "baseline", trial: 1, outcome: "pass" }),
      trial({ scenarioId: "clean-extraction", engine: "baseline", trial: 2, outcome: "pass" }),
      trial({ scenarioId: "clean-extraction", engine: "baseline", trial: 3, outcome: "fail" })
    ];
    const [row] = buildComparison(scenarios, trials, TWO, ["stagehand"]);
    expect(row).toEqual({
      scenarioId: "clean-extraction",
      results: { stagehand: "skipped", baseline: "pass" }
    });
  });

  it("emits one cell per requested engine, including hybrid", () => {
    const scenarios = [scenario("column-shuffle")];
    const trials: TrialResult[] = [
      trial({ scenarioId: "column-shuffle", engine: "baseline", outcome: "fail" }),
      trial({ scenarioId: "column-shuffle", engine: "hybrid", outcome: "pass" })
    ];
    const [row] = buildComparison(
      scenarios,
      trials,
      ["stagehand", "baseline", "hybrid"],
      ["stagehand"]
    );
    expect(row?.results).toEqual({
      stagehand: "skipped",
      baseline: "fail",
      hybrid: "pass"
    });
  });

  it("propagates the first failing trial's reason and joins both engines when both fail", () => {
    const scenarios = [scenario("class-drift")];
    const trials: TrialResult[] = [
      trial({
        scenarioId: "class-drift",
        engine: "stagehand",
        trial: 1,
        outcome: "fail",
        outcomeReason: "expected success but pipeline failed [timeout]"
      }),
      trial({
        scenarioId: "class-drift",
        engine: "baseline",
        trial: 1,
        outcome: "fail",
        outcomeReason: "expected success but pipeline failed [not_found]"
      })
    ];
    const [row] = buildComparison(scenarios, trials, TWO, []);
    expect(row).toEqual({
      scenarioId: "class-drift",
      results: { stagehand: "fail", baseline: "fail" },
      note:
        "stagehand: expected success but pipeline failed [timeout] | " +
        "baseline: expected success but pipeline failed [not_found]"
    });
  });

  it("marks an engine with no trials as skipped", () => {
    const scenarios = [scenario("clean-extraction")];
    const [row] = buildComparison(scenarios, [], TWO, []);
    expect(row?.results.stagehand).toBe("skipped");
    expect(row?.results.baseline).toBe("skipped");
    expect(row?.note).toBeUndefined();
  });
});

describe("judge accuracy bar (Wave C: perfect extraction required)", () => {
  // Minimal PipelineResult shape covering only the fields judge() reads.
  function successResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
    return {
      success: true,
      steps: [],
      normalized: { warnings: [] },
      ...overrides
    } as unknown as PipelineResult;
  }

  const successScenario = scenario("clean-extraction"); // expected: "success"

  it("passes a success at overall 0.999999999 (within 1e-9 of perfect)", () => {
    const { outcome } = judge(successScenario, successResult(), 0.999999999);
    expect(outcome).toBe("pass");
  });

  it("fails a success at overall 0.95 naming the required bar", () => {
    const { outcome, reason } = judge(successScenario, successResult(), 0.95);
    expect(outcome).toBe("fail");
    expect(reason).toContain("accuracy 1.00 required, got 0.95");
  });

  it("fails a successful pipeline that produced no accuracy sample", () => {
    const { outcome, reason } = judge(successScenario, successResult(), undefined);
    expect(outcome).toBe("fail");
    expect(reason).toContain("no accuracy sample");
  });

  it("leaves the validation-failure branch unchanged (still passes below 1.0)", () => {
    const vfScenario: ScenarioSpec = {
      ...scenario("schema-violation"),
      expected: "validation-failure"
    };
    const result = successResult({ success: false, failureCategory: "validation" });
    const { outcome } = judge(vfScenario, result, 0.95);
    expect(outcome).toBe("pass");
  });
});

describe("judge entity-completeness gate (Wave E 8e)", () => {
  function successResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
    return {
      success: true,
      steps: [],
      normalized: { warnings: [] },
      ...overrides
    } as unknown as PipelineResult;
  }
  const report = (over: Partial<AccuracyReport> = {}): AccuracyReport => ({
    expectedRows: 12,
    matchedRows: 12,
    fieldChecks: 48,
    fieldMatches: 48,
    rowCoverage: 1,
    fieldAccuracy: 1,
    duplicateRows: 0,
    unexpectedRows: 0,
    score: 1,
    ...over
  });
  const successScenario = scenario("clean-extraction");

  it("passes a perfect success with zero duplicate/unexpected rows on both pages", () => {
    const { outcome } = judge(successScenario, successResult(), 1, {
      stats: report(),
      odds: report()
    });
    expect(outcome).toBe("pass");
  });

  it("fails a perfect-accuracy success when a page has a duplicate row", () => {
    const { outcome, reason } = judge(successScenario, successResult(), 1, {
      stats: report({ duplicateRows: 1 }),
      odds: report()
    });
    expect(outcome).toBe("fail");
    expect(reason).toContain("duplicate");
  });

  it("fails a perfect-accuracy success when a page has an unexpected (ghost) row", () => {
    const { outcome, reason } = judge(successScenario, successResult(), 1, {
      stats: report(),
      odds: report({ unexpectedRows: 1 })
    });
    expect(outcome).toBe("fail");
    expect(reason).toContain("unexpected");
  });
});
