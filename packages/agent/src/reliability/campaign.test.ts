import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BenchmarkResultsSchema,
  type BenchmarkResults,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import { describe, expect, it } from "vitest";
import { aggregateCampaign, configurationLabel, renderCampaignMarkdown } from "./campaign";
import { validateRunPurpose } from "./runner";

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
    expect(cell.costUsd.sum).toBe(0); // keyless zero-inference trials are an exact, priced $0
    expect(cell.costUsd.priced).toBe(2);
    expect(cell.costUsd.total).toBe(2);
    expect(cell.healRate).toBe(0);
    expect(cell.retryRecoveries).toBe(0);
    // llmCalls===0 prices as $0 before any model lookup, so keyless coverage is
    // full — no lower-bound warning (and no gitCommit/seedCacheHash disagreement).
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
  it("hybrid + repairMode deterministic → B2-deterministic-repair (checked before B/C)", () => {
    // Keyed and keyless B2 both label the same; the repairMode check runs first so
    // it never collapses into B-structural or C-hybrid-repair-cold.
    expect(
      configurationLabel("hybrid", env({ repairMode: "deterministic", modelProvider: "anthropic" }))
    ).toBe("B2-deterministic-repair");
    expect(configurationLabel("hybrid", env({ repairMode: "deterministic" }))).toBe(
      "B2-deterministic-repair"
    );
  });
  it("hybrid + repairMode llm/off keeps the Phase-1 labels (deterministic check does not trigger)", () => {
    expect(
      configurationLabel("hybrid", env({ repairMode: "llm", modelProvider: "anthropic", seedCacheMode: "none" }))
    ).toBe("C-hybrid-repair-cold");
    expect(configurationLabel("hybrid", env({ repairMode: "off", disableRepair: true }))).toBe(
      "B-structural"
    );
  });
  it("hybrid + keyed + seeded (no purpose) → C-hybrid-repair-seeded (defensive fallback)", () => {
    expect(
      configurationLabel("hybrid", env({ modelProvider: "anthropic", seedCacheMode: "file" }))
    ).toBe("C-hybrid-repair-seeded");
  });
  it("hybrid + keyed + seeded + persistence → C-hybrid-repair-persistence", () => {
    expect(
      configurationLabel(
        "hybrid",
        env({ modelProvider: "anthropic", seedCacheMode: "manifest", runPurpose: "persistence" })
      )
    ).toBe("C-hybrid-repair-persistence");
  });
  it("hybrid + keyed + seeded + warm → C-hybrid-repair-warm", () => {
    expect(
      configurationLabel(
        "hybrid",
        env({ modelProvider: "anthropic", seedCacheMode: "manifest", runPurpose: "warm" })
      )
    ).toBe("C-hybrid-repair-warm");
  });
});

describe("configurationLabel run-purpose split (identical seedCacheHash)", () => {
  it("persistence and warm runs with the SAME seedCacheHash land in separate cells", () => {
    // Both are keyed+seeded hybrid on the same scenario with an IDENTICAL
    // seedCacheHash — only runPurpose differs. They must never blend.
    const seeded = { modelProvider: "anthropic", seedCacheMode: "manifest", seedCacheHash: "H" } as const;
    const runs = [
      run(["clean-extraction"], [trial({})], env({ ...seeded, runPurpose: "persistence" })),
      run(["clean-extraction"], [trial({})], env({ ...seeded, runPurpose: "warm" }))
    ];
    const report = aggregateCampaign(runs);
    expect(report.cells).toHaveLength(2);
    expect(new Set(report.cells.map((c) => c.configuration))).toEqual(
      new Set(["C-hybrid-repair-persistence", "C-hybrid-repair-warm"])
    );
    // seedCacheHash is identical → no seedCacheHash warning.
    expect(report.warnings.some((w) => /seedCacheHash/.test(w))).toBe(false);
  });
});

