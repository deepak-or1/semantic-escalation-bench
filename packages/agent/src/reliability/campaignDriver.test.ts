import { describe, expect, it } from "vitest";
import type { BenchmarkResults, EngineName, TrialResult } from "@ssda/shared";
import type { BenchmarkRunConfig } from "./runner";
import { trialCostUsd } from "./prices";
import {
  CAMPAIGN_BUDGET_THRESHOLD_USD,
  CampaignStateSchema,
  assertStateMatches,
  buildSchedule,
  initCampaignState,
  nextEntry,
  policyRunConfig,
  runCampaign,
  shouldStop,
  trialCost,
  type CampaignDeps,
  type CampaignEntry,
  type CampaignEntryState,
  type CampaignState,
  type EntryRunContext
} from "./campaignDriver";

const HAIKU = "anthropic/claude-haiku-4-5";

// ── buildSchedule ─────────────────────────────────────────────────────────────

describe("buildSchedule", () => {
  it("keyless: 15 entries — [A,B,B2] per sweep for sweeps 1..5, in order", () => {
    const s = buildSchedule("keyless");
    expect(s).toHaveLength(15);
    expect(s.map((e) => ({ sweep: e.sweep, policy: e.policy }))).toEqual([
      { sweep: 1, policy: "A" }, { sweep: 1, policy: "B" }, { sweep: 1, policy: "B2" },
      { sweep: 2, policy: "A" }, { sweep: 2, policy: "B" }, { sweep: 2, policy: "B2" },
      { sweep: 3, policy: "A" }, { sweep: 3, policy: "B" }, { sweep: 3, policy: "B2" },
      { sweep: 4, policy: "A" }, { sweep: 4, policy: "B" }, { sweep: 4, policy: "B2" },
      { sweep: 5, policy: "A" }, { sweep: 5, policy: "B" }, { sweep: 5, policy: "B2" }
    ]);
    expect(s.map((e) => e.ordinal)).toEqual([...Array(15).keys()]);
    expect(s.every((e) => e.phase === "keyless")).toBe(true);
  });

  it("keyed: 10 entries — the frozen ABBA counterbalanced sequence (§7), literally", () => {
    const s = buildSchedule("keyed");
    expect(s).toHaveLength(10);
    expect(s.map((e) => ({ sweep: e.sweep, policy: e.policy }))).toEqual([
      { sweep: 1, policy: "C" }, { sweep: 1, policy: "D" }, // sweep 1: C then D
      { sweep: 2, policy: "D" }, { sweep: 2, policy: "C" }, // sweep 2: D then C
      { sweep: 3, policy: "C" }, { sweep: 3, policy: "D" }, // sweep 3: C then D
      { sweep: 4, policy: "D" }, { sweep: 4, policy: "C" }, // sweep 4: D then C
      { sweep: 5, policy: "C" }, { sweep: 5, policy: "D" }  // sweep 5: C then D
    ]);
    expect(s.map((e) => e.ordinal)).toEqual([...Array(10).keys()]);
    expect(s.every((e) => e.phase === "keyed")).toBe(true);
  });
});

// ── policyRunConfig ───────────────────────────────────────────────────────────

describe("policyRunConfig", () => {
  it("maps each policy to its frozen engine + repair dispatch (§1)", () => {
    expect(policyRunConfig("A")).toEqual({ engines: ["baseline"], repairMode: "off" });
    expect(policyRunConfig("B")).toEqual({ engines: ["hybrid"], repairMode: "off" });
    expect(policyRunConfig("B2")).toEqual({ engines: ["hybrid"], repairMode: "deterministic" });
    expect(policyRunConfig("C")).toEqual({ engines: ["hybrid"], repairMode: "llm" });
    expect(policyRunConfig("D")).toEqual({ engines: ["stagehand"], repairMode: "llm" });
  });
});

// ── nextEntry ─────────────────────────────────────────────────────────────────

function entryState(e: CampaignEntry, status: CampaignEntryState["status"], reruns = 0): CampaignEntryState {
  return {
    phase: e.phase,
    sweep: e.sweep,
    policy: e.policy,
    status,
    benchId: `bench-${e.ordinal}`,
    dir: `runs/x/${e.ordinal}`,
    costUsd: 0,
    completedTrials: status === "complete" ? 24 : 0,
    reruns
  };
}

