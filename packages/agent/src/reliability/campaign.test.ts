import type { BenchmarkResults, ScenarioSpec, TrialResult } from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { aggregateCampaign, configurationLabel, renderCampaignMarkdown } from "./campaign";
import { trialCostUsd } from "./prices";

type Environment = BenchmarkResults["environment"];

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

/** A default keyless environment; override the provenance fields per test. */
function env(over: Partial<Environment> = {}): Environment {
  return {
    node: "v20",
    modelProvider: null,
    browserbase: false,
    gitCommit: "c0",
    gitDirty: false,
    disableRepair: false,
    seedCacheMode: "none",
    seedCacheHash: null,
    promptsHash: "P",
    lockfileHash: "L",
    ...over
  } as Environment;
}

/** Minimal synthetic run — aggregateCampaign reads scenarios, trials, environment. */
function run(
  scenarioIds: string[],
  trials: TrialResult[],
  environment: Environment = env()
): BenchmarkResults {
  return {
    benchId: "b",
    scenarios: scenarioIds.map(scenario),
    trials,
    environment
  } as unknown as BenchmarkResults;
}

describe("aggregateCampaign", () => {
  it("aggregates a (scenario × configuration) cell across two runs with counts and spreads", () => {
    const runs = [
      run(
        ["clean-extraction"],
        [trial({ durationMs: 100, tokens: { llmCalls: 0, inputTokens: 0, outputTokens: 0 } })]
      ),
      run(
        ["clean-extraction"],
        [trial({ durationMs: 300, tokens: { llmCalls: 0, inputTokens: 0, outputTokens: 0 } })]
      )
    ];
    const report = aggregateCampaign(runs, { sources: ["a", "b"] });
    expect(report.runs).toBe(2);
    expect(report.cells).toHaveLength(1);
    const cell = report.cells[0]!;
    expect(cell.scenarioId).toBe("clean-extraction");
    expect(cell.engine).toBe("hybrid");
    expect(cell.configuration).toBe("hybrid-keyless");
    expect(cell.trials).toBe(2);
    expect(cell.outcomes).toEqual({ pass: 2, fail: 0 });
    expect(cell.accuracy.median).toBe(1);
    expect(cell.durationMs.median).toBe(200); // (100 + 300) / 2
    expect(cell.durationMs.min).toBe(100);
    expect(cell.durationMs.max).toBe(300);
    expect(cell.llmCalls.sum).toBe(0);
    expect(cell.costUsd.sum).toBeNull(); // keyless: no model → no computable cost
    expect(cell.healRate).toBe(0);
    expect(cell.retryRecoveries).toBe(0);
    expect(report.warnings).toEqual([]);
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
          trial({
            scenarioId: "class-drift",
            engine: "baseline",
            outcome: "fail",
            outcomeClass: "hard-failure",
            pipelineSuccess: false
          })
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
    expect(md).toContain("Per-configuration totals");
  });

  it("keeps the same scenario+engine in SEPARATE cells under different configurations", () => {
    // Both runs are hybrid on the same scenario, but one is --no-repair
    // (B-structural) and one is keyed+seeded (C-hybrid-repair-seeded). They must
    // never blend into one cell.
    const runs = [
      run(["clean-extraction"], [trial({})], env({ disableRepair: true })),
      run(
        ["clean-extraction"],
        [trial({})],
        env({ modelProvider: "anthropic", seedCacheMode: "manifest" })
      )
    ];
    const report = aggregateCampaign(runs);
    expect(report.cells).toHaveLength(2);
    expect(report.cells.every((c) => c.scenarioId === "clean-extraction")).toBe(true);
    expect(report.cells.every((c) => c.engine === "hybrid")).toBe(true);
    expect(new Set(report.cells.map((c) => c.configuration))).toEqual(
      new Set(["B-structural", "C-hybrid-repair-seeded"])
    );
  });

  it("throws on mixed promptsHash unless allowMixed is set", () => {
    const runs = [
      run(["clean-extraction"], [trial({})], env({ promptsHash: "P1" })),
      run(["clean-extraction"], [trial({})], env({ promptsHash: "P2" }))
    ];
    expect(() => aggregateCampaign(runs)).toThrow(/promptsHash.*P1.*P2|P1.*P2/);
    const report = aggregateCampaign(runs, {}, { allowMixed: true });
    expect(report.runs).toBe(2);
    expect(report.cells.length).toBeGreaterThan(0);
  });

  it("throws on mixed non-null stagehandModel unless allowMixed is set", () => {
    const runs = [
      run(
        ["clean-extraction"],
        [trial({ engine: "stagehand" })],
        env({ modelProvider: "anthropic", stagehandModel: "anthropic/claude-haiku-4-5" })
      ),
      run(
        ["clean-extraction"],
        [trial({ engine: "stagehand" })],
        env({ modelProvider: "anthropic", stagehandModel: "anthropic/claude-sonnet-4-5" })
      )
    ];
    expect(() => aggregateCampaign(runs)).toThrow(/stagehandModel/);
    expect(() => aggregateCampaign(runs, {}, { allowMixed: true })).not.toThrow();
  });

  it("warns (never throws) when runs span multiple gitCommit or seedCacheHash values", () => {
    const runs = [
      run(["clean-extraction"], [trial({})], env({ gitCommit: "aaa", seedCacheHash: "h1" })),
      run(["clean-extraction"], [trial({})], env({ gitCommit: "bbb", seedCacheHash: "h2" }))
    ];
    const report = aggregateCampaign(runs);
    expect(report.warnings.some((w) => /gitCommit/.test(w))).toBe(true);
    expect(report.warnings.some((w) => /seedCacheHash/.test(w))).toBe(true);
    expect(renderCampaignMarkdown(report)).toContain("## Warnings");
  });

  it("computes per-trial dollar cost from the pinned table using the run's model", () => {
    // 200k input + 40k output on haiku = (200000·1 + 40000·5)/1e6 = $0.40.
    const runs = [
      run(
        ["clean-extraction"],
        [
          trial({
            engine: "hybrid",
            tokens: { llmCalls: 5, inputTokens: 200_000, outputTokens: 40_000 }
          })
        ],
        env({ modelProvider: "anthropic", stagehandModel: "anthropic/claude-haiku-4-5" })
      )
    ];
    const report = aggregateCampaign(runs);
    expect(report.cells).toHaveLength(1);
    const cell = report.cells[0]!;
    expect(cell.configuration).toBe("C-hybrid-repair-cold");
    expect(cell.costUsd.sum).toBeCloseTo(0.4, 10);
  });

  it("reports a null cost for an unknown model", () => {
    const runs = [
      run(
        ["clean-extraction"],
        [
          trial({
            engine: "stagehand",
            tokens: { llmCalls: 5, inputTokens: 200_000, outputTokens: 40_000 }
          })
        ],
        env({ modelProvider: "openai", stagehandModel: "openai/gpt-unknown" })
      )
    ];
    const report = aggregateCampaign(runs);
    expect(report.cells[0]!.costUsd.sum).toBeNull();
  });
});