describe("cost coverage + baseline pricing", () => {
  it("baseline trials cost a priced $0; coverage counts every trial as priced", () => {
    const runs = [
      run(
        ["clean-extraction"],
        [
          trial({ engine: "baseline", tokens: null }),
          trial({ engine: "baseline", tokens: null })
        ],
        env()
      )
    ];
    const report = aggregateCampaign(runs);
    const cell = report.cells[0]!;
    expect(cell.configuration).toBe("A-baseline");
    expect(cell.costUsd.sum).toBe(0);
    expect(cell.costUsd.priced).toBe(2);
    expect(cell.costUsd.total).toBe(2);
    // Fully priced → no lower-bound warning.
    expect(report.warnings.some((w) => /lower bounds/.test(w))).toBe(false);
  });

  it("a configuration with an unpriced trial reports partial coverage and a lower-bound warning", () => {
    // Keyed hybrid: one trial has computable cost, one is unpriced (llmCalls>0 but
    // only one token side present → trialCostUsd returns null).
    const runs = [
      run(
        ["clean-extraction"],
        [
          trial({ engine: "hybrid", tokens: { llmCalls: 5, inputTokens: 200_000, outputTokens: 40_000 } }),
          trial({ engine: "hybrid", tokens: { llmCalls: 5, inputTokens: 200_000 } })
        ],
        env({ modelProvider: "anthropic", stagehandModel: "anthropic/claude-haiku-4-5" })
      )
    ];
    const report = aggregateCampaign(runs);
    const cell = report.cells[0]!;
    expect(cell.costUsd.priced).toBe(1);
    expect(cell.costUsd.total).toBe(2);
    expect(cell.costUsd.sum).toBeCloseTo(0.4, 10); // lower bound over the one priced trial
    expect(
      report.warnings.some((w) =>
        /C-hybrid-repair-cold: 1 of 2 trials have no computable cost — cost totals are lower bounds\./.test(w)
      )
    ).toBe(true);
  });
});

describe("deterministic-fallback exposure", () => {
  it("counts fallback trials and total firings per cell", () => {
    const runs = [
      run(
        ["cookie-banner"],
        [
          trial({ scenarioId: "cookie-banner", engine: "stagehand", deterministicFallbacks: ["consent", "consent"] }),
          trial({ scenarioId: "cookie-banner", engine: "stagehand", deterministicFallbacks: ["dismiss-modal"] }),
          trial({ scenarioId: "cookie-banner", engine: "stagehand" })
        ],
        env({ modelProvider: "anthropic", stagehandModel: "anthropic/claude-haiku-4-5" })
      )
    ];
    const cell = aggregateCampaign(runs).cells[0]!;
    expect(cell.deterministicFallbacks).toEqual({ trials: 2, firings: 3 });
  });
});

describe("smoke separation", () => {
  it("throws when smoke runs mix with non-smoke runs, even with allowMixed", () => {
    const runs = [
      run(["clean-extraction"], [trial({})], env({ runPurpose: "smoke" })),
      run(["clean-extraction"], [trial({})], env({ runPurpose: "cold" }))
    ];
    expect(() => aggregateCampaign(runs)).toThrow(/smoke/i);
    expect(() => aggregateCampaign(runs, {}, { allowMixed: true })).toThrow(/smoke/i);
  });

  it("aggregates an all-smoke run with smoke:true and smoke:-prefixed labels", () => {
    const runs = [
      run(
        ["clean-extraction"],
        [trial({ engine: "baseline" }), trial({ engine: "hybrid" })],
        env({ runPurpose: "smoke" })
      )
    ];
    const report = aggregateCampaign(runs);
    expect(report.smoke).toBe(true);
    expect(report.cells.map((c) => c.configuration).sort()).toEqual([
      "smoke:A-baseline",
      "smoke:hybrid-keyless"
    ]);
    expect(report.configTotals.every((t) => t.configuration.startsWith("smoke:"))).toBe(true);
    expect(renderCampaignMarkdown(report)).toContain(
      "# Campaign aggregation — SMOKE (never evidence)"
    );
  });
});