function stateWith(entries: CampaignEntryState[]): CampaignState {
  return { ...initCampaignState("phase2a-v1", "hash"), entries };
}

describe("nextEntry", () => {
  const keyless = buildSchedule("keyless");
  /** Bounds-safe schedule accessor (noUncheckedIndexedAccess). */
  const at = (i: number): CampaignEntry => {
    const e = keyless[i];
    if (!e) throw new Error(`schedule index ${i} out of bounds`);
    return e;
  };

  it("fresh state → the first schedule entry", () => {
    expect(nextEntry(stateWith([]), keyless)).toEqual(at(0));
  });

  it("mid-campaign resume → the first entry not yet complete", () => {
    const done = [0, 1, 2].map((i) => entryState(at(i), "complete"));
    expect(nextEntry(stateWith(done), keyless)).toEqual(at(3));
  });

  it("all complete → null (campaign done)", () => {
    const done = keyless.map((e) => entryState(e, "complete"));
    expect(nextEntry(stateWith(done), keyless)).toBeNull();
  });

  it("out-of-order recorded entries → throws", () => {
    // Position 0 records B where the schedule expects A.
    const bad = [entryState(at(1), "complete")]; // at(1) = sweep1 B
    expect(() => nextEntry(stateWith(bad), keyless)).toThrow(/out-of-order or unknown entry/);
  });

  it("a crashed entry with reruns 0 is re-runnable (returned again)", () => {
    const entries = [
      entryState(at(0), "complete"),
      entryState(at(1), "complete"),
      entryState(at(2), "crashed", 0)
    ];
    expect(nextEntry(stateWith(entries), keyless)).toEqual(at(2));
  });

  it("a crashed entry that crashed AGAIN (reruns 1) → throws (no silent third attempt)", () => {
    const entries = [
      entryState(at(0), "complete"),
      entryState(at(1), "complete"),
      entryState(at(2), "crashed", 1)
    ];
    expect(() => nextEntry(stateWith(entries), keyless)).toThrow(/crashed again after its one permitted rerun/);
  });
});

// ── shouldStop + frozen threshold ─────────────────────────────────────────────

describe("shouldStop and the frozen threshold", () => {
  it("the threshold constant is exactly 39.9", () => {
    expect(CAMPAIGN_BUDGET_THRESHOLD_USD).toBe(39.9);
  });

  it("spend below threshold → undefined", () => {
    expect(shouldStop({ spendUsd: 39.8999 })).toBeUndefined();
  });

  it("spend at or above threshold → a reason string mentioning the threshold and spend to 4 dp", () => {
    const atReason = shouldStop({ spendUsd: 39.9 });
    expect(atReason).toBeDefined();
    expect(atReason).toContain("39.90");
    expect(atReason).toContain("39.9000");

    const overReason = shouldStop({ spendUsd: 41.23456 });
    expect(overReason).toContain("41.2346"); // 4-dp rounding of current spend
  });
});

// ── trialCost ─────────────────────────────────────────────────────────────────

function tokTrial(tokens: TrialResult["tokens"]): Pick<TrialResult, "tokens"> {
  return { tokens };
}

describe("trialCost", () => {
  it("baseline → 0 regardless of tokens", () => {
    expect(trialCost(tokTrial({ llmCalls: 3, inputTokens: 1e6, outputTokens: 1e6 }), "baseline", HAIKU)).toBe(0);
  });

  it("hybrid keyless (llmCalls 0) → 0 (a real, priced zero)", () => {
    expect(trialCost(tokTrial({ llmCalls: 0 }), "hybrid", HAIKU)).toBe(0);
    // Even with no model recorded (keyless), zero inference stays $0.
    expect(trialCost(tokTrial({ llmCalls: 0 }), "hybrid", null)).toBe(0);
  });

  it("priced tokens → matches trialCostUsd exactly", () => {
    const tokens = { llmCalls: 4, inputTokens: 200_000, outputTokens: 40_000 };
    expect(trialCost(tokTrial(tokens), "hybrid", HAIKU)).toBe(trialCostUsd(tokens, HAIKU));
  });

  it("unpriceable (llmCalls > 0 but no priceable tokens/model) → null", () => {
    // Unknown model with real calls: trialCostUsd is null and llmCalls > 0 → UNPRICEABLE.
    expect(trialCost(tokTrial({ llmCalls: 2, inputTokens: 100, outputTokens: 100 }), "stagehand", "openai/gpt-unknown")).toBeNull();
    // Missing a token side with real calls → also unpriceable.
    expect(trialCost(tokTrial({ llmCalls: 2, inputTokens: 100 }), "hybrid", HAIKU)).toBeNull();
  });

  it("null tokens with no calls → 0 (unknown usage, no inference recorded)", () => {
    expect(trialCost({ tokens: null }, "hybrid", HAIKU)).toBe(0);
  });
});