describe("trialCostUsd", () => {
  const haiku = "anthropic/claude-haiku-4-5";

  it("computes the hand-checked cost (200k in + 40k out on haiku = $0.40)", () => {
    expect(trialCostUsd({ inputTokens: 200_000, outputTokens: 40_000 }, haiku)).toBeCloseTo(0.4, 10);
  });

  it("treats a missing side as zero", () => {
    expect(trialCostUsd({ inputTokens: 1_000_000 }, haiku)).toBeCloseTo(1.0, 10);
    expect(trialCostUsd({ outputTokens: 1_000_000 }, haiku)).toBeCloseTo(5.0, 10);
  });

  it("returns null for an unknown/absent model, null tokens, or no token counts", () => {
    expect(trialCostUsd({ inputTokens: 100 }, "openai/gpt-unknown")).toBeNull();
    expect(trialCostUsd({ inputTokens: 100 }, undefined)).toBeNull();
    expect(trialCostUsd(null, haiku)).toBeNull();
    expect(trialCostUsd({ llmCalls: 3 } as { inputTokens?: number }, haiku)).toBeNull();
  });
});

describe("configurationLabel", () => {
  it("baseline → A-baseline (regardless of env)", () => {
    expect(configurationLabel("baseline", env({ disableRepair: true }))).toBe("A-baseline");
  });
  it("stagehand → D-full-semantic (regardless of env)", () => {
    expect(configurationLabel("stagehand", env())).toBe("D-full-semantic");
  });
  it("hybrid + disableRepair → B-structural", () => {
    expect(configurationLabel("hybrid", env({ disableRepair: true }))).toBe("B-structural");
  });
  it("hybrid + no model provider → hybrid-keyless", () => {
    expect(configurationLabel("hybrid", env({ modelProvider: null }))).toBe("hybrid-keyless");
  });
  it("hybrid + keyed + no seed cache → C-hybrid-repair-cold", () => {
    expect(configurationLabel("hybrid", env({ modelProvider: "anthropic", seedCacheMode: "none" }))).toBe(
      "C-hybrid-repair-cold"
    );
  });
  it("hybrid + keyed + seeded → C-hybrid-repair-seeded", () => {
    expect(
      configurationLabel("hybrid", env({ modelProvider: "anthropic", seedCacheMode: "file" }))
    ).toBe("C-hybrid-repair-seeded");
  });
});