describe("configTotals (D1/D2/D3, fallbacks, cost per success)", () => {
  it("hand-computes the frozen denominators and cost-per-successful-workflow", () => {
    // One keyed-hybrid configuration, 4 trials on one scenario:
    //  - 2 pass  (class pass)
    //  - 1 silent-corruption (judged fail)
    //  - 1 hard-failure    (judged fail)
    // trials = 4, judgedPasses = 2, judgedFailures = 2, sc = 1,
    // accepted = pass(2) + recovered(0) + sc(1) = 3.
    // Cost: only the two passes carry priced tokens ($0.40 each = $0.80);
    // the two failures have null tokens → unpriced. costPerSuccess = 0.80 / 2 = 0.40.
    const tok = { llmCalls: 5, inputTokens: 200_000, outputTokens: 40_000 };
    const runs = [
      run(
        ["class-drift"],
        [
          trial({ scenarioId: "class-drift", engine: "hybrid", outcome: "pass", outcomeClass: "pass", tokens: tok }),
          trial({ scenarioId: "class-drift", engine: "hybrid", outcome: "pass", outcomeClass: "pass", tokens: tok }),
          trial({
            scenarioId: "class-drift",
            engine: "hybrid",
            outcome: "fail",
            outcomeClass: "silent-corruption",
            pipelineSuccess: false,
            tokens: null
          }),
          trial({
            scenarioId: "class-drift",
            engine: "hybrid",
            outcome: "fail",
            outcomeClass: "hard-failure",
            pipelineSuccess: false,
            tokens: null
          })
        ],
        env({ modelProvider: "anthropic", stagehandModel: "anthropic/claude-haiku-4-5" })
      )
    ];
    const report = aggregateCampaign(runs);
    expect(report.configTotals).toHaveLength(1);
    const t = report.configTotals[0]!;
    expect(t.configuration).toBe("C-hybrid-repair-cold");
    expect(t.trials).toBe(4);
    expect(t.judgedPasses).toBe(2);
    expect(t.judgedFailures).toBe(2);
    expect(t.silentCorruption).toBe(1);
    expect(t.accepted).toBe(3);
    expect(t.cost.priced).toBe(2);
    expect(t.cost.total).toBe(4);
    expect(t.cost.sum).toBeCloseTo(0.8, 10);
    expect(t.costPerSuccess).toBeCloseTo(0.4, 10);
    // D1 = 1/4, D2 = 1/2, D3 = 1/3 — rendered in the markdown.
    const md = renderCampaignMarkdown(report);
    expect(md).toContain("D1 (of trials): 1/4 (25%)");
    expect(md).toContain("D2 (of judged failures): 1/2 (50%)");
    expect(md).toContain("D3 (of accepted outputs): 1/3 (33%)");
  });

  it("costPerSuccess is null when there are zero judged passes", () => {
    const runs = [
      run(
        ["class-drift"],
        [
          trial({
            scenarioId: "class-drift",
            engine: "hybrid",
            outcome: "fail",
            outcomeClass: "hard-failure",
            pipelineSuccess: false,
            tokens: { llmCalls: 5, inputTokens: 200_000, outputTokens: 40_000 }
          })
        ],
        env({ modelProvider: "anthropic", stagehandModel: "anthropic/claude-haiku-4-5" })
      )
    ];
    const t = aggregateCampaign(runs).configTotals[0]!;
    expect(t.judgedPasses).toBe(0);
    expect(t.costPerSuccess).toBeNull();
  });
});

describe("validateRunPurpose", () => {
  it("persistence REQUIRES a seeded cache", () => {
    expect(() => validateRunPurpose("persistence", "none")).toThrow(/persistence.*none/s);
    expect(() => validateRunPurpose("persistence", "file")).not.toThrow();
    expect(() => validateRunPurpose("persistence", "manifest")).not.toThrow();
  });
  it("warm REQUIRES a seeded cache", () => {
    expect(() => validateRunPurpose("warm", "none")).toThrow(/warm.*none/s);
    expect(() => validateRunPurpose("warm", "file")).not.toThrow();
    expect(() => validateRunPurpose("warm", "manifest")).not.toThrow();
  });
  it("cold REQUIRES an unseeded run", () => {
    expect(() => validateRunPurpose("cold", "none")).not.toThrow();
    expect(() => validateRunPurpose("cold", "file")).toThrow(/cold.*file/s);
    expect(() => validateRunPurpose("cold", "manifest")).toThrow(/cold.*manifest/s);
  });
  it("smoke REQUIRES an unseeded run", () => {
    expect(() => validateRunPurpose("smoke", "none")).not.toThrow();
    expect(() => validateRunPurpose("smoke", "file")).toThrow(/smoke.*file/s);
    expect(() => validateRunPurpose("smoke", "manifest")).toThrow(/smoke.*manifest/s);
  });
});