// ── state schema round-trip ───────────────────────────────────────────────────

describe("CampaignStateSchema", () => {
  it("round-trips a valid state through JSON", () => {
    const state = initCampaignState("phase2a-v1", "abc123");
    state.spendUsd = 12.5;
    state.entries.push({
      phase: "keyed", sweep: 1, policy: "C", status: "complete",
      benchId: "b", dir: "runs/x", costUsd: 12.5, completedTrials: 24, reruns: 0
    });
    const parsed = CampaignStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(parsed).toEqual(state);
  });

  it("rejects a corrupted state (wrong version literal)", () => {
    const state = initCampaignState("phase2a-v1", "abc");
    const corrupt = { ...state, version: 2 };
    expect(CampaignStateSchema.safeParse(corrupt).success).toBe(false);
  });

  it("rejects a corrupted state (negative spend)", () => {
    const state = initCampaignState("phase2a-v1", "abc");
    expect(CampaignStateSchema.safeParse({ ...state, spendUsd: -1 }).success).toBe(false);
  });
});

// ── simulated campaign (injected runner drives the budget hooks) ───────────────

/** A priced trial whose cost under the pinned Haiku table is exactly `costUsd`. */
function pricedTrial(scenarioId: string, engine: EngineName, costUsd: number): TrialResult {
  return {
    scenarioId,
    engine,
    trial: 1,
    runId: `${scenarioId}-${engine}-t1`,
    outcome: "pass",
    outcomeReason: "success",
    outcomeClass: "pass",
    pipelineSuccess: true,
    extractionSuccess: true,
    validationSuccess: true,
    accuracy: { overall: 1 },
    durationMs: 1,
    retries: 0,
    recoveredAfterFailure: false,
    artifactsDir: "runs/x",
    // (inputTokens·1 + 0·5)/1e6 = inputTokens/1e6 → set inputTokens = costUsd·1e6.
    tokens: { llmCalls: 1, inputTokens: Math.round(costUsd * 1e6), outputTokens: 0 }
  };
}

/**
 * A runBenchmark-like stub: for one entry it walks `perTrialCosts`, calling
 * beforeTrial before each synthetic trial and afterTrial after each recorded one,
 * exactly as the real runner does — so the budget hooks are exercised end to end.
 */
function stubRunner(perTrialCosts: number[]): (config: BenchmarkRunConfig) => Promise<BenchmarkResults> {
  return async (config) => {
    const engine = config.engines[0]!; // policyRunConfig always supplies one engine
    const trials: TrialResult[] = [];
    let stopped: BenchmarkResults["stopped"];
    for (let i = 0; i < perTrialCosts.length; i++) {
      const decision = await config.hooks?.beforeTrial?.({
        scenarioId: `s${i}`,
        engine,
        trial: 1,
        completed: trials.length,
        total: perTrialCosts.length
      });
      if (decision) {
        stopped = { reason: decision.stop, completedTrials: trials.length, plannedTrials: perTrialCosts.length };
        break;
      }
      const record = pricedTrial(`s${i}`, engine, perTrialCosts[i]!);
      trials.push(record);
      await config.hooks?.afterTrial?.(record);
    }
    return { benchId: config.benchId, trials, ...(stopped ? { stopped } : {}) } as unknown as BenchmarkResults;
  };
}

function fakePrepareRun(entry: CampaignEntry): Promise<EntryRunContext> {
  return Promise.resolve({
    labUrl: "http://stub",
    benchDir: `runs/x/${entry.ordinal}`,
    benchId: `bench-${entry.ordinal}`,
    dispose: async () => {}
  });
}

