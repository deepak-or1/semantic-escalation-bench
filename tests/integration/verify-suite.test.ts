import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BenchmarkResultsSchema,
  loadScenarioSuite,
  type BenchmarkResults,
  type LoadedScenarioSuite,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import { buildComparison, summarizeEngine } from "@ssda/agent";
// The verifier core lives at the repo root; importing it never runs main().
import { verifySuite } from "../../scripts/verify-suite";

/**
 * Deliverable-4 tests (PROTOCOL_2A §5 item 5) over small synthetic results
 * fixtures. No lab, no browser — pure verification-core exercise: a judged
 * failure passes, a tampered outcomeClass fails grading, a missing sweep fails
 * completeness, and a prediction miss exits zero.
 */

const dir = mkdtempSync(path.join(tmpdir(), "ssda-verify-"));
let n = 0;

/** A held-out suite of K-stratum scenarios (no F2 scaffold needed). */
function loadSuite(scenarioIds: string[], predictionA: "all-pass" | "observed-failure" = "observed-failure"): LoadedScenarioSuite {
  const suite = {
    protocolId: "phase2a-v1",
    scenarios: scenarioIds.map((id, i) => ({
      id,
      name: id,
      description: `${id} condition`,
      chaos: [] as string[],
      seed: 2201 + i,
      session: "fresh",
      expected: "success",
      stratum: "K",
      stratumId: `header-${i + 1}`,
      predictions: {
        A: predictionA,
        B: "observed-failure",
        B2: "observed-failure",
        C: "observed-failure",
        D: "observed-failure"
      }
    }))
  };
  const file = path.join(dir, `suite-${n++}.json`);
  writeFileSync(file, JSON.stringify(suite, null, 2));
  return loadScenarioSuite(file);
}

function scenario(id: string, seed: number): ScenarioSpec {
  return { id, name: id, description: id, chaos: [], seed, session: "fresh", expected: "success", group: "core" };
}

function passTrial(scenarioId: string): TrialResult {
  return {
    scenarioId,
    engine: "baseline",
    trial: 1,
    runId: `${scenarioId}-baseline-t1`,
    outcome: "pass",
    outcomeReason: "success: pipeline succeeded (accuracy 1.00)",
    outcomeClass: "pass",
    pipelineSuccess: true,
    extractionSuccess: true,
    validationSuccess: true,
    accuracy: { overall: 1 },
    durationMs: 100,
    retries: 0,
    recoveredAfterFailure: false,
    artifactsDir: "runs/x",
    tokens: null
  };
}

/** A genuine JUDGED FAILURE with fully self-consistent recorded fields. */
function failTrial(scenarioId: string): TrialResult {
  return {
    ...passTrial(scenarioId),
    outcome: "fail",
    outcomeReason: "expected success but accuracy 1.00 required, got 0.42",
    outcomeClass: "silent-corruption",
    pipelineSuccess: true,
    accuracy: { overall: 0.42 }
  };
}

function env(suiteHash: string): BenchmarkResults["environment"] {
  return {
    node: "v20",
    modelProvider: null,
    browserbase: false,
    gitCommit: "commit0",
    gitDirty: false,
    disableRepair: false,
    seedCacheMode: "none",
    seedCacheHash: null,
    runPurpose: "cold",
    promptsHash: "P",
    lockfileHash: "L",
    protocolId: "phase2a-v1",
    suiteHash
  } as BenchmarkResults["environment"];
}

function makeResults(
  scenarios: ScenarioSpec[],
  trials: TrialResult[],
  suiteHash: string
): BenchmarkResults {
  const engineNames = [...new Set(trials.map((t) => t.engine))];
  const engines = engineNames.map((e) => summarizeEngine(e, trials.filter((t) => t.engine === e)));
  const comparison = buildComparison(scenarios, trials, engineNames, []);
  return BenchmarkResultsSchema.parse({
    benchId: "bench",
    createdAt: "2026-07-20T00:00:00.000Z",
    labUrl: "http://127.0.0.1:0",
    trialsPerScenario: 1,
    scenarios,
    trials,
    engines,
    comparison,
    environment: env(suiteHash)
  });
}

describe("verifySuite", () => {
  it("passes a run whose trials include a JUDGED FAILURE (a policy failure is never a verifier failure)", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    const results = makeResults(scenarios, [failTrial("s1"), passTrial("s2")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails GRADING when a recorded outcomeClass is tampered (pass recorded, recomputes silent-corruption)", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    // Same silent-corruption trial, but its class is falsified to "pass".
    const tampered: TrialResult = { ...failTrial("s1"), outcomeClass: "pass" };
    const results = makeResults(scenarios, [tampered, passTrial("s2")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.check === "grading" && /outcomeClass/.test(v.message))).toBe(true);
  });

  it("fails COMPLETENESS when a scenario sweep is missing for a configuration", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    // Only s1 is present for A-baseline; s2 sweep is missing.
    const results = makeResults(scenarios, [passTrial("s1")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.check === "completeness" && /missing sweep.*s2/.test(v.message))).toBe(true);
  });

  it("scores a prediction MISS report-only and still exits zero", () => {
    // s1 predicts A all-pass, but A (baseline) is observed failing → a miss.
    const suite = loadSuite(["s1"], "all-pass");
    const scenarios = [scenario("s1", 2201)];
    const results = makeResults(scenarios, [failTrial("s1")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite);
    expect(report.ok).toBe(true); // gates a–d all clean
    const miss = report.predictions.find((p) => p.scenarioId === "s1" && p.policy === "A");
    expect(miss?.status).toBe("miss");
  });

  it("fails SCHEMA when results.json does not validate", () => {
    const suite = loadSuite(["s1"]);
    const report = verifySuite([{ source: "bad", raw: { not: "a benchmark" } }], suite);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.check === "schema")).toBe(true);
  });
});