describe("protocolId / suiteHash gate (PROTOCOL_2A §5 item 6)", () => {
  const stamped = (over: Partial<Environment>) =>
    env({ protocolId: "phase2a-v1", suiteHash: "suite-a", ...over });

  it("refuses to aggregate runs with mixed protocolId, naming the runs", () => {
    const runs = [
      run(["clean-extraction"], [trial({})], stamped({ protocolId: "phase2a-v1" })),
      run(["clean-extraction"], [trial({})], stamped({ protocolId: "phase2b-v1" }))
    ];
    expect(() => aggregateCampaign(runs, { sources: ["run-a", "run-b"] })).toThrow(
      /protocolId.*phase2a-v1.*run-a.*phase2b-v1.*run-b|phase2b-v1/
    );
    // The gate is a hard error even under allowMixed (never overridable).
    expect(() =>
      aggregateCampaign(runs, { sources: ["run-a", "run-b"] }, { allowMixed: true })
    ).toThrow(/protocolId/);
  });

  it("refuses to aggregate runs with mixed suiteHash, naming the runs", () => {
    const runs = [
      run(["clean-extraction"], [trial({})], stamped({ suiteHash: "suite-a" })),
      run(["clean-extraction"], [trial({})], stamped({ suiteHash: "suite-b" }))
    ];
    expect(() => aggregateCampaign(runs, { sources: ["run-a", "run-b"] })).toThrow(/suiteHash/);
  });

  it("aggregates runs that share the same protocolId and suiteHash", () => {
    const runs = [
      run(["clean-extraction"], [trial({})], stamped({})),
      run(["clean-extraction"], [trial({})], stamped({}))
    ];
    expect(() => aggregateCampaign(runs)).not.toThrow();
    expect(aggregateCampaign(runs).runs).toBe(2);
  });

  it("treats runs missing BOTH fields as one legacy group and still aggregates", () => {
    // env() carries neither protocolId nor suiteHash — the pre-stage-1 shape.
    const runs = [
      run(["clean-extraction"], [trial({})], env()),
      run(["clean-extraction"], [trial({})], env())
    ];
    const report = aggregateCampaign(runs);
    expect(report.runs).toBe(2);
  });
});

describe("Phase-1 results.json backward compatibility (regression)", () => {
  // repo root, from packages/agent/src/reliability/
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const load = (rel: string): BenchmarkResults =>
    BenchmarkResultsSchema.parse(JSON.parse(readFileSync(path.join(ROOT, rel), "utf8")));

  it("aggregates two real Phase-1 runs to the labels committed in the report", () => {
    // These files predate repairMode/protocolId/suiteHash; parsing them proves the
    // new optional fields keep committed evidence valid, and the aggregator must
    // still produce their existing configuration labels.
    const cCold = load("evidence/phase1/runs/C-cold-1/results.json");
    const dCold = load("evidence/phase1/runs/D-cold-1/results.json");
    expect(cCold.environment.repairMode).toBeUndefined();

    const report = aggregateCampaign([cCold, dCold]);
    const labels = new Set(report.configTotals.map((t) => t.configuration));
    expect(labels).toEqual(new Set(["C-hybrid-repair-cold", "D-full-semantic"]));

    // The committed campaign report carries these exact labels.
    const committed = JSON.parse(
      readFileSync(path.join(ROOT, "evidence/phase1/report/campaign-report.json"), "utf8")
    ) as { configTotals: { configuration: string }[] };
    const committedLabels = new Set(committed.configTotals.map((t) => t.configuration));
    for (const label of labels) expect(committedLabels.has(label)).toBe(true);
  });
});