describe("runCampaign — the budget stop (§7)", () => {
  it("stops at exactly the first trial after cumulative spend crosses 39.9; state marked stopped; spend = sum of completed", async () => {
    const state = initCampaignState("phase2a-v1", "hash");
    const persisted: number[] = [];
    // Within the first entry (keyed sweep-1 C, hybrid): trials cost 20, 20, 20.
    // t1 runs (spend 20 < 39.9), t2 runs (spend 40 — the disclosed overshoot),
    // t3's pre-trial check sees 40 ≥ 39.9 and STOPS. 2 completed, spend 40.
    const outcome = await runCampaign(state, {
      schedule: buildSchedule("keyed"),
      scenarios: [],
      model: HAIKU,
      headless: true,
      runBenchmark: stubRunner([20, 20, 20]),
      prepareRun: fakePrepareRun,
      persist: async (s) => { persisted.push(s.spendUsd); }
    });

    expect(outcome.kind).toBe("stopped");
    expect(state.spendUsd).toBe(40);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.status).toBe("stopped");
    expect(state.entries[0]!.completedTrials).toBe(2);
    expect(state.entries[0]!.costUsd).toBe(40);
    expect(state.stoppedReason).toBeDefined();
    // Persisted after every trial (2) plus the entry record and the stopped mark.
    expect(persisted.filter((v) => v === 20)).toHaveLength(1);
    expect(persisted.filter((v) => v === 40).length).toBeGreaterThanOrEqual(1);
  });

  it("runs the whole schedule to completion when spend never crosses the threshold", async () => {
    const state = initCampaignState("phase2a-v1", "hash");
    const outcome = await runCampaign(state, {
      schedule: buildSchedule("keyed"),
      scenarios: [],
      model: HAIKU,
      headless: true,
      runBenchmark: stubRunner([0.001]), // one cheap trial per entry
      prepareRun: fakePrepareRun,
      persist: async () => {}
    });
    expect(outcome.kind).toBe("complete");
    expect(state.entries).toHaveLength(10);
    expect(state.entries.every((e) => e.status === "complete")).toBe(true);
    expect(state.stoppedReason).toBeUndefined();
    expect(state.spendUsd).toBeCloseTo(0.01, 10);
  });

  it("an UNPRICEABLE keyed trial crashes the entry (fatal), preserving spend so far", async () => {
    const state = initCampaignState("phase2a-v1", "hash");
    // Unknown model → a keyed trial with real calls is unpriceable → afterTrial throws.
    const outcome = await runCampaign(state, {
      schedule: buildSchedule("keyed"),
      scenarios: [],
      model: "openai/gpt-unknown",
      headless: true,
      runBenchmark: stubRunner([5]),
      prepareRun: fakePrepareRun,
      persist: async () => {}
    });
    expect(outcome.kind).toBe("crashed");
    if (outcome.kind === "crashed") expect(outcome.error.message).toContain("UNPRICEABLE");
    expect(state.entries[0]!.status).toBe("crashed");
    expect(state.spendUsd).toBe(0); // nothing was priced, so nothing was added
  });
});

// ── FIX 1: prepareRun failure is caught inside runCampaign ─────────────────────

describe("runCampaign — prepareRun failure (FIX 1)", () => {
  it("records the entry as crashed (empty benchId/dir), allows one rerun, and never leaks a lab at the runCampaign layer", async () => {
    const state = initCampaignState("phase2a-v1", "hash");
    let prepareCalls = 0;
    let disposeCalls = 0;
    // First prepareRun throws (a lab spawn race / waitUntilReady timeout / createRunDir
    // error). The driver never receives a ctx on that path, so it disposes nothing — a
    // successful prepare disposes exactly once. Subsequent prepares succeed.
    const failingThenOk: CampaignDeps["prepareRun"] = async (entry) => {
      prepareCalls++;
      if (prepareCalls === 1) throw new Error("lab spawn race: waitUntilReady timed out");
      return {
        labUrl: "http://stub",
        benchDir: `runs/x/${entry.ordinal}`,
        benchId: `bench-${entry.ordinal}`,
        dispose: async () => {
          disposeCalls++;
        }
      };
    };
    const deps = (): CampaignDeps => ({
      schedule: buildSchedule("keyed"),
      scenarios: [],
      model: HAIKU,
      headless: true,
      runBenchmark: stubRunner([0.001]),
      prepareRun: failingThenOk,
      persist: async () => {}
    });

    // First attempt: prepareRun threw → crashed outcome, entry recorded crashed.
    const outcome = await runCampaign(state, deps());
    expect(outcome.kind).toBe("crashed");
    expect(prepareCalls).toBe(1);
    expect(disposeCalls).toBe(0); // no ctx reached the driver → nothing disposed (no leak)
    expect(state.entries).toHaveLength(1);
    const crashed = state.entries[0]!;
    expect(crashed.status).toBe("crashed");
    expect(crashed.benchId).toBe(""); // benchId/dir default to empty when prepareRun fails
    expect(crashed.dir).toBe("");
    expect(crashed.costUsd).toBe(0);
    expect(crashed.completedTrials).toBe(0);
    expect(crashed.reruns).toBe(0);

    // Rerun-once rule: the crashed entry (reruns 0) is re-runnable. A second run retries
    // it; this time prepareRun succeeds and the whole schedule completes.
    const outcome2 = await runCampaign(state, deps());
    expect(outcome2.kind).toBe("complete");
    const entry0 = state.entries[0]!;
    expect(entry0.status).toBe("complete");
    expect(entry0.reruns).toBe(1); // exactly one rerun after the crash
    // No leak / no double-dispose: every prepare EXCEPT the one failure disposed once.
    expect(disposeCalls).toBe(prepareCalls - 1);
  });
});

