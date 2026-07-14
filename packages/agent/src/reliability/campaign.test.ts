import type { BenchmarkResults, ScenarioSpec, TrialResult } from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { aggregateCampaign, renderCampaignMarkdown } from "./campaign";

function trial(over: Partial<TrialResult>): TrialResult {
  return {
    scenarioId: "clean-extraction",
    engine: "hybrid",
    trial: 1,
    runId: "r",
    outcome: "pass",
    outcomeReason: "ok",
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
    ...over
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

/** Minimal synthetic run — aggregateCampaign only reads scenarios + trials. */
function run(scenarioIds: string[], trials: TrialResult[]): BenchmarkResults {
  return {
    scenarios: scenarioIds.map(scenario),
    trials
  } as unknown as BenchmarkResults;
}

describe("aggregateCampaign", () => {
  it("aggregates a (scenario × engine) cell across two runs with counts and spreads", () => {
    const runs = [
      run(
        ["clean-extraction"],
        [
          trial({
            durationMs: 100,
            tokens: { llmCalls: 0, inputTokens: 0, outputTokens: 0 }
          })
        ]
      ),
      run(
        ["clean-extraction"],
        [
          trial({
            durationMs: 300,
            tokens: { llmCalls: 0, inputTokens: 0, outputTokens: 0 }
          })
        ]
      )
    ];
    const report = aggregateCampaign(runs, { sources: ["a", "b"] });
    expect(report.runs).toBe(2);
    expect(report.cells).toHaveLength(1);
    const cell = report.cells[0]!;
    expect(cell.scenarioId).toBe("clean-extraction");
    expect(cell.engine).toBe("hybrid");
    expect(cell.trials).toBe(2);
    expect(cell.outcomes).toEqual({ pass: 2, fail: 0 });
    expect(cell.accuracy.median).toBe(1);
    expect(cell.durationMs.median).toBe(200); // (100 + 300) / 2
    expect(cell.durationMs.min).toBe(100);
    expect(cell.durationMs.max).toBe(300);
    expect(cell.llmCalls.sum).toBe(0);
    expect(cell.healRate).toBe(0);
    expect(cell.retryRecoveries).toBe(0);
  });

  it("counts heal rate, retry recoveries, class counts and llmCalls sums", () => {
    const runs = [
      run(
        ["class-drift"],
        [
          trial({
            scenarioId: "class-drift",
            outcomeClass: "recovered",
            healedSteps: ["reveal-table"],
            recoveredAfterFailure: false,
            tokens: { llmCalls: 2, inputTokens: 100, outputTokens: 40 }
          }),
          trial({
            scenarioId: "class-drift",
            outcomeClass: "pass",
            retries: 1,
            recoveredAfterFailure: true,
            tokens: { llmCalls: 0 }
          })
        ]
      )
    ];
    const report = aggregateCampaign(runs);
    expect(report.cells).toHaveLength(1);
    const cell = report.cells[0]!;
    expect(cell.trials).toBe(2);
    expect(cell.outcomeClasses).toEqual({ recovered: 1, pass: 1 });
    expect(cell.healRate).toBe(0.5);
    expect(cell.retryRecoveries).toBe(1);
    expect(cell.llmCalls.sum).toBe(2);
    expect(cell.inputTokens.sum).toBe(100);
    expect(cell.outputTokens.sum).toBe(40);
  });

  it("emits one cell per (scenario, engine) pair, ordered by first appearance", () => {
    const runs = [
      run(
        ["clean-extraction", "class-drift"],
        [
          trial({ scenarioId: "clean-extraction", engine: "baseline" }),
          trial({ scenarioId: "clean-extraction", engine: "hybrid" }),
          trial({ scenarioId: "class-drift", engine: "baseline", outcome: "fail", outcomeClass: "hard-failure", pipelineSuccess: false })
        ]
      )
    ];
    const report = aggregateCampaign(runs);
    expect(report.cells.map((c) => `${c.scenarioId}/${c.engine}`)).toEqual([
      "clean-extraction/baseline",
      "clean-extraction/hybrid",
      "class-drift/baseline"
    ]);
    const md = renderCampaignMarkdown(report);
    expect(md).toContain("# Campaign aggregation");
    expect(md).toContain("class-drift");
  });
});