// ── FIX 2: crash-rerun ledger reconciliation ──────────────────────────────────

describe("runCampaign — crash-rerun ledger reconciliation (FIX 2)", () => {
  it("accumulates crashed-attempt spend into the reran entry so sum(entries.costUsd) === spendUsd exactly", async () => {
    const state = initCampaignState("phase2a-v1", "hash");
    // $0.25/trial keeps every partial sum a multiple of 1/4 → exact float equality.
    let attempt = 0;
    const runBenchmark: CampaignDeps["runBenchmark"] = async (config) => {
      attempt++;
      const engine = config.engines[0]!;
      const trials: TrialResult[] = [];
      const drive = async (perTrial: number[], thenThrow: boolean): Promise<BenchmarkResults> => {
        for (const cost of perTrial) {
          await config.hooks?.beforeTrial?.({
            scenarioId: "s",
            engine,
            trial: 1,
            completed: trials.length,
            total: perTrial.length
          });
          const rec = pricedTrial(`${engine}-${attempt}-${trials.length}`, engine, cost);
          trials.push(rec);
          await config.hooks?.afterTrial?.(rec);
        }
        if (thenThrow) throw new Error("simulated mid-entry crash after 2 trials");
        return { benchId: config.benchId, trials } as unknown as BenchmarkResults;
      };
      // Attempt 1 = the first run of entry-0: two $0.25 trials, then crash.
      if (attempt === 1) return drive([0.25, 0.25], true);
      // Attempt 2 = the rerun of entry-0: three $0.25 trials to completion.
      if (attempt === 2) return drive([0.25, 0.25, 0.25], false);
      // Attempts 3.. = the remaining schedule entries: one $0.25 trial each.
      return drive([0.25], false);
    };
    const deps: CampaignDeps = {
      schedule: buildSchedule("keyed"),
      scenarios: [],
      model: HAIKU,
      headless: true,
      runBenchmark,
      prepareRun: fakePrepareRun,
      persist: async () => {}
    };

    const out1 = await runCampaign(state, deps);
    expect(out1.kind).toBe("crashed");
    expect(state.entries[0]!.status).toBe("crashed");
    expect(state.entries[0]!.costUsd).toBe(0.5); // 2 × $0.25
    expect(state.entries[0]!.completedTrials).toBe(2);
    expect(state.spendUsd).toBe(0.5);

    const out2 = await runCampaign(state, deps);
    expect(out2.kind).toBe("complete");
    const entry0 = state.entries[0]!;
    expect(entry0.status).toBe("complete");
    expect(entry0.reruns).toBe(1);
    expect(entry0.costUsd).toBe(1.25); // attempt1 ($0.50) + attempt2 ($0.75), ACCUMULATED
    expect(entry0.completedTrials).toBe(5); // 2 + 3, accumulated
    // Ledger reconciliation: sum over entries === cumulative spend, EXACTLY.
    const sum = state.entries.reduce((acc, e) => acc + e.costUsd, 0);
    expect(sum).toBe(state.spendUsd);
    expect(state.spendUsd).toBe(3.5); // 0.5 + 0.75 + 9 × 0.25
  });
});

// ── FIX 3: stopped-resume must not clobber the preserved record ────────────────

describe("runCampaign — resume of a budget-stopped campaign (FIX 3)", () => {
  it("returns the budget stop without preparing anything or touching the preserved stopped record", async () => {
    const state = initCampaignState("phase2a-v1", "hash");
    state.spendUsd = 40; // already over the frozen threshold
    const stoppedEntry: CampaignEntryState = {
      phase: "keyed",
      sweep: 1,
      policy: "C", // schedule[0] for keyed
      status: "stopped",
      benchId: "bench-orig",
      dir: "runs/orig/0",
      costUsd: 40,
      completedTrials: 2,
      reruns: 0
    };
    state.entries.push(stoppedEntry);
    state.stoppedReason = "budget stop (original reason preserved)";
    const before = JSON.parse(JSON.stringify(state.entries)); // byte-for-byte snapshot

    let prepareCalls = 0;
    const outcome = await runCampaign(state, {
      schedule: buildSchedule("keyed"),
      scenarios: [],
      model: HAIKU,
      headless: true,
      runBenchmark: stubRunner([0.001]),
      prepareRun: async (e) => {
        prepareCalls++;
        return fakePrepareRun(e);
      },
      persist: async () => {}
    });

    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") {
      expect(outcome.reason).toBe("budget stop (original reason preserved)"); // preserved, not recomputed
      expect(outcome.entry.policy).toBe("C"); // the stopped position
    }
    expect(prepareCalls).toBe(0); // nothing was prepared or spawned
    expect(state.entries).toHaveLength(1);
    expect(state.entries).toEqual(before); // stopped record byte-for-byte untouched
    expect(state.stoppedReason).toBe("budget stop (original reason preserved)");
  });

  it("short-circuits a fresh campaign whose prior spend already exceeds the threshold (sets stoppedReason, no entry)", async () => {
    const state = initCampaignState("phase2a-v1", "hash");
    state.spendUsd = 45; // over threshold before any entry ran
    let prepareCalls = 0;
    const outcome = await runCampaign(state, {
      schedule: buildSchedule("keyed"),
      scenarios: [],
      model: HAIKU,
      headless: true,
      runBenchmark: stubRunner([0.001]),
      prepareRun: async (e) => {
        prepareCalls++;
        return fakePrepareRun(e);
      },
      persist: async () => {}
    });
    expect(outcome.kind).toBe("stopped");
    expect(prepareCalls).toBe(0);
    expect(state.entries).toHaveLength(0); // no entry record created
    expect(state.stoppedReason).toBeDefined(); // set from shouldStop
    if (outcome.kind === "stopped") expect(outcome.entry.ordinal).toBe(0); // first schedule position
  });
});

// ── FIX 5: per-phase state files (assertStateMatches) ──────────────────────────

describe("assertStateMatches (FIX 5 — per-phase state files)", () => {
  const provenance = { protocolId: "phase2a-v1", suiteHash: "hash" };

  it("accepts a state whose entries all match the requested phase", () => {
    const state = stateWith(buildSchedule("keyless").slice(0, 3).map((e) => entryState(e, "complete")));
    expect(() => assertStateMatches(state, provenance, "keyless")).not.toThrow();
  });

  it("accepts a fresh (empty) state for either phase", () => {
    expect(() => assertStateMatches(stateWith([]), provenance, "keyed")).not.toThrow();
    expect(() => assertStateMatches(stateWith([]), provenance, "keyless")).not.toThrow();
  });

  it("REFUSES a keyless-populated state loaded under --phase keyed (names both phases + the per-phase file)", () => {
    const state = stateWith(buildSchedule("keyless").slice(0, 2).map((e) => entryState(e, "complete")));
    expect(() => assertStateMatches(state, provenance, "keyed")).toThrow(/keyless/);
    expect(() => assertStateMatches(state, provenance, "keyed")).toThrow(/keyed/);
    expect(() => assertStateMatches(state, provenance, "keyed")).toThrow(/campaign-state\.keyed\.json/);
  });

  it("REFUSES a state from a different suite (provenance mismatch)", () => {
    expect(() =>
      assertStateMatches(stateWith([]), { protocolId: "other-protocol", suiteHash: "hash" }, "keyless")
    ).toThrow(/different suite/);
  });
});
