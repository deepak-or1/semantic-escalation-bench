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
import { verifySuite, type ExpectGrid } from "../../scripts/verify-suite";

/**
 * Deliverable-4 tests (PROTOCOL_2A §5 item 5) over small synthetic results
 * fixtures. No lab, no browser — pure verification-core exercise. Beyond the
 * happy-path checks (a judged failure passes; tampered grading, a missing sweep,
 * a schema failure, and a prediction miss behave), this file carries the
 * ADVERSARIAL regression suite that closes the external auditor's exploit: every
 * "adversarial" test below MUST fail the verifier for the stated reason.
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

/** A pass trial numbered `n` (distinct trial index + runId) within one run. */
function passTrialN(scenarioId: string, n: number): TrialResult {
  return { ...passTrial(scenarioId), trial: n, runId: `${scenarioId}-baseline-t${n}` };
}

/** A pass trial on the hybrid engine (labelled by configurationLabel from env). */
function hybridTrial(scenarioId: string): TrialResult {
  return { ...passTrial(scenarioId), engine: "hybrid", runId: `${scenarioId}-hybrid-t1` };
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
  suiteHash: string,
  opts?: {
    benchId?: string;
    createdAt?: string;
    env?: Partial<BenchmarkResults["environment"]>;
    stopped?: BenchmarkResults["stopped"];
  }
): BenchmarkResults {
  const benchId = opts?.benchId ?? "bench";
  // Mirror the runner: every trial's artifacts live under runs/<benchId>/..., so the
  // artifactsDir embeds the run's own benchId (the internal-consistency invariant the
  // verifier's c.6 check relies on). Stamping it here means a valid fixture is always
  // self-consistent, and a copy that edits ONLY benchId (test g) is not.
  const stampedTrials = trials.map((t) => ({ ...t, artifactsDir: `runs/${benchId}/trials/${t.runId}` }));
  const engineNames = [...new Set(stampedTrials.map((t) => t.engine))];
  const engines = engineNames.map((e) => summarizeEngine(e, stampedTrials.filter((t) => t.engine === e)));
  const comparison = buildComparison(scenarios, stampedTrials, engineNames, []);
  return BenchmarkResultsSchema.parse({
    benchId,
    createdAt: opts?.createdAt ?? "2026-07-20T00:00:00.000Z",
    labUrl: "http://127.0.0.1:0",
    trialsPerScenario: 1,
    scenarios,
    trials: stampedTrials,
    engines,
    comparison,
    ...(opts?.stopped ? { stopped: opts.stopped } : {}),
    environment: { ...env(suiteHash), ...(opts?.env ?? {}) }
  });
}

/** The expect-grid every valid single-baseline run in this file certifies against. */
const EXPECT_A1: ExpectGrid = { policies: ["A"], trials: 1 };

describe("verifySuite", () => {
  it("passes a run whose trials include a JUDGED FAILURE (a policy failure is never a verifier failure)", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    const results = makeResults(scenarios, [failTrial("s1"), passTrial("s2")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["A"], trials: 1 });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails GRADING when a recorded outcomeClass is tampered (pass recorded, recomputes silent-corruption)", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    // Same silent-corruption trial, but its class is falsified to "pass".
    const tampered: TrialResult = { ...failTrial("s1"), outcomeClass: "pass" };
    const results = makeResults(scenarios, [tampered, passTrial("s2")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["A"], trials: 1 });
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.check === "grading" && /outcomeClass/.test(v.message))).toBe(true);
  });

  it("fails COMPLETENESS when a scenario sweep is missing for a configuration", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    // Only s1 is present for A-baseline; s2 sweep is missing.
    const results = makeResults(scenarios, [passTrial("s1")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["A"], trials: 1 });
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) => v.check === "completeness" && /scenario "s2": got 0 trial\(s\), want 1/.test(v.message))
    ).toBe(true);
  });

  it("scores a prediction MISS report-only and still exits zero", () => {
    // s1 predicts A all-pass, but A (baseline) is observed failing → a miss.
    const suite = loadSuite(["s1"], "all-pass");
    const scenarios = [scenario("s1", 2201)];
    const results = makeResults(scenarios, [failTrial("s1")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(true); // gates a–d all clean
    const miss = report.predictions.find((p) => p.scenarioId === "s1" && p.policy === "A");
    expect(miss?.status).toBe("miss");
  });

  it("fails SCHEMA when results.json does not validate", () => {
    const suite = loadSuite(["s1"]);
    const report = verifySuite([{ source: "bad", raw: { not: "a benchmark" } }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.check === "schema")).toBe(true);
  });

  it("a stopped run yields a NOTE (never a violation) AND the expected completeness violations", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    // A budget-stopped run: only s1 ran before the pre-trial stop halted it; s2's
    // sweep is missing from the grid. The stop is recorded on results.stopped.
    const results = makeResults(scenarios, [passTrial("s1")], suite.suiteHash, {
      stopped: {
        reason: "budget stop (PROTOCOL_2A §7): recorded model-inference spend $40.0000 reached the operational threshold $39.90 (checked pre-trial)",
        completedTrials: 1,
        plannedTrials: 2
      }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);

    // The stopped note is present and is NOT a violation.
    expect(
      report.notes.some((nn) => /run-a: run is marked stopped .* incomplete campaign evidence/.test(nn))
    ).toBe(true);
    // Completeness still catches the shortfall: s2's A-baseline sweep is missing.
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) => v.check === "completeness" && /scenario "s2": got 0 trial\(s\), want 1/.test(v.message)
      )
    ).toBe(true);
    // No violation is a "stopped" type — it stays report-only.
    expect(report.violations.every((v) => !/marked stopped/.test(v.message))).toBe(true);
  });

  // ── Adversarial regression suite (closes the external auditor's exploit) ──────

  it("adversarial (a): THE AUDITOR'S EXPLOIT — one N=1 baseline run against a five-policy expect-grid is rejected", () => {
    // NAMED REGRESSION for the auditor's exploit: a synthetic "campaign" of ONE
    // baseline run (N=1) with four of five policies absent, and a run-local oracle
    // that contradicts the supplied suite, previously returned ok:true. It must not.
    const suite = loadSuite(["s1", "s2"]);
    // The run's recorded oracle for s1 CONTRADICTS the suite (different seed AND
    // expected); s2 is recorded faithfully.
    const contradictS1: ScenarioSpec = {
      id: "s1",
      name: "s1",
      description: "s1",
      chaos: [],
      seed: 9999,
      session: "fresh",
      expected: "validation-failure",
      group: "core"
    };
    const scenarios = [contradictS1, scenario("s2", 2202)];
    const results = makeResults(scenarios, [passTrial("s1"), passTrial("s2")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, {
      policies: ["A", "B", "B2", "C", "D"],
      trials: 5
    });
    expect(report.ok).toBe(false);

    // (i) ONE aggregated no-trials violation per absent policy — never one per scenario.
    for (const p of ["B", "B2", "C", "D"]) {
      const matches = report.violations.filter(
        (v) => v.check === "completeness" && new RegExp(`^policy ${p} \\(.*no trials for any suite scenario`).test(v.message)
      );
      expect(matches.length).toBe(1);
    }
    // (ii) a trial-count violation for the A cells (got 1, want 5).
    expect(
      report.violations.some((v) => v.check === "completeness" && /policy A \(.*got 1 trial\(s\), want 5/.test(v.message))
    ).toBe(true);
    // (iii) the run's recorded oracle diverges from the supplied suite → grading violation.
    expect(report.violations.some((v) => v.check === "grading" && /diverges from the supplied suite/.test(v.message))).toBe(
      true
    );
  });

  it("adversarial (b): the same run passed twice is a duplicate-benchId AND identical-trial-content violation", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    const results = makeResults(scenarios, [passTrial("s1"), passTrial("s2")], suite.suiteHash);
    const report = verifySuite(
      [
        { source: "run-a", raw: results },
        { source: "run-b", raw: results }
      ],
      suite,
      EXPECT_A1
    );
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.check === "completeness" && /duplicate benchId/.test(v.message))).toBe(true);
    // The content check now hashes TRIAL CONTENT (not raw JSON) and names both sources.
    expect(
      report.violations.some(
        (v) => v.check === "completeness" && /identical trial content/.test(v.message) && /"run-a"/.test(v.message) && /"run-b"/.test(v.message)
      )
    ).toBe(true);
  });

  it("adversarial (c): 5 trials from ONE run is not 5 distinct sweeps", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    const trials: TrialResult[] = [];
    for (const id of ["s1", "s2"]) for (let k = 1; k <= 5; k++) trials.push(passTrialN(id, k));
    // One run (single benchId) carrying trials 1..5 per scenario.
    const results = makeResults(scenarios, trials, suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["A"], trials: 5 });
    expect(report.ok).toBe(false);
    // The cell counts are correct (5 each) but they come from 1 distinct run.
    expect(report.violations.some((v) => v.check === "completeness" && /distinct run/.test(v.message))).toBe(true);
  });

  it("adversarial (d): a hybrid-keyless run presented under expect [C] is rejected", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    // modelProvider null + repairMode llm (no disableRepair) → configurationLabel "hybrid-keyless".
    const results = makeResults(scenarios, [hybridTrial("s1"), hybridTrial("s2")], suite.suiteHash, {
      env: { repairMode: "llm" }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["C"], trials: 1 });
    expect(report.ok).toBe(false);
    // hybrid-keyless is the image of NO policy → unexpected configuration.
    expect(
      report.violations.some((v) => v.check === "completeness" && /unexpected configuration "hybrid-keyless"/.test(v.message))
    ).toBe(true);
    // C itself never ran → aggregated no-trials.
    expect(
      report.violations.some((v) => v.check === "completeness" && /policy C \(.*no trials for any suite scenario/.test(v.message))
    ).toBe(true);
  });

  it("adversarial (e): a run self-consistent with its OWN oracle but not the suite fails GRADING (the oracle is the suite's)", () => {
    const suite = loadSuite(["s1"]); // the suite oracle: expected success, seed 2201
    // The run records s1's oracle as expected "validation-failure" (its own, wrong oracle).
    const recorded: ScenarioSpec = {
      id: "s1",
      name: "s1",
      description: "s1",
      chaos: [],
      seed: 2201,
      session: "fresh",
      expected: "validation-failure",
      group: "core"
    };
    // A clean validation failure: judged PASS under the recorded oracle (the fields
    // below are exactly what the frozen judge/classifier emit for it), but FAIL
    // under the supplied suite's expected-success oracle.
    const trial: TrialResult = {
      ...passTrial("s1"),
      outcome: "pass",
      outcomeReason: "validation-failure: clean categorised validation failure as expected",
      outcomeClass: "safe-failure",
      pipelineSuccess: false,
      extractionSuccess: false,
      validationSuccess: false,
      accuracy: null,
      failureCategory: "validation"
    };
    const results = makeResults([recorded], [trial], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    // Grading against the SUITE oracle flips the recorded PASS to a recomputed FAIL.
    expect(
      report.violations.some((v) => v.check === "grading" && /recorded outcome "pass".*recomputed "fail"/.test(v.message))
    ).toBe(true);
    // And the recorded oracle itself is flagged as diverging from the suite.
    expect(
      report.violations.some((v) => v.check === "grading" && /diverges from the supplied suite \(expected\)/.test(v.message))
    ).toBe(true);
  });

  it("adversarial (f): POSITIVE control — a valid two-sweep mini-campaign with a judged failure passes", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    // Two DISTINCT runs, each 1 trial per scenario → 2 distinct sweeps per cell.
    // run-1's s1 trial is a genuine JUDGED FAILURE (admissible evidence, not a gate).
    const run1 = makeResults(scenarios, [failTrial("s1"), passTrial("s2")], suite.suiteHash, { benchId: "bench-1" });
    const run2 = makeResults(scenarios, [passTrial("s1"), passTrial("s2")], suite.suiteHash, { benchId: "bench-2" });
    const report = verifySuite(
      [
        { source: "run-1", raw: run1 },
        { source: "run-2", raw: run2 }
      ],
      suite,
      { policies: ["A"], trials: 2 }
    );
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    // The judged POLICY failure is present and did NOT fail the verifier.
    expect(run1.trials.some((t) => t.outcome === "fail")).toBe(true);
  });

  it("adversarial (g): a relabeled copy — one run cp'd and given a NEW benchId — is not a distinct sweep (NAMED regression for the renamed-benchId forgery audit)", () => {
    // NAMED REGRESSION for the pre-tag audit finding: two inputs byte-identical
    // EXCEPT for benchId once passed the distinct-sweep gate (distinct benchIds meant
    // the shared-benchId check stayed silent, and the old content hash covered the
    // WHOLE raw JSON including benchId, so the copy hashed differently). The
    // trial-content hash (scenarios + trials; benchId excluded by construction) now
    // catches it, and the copy's trial artifactsDirs still embed the ORIGINAL benchId
    // → the file is also self-inconsistent.
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    const original = makeResults(scenarios, [passTrial("s1"), passTrial("s2")], suite.suiteHash, { benchId: "bench-real" });
    // Deep-copy and change ONLY benchId — every other field, including each trial's
    // artifactsDir (still "runs/bench-real/..."), is untouched.
    const relabeled: BenchmarkResults = { ...structuredClone(original), benchId: "bench-copy" };
    const report = verifySuite(
      [
        { source: "run-real", raw: original },
        { source: "run-copy", raw: relabeled }
      ],
      suite,
      { policies: ["A"], trials: 2 }
    );
    expect(report.ok).toBe(false);
    // Distinct benchIds mean the shared-benchId check does NOT fire — this is the hole.
    expect(report.violations.some((v) => /duplicate benchId/.test(v.message))).toBe(false);
    // The identical-trial-content check does fire, naming BOTH sources.
    expect(
      report.violations.some(
        (v) =>
          v.check === "completeness" &&
          /identical trial content/.test(v.message) &&
          /"run-real"/.test(v.message) &&
          /"run-copy"/.test(v.message)
      )
    ).toBe(true);
    // And the copy's artifactsDirs still embed the ORIGINAL benchId → self-inconsistent.
    expect(
      report.violations.some(
        (v) => v.check === "completeness" && /run-copy: .*artifactsDir not containing the run's benchId "bench-copy"/.test(v.message)
      )
    ).toBe(true);
  });

  it("adversarial (i): a CONSISTENT-replacement copy — new benchId, new createdAt, benchId rewritten through every artifactsDir — is not a distinct sweep (NAMED regression for the consistent-replacement bypass, freeze-v2 external audit)", () => {
    // NAMED REGRESSION for the consistent-replacement bypass found by the freeze-v2
    // external audit: copy a valid results.json, change benchId AND createdAt, and
    // consistently rewrite the OLD benchId to the NEW one inside every trial's
    // artifactsDir. The forgery has distinct benchIds (shared-benchId check silent), a
    // SELF-CONSISTENT file (c.6's artifactsDir check silent — every path embeds the
    // copy's OWN benchId), and — under the OLD raw-content hash — a different hash.
    // Only the canonical hash (content normalized over run-identity strings) catches it.
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    const original = makeResults(scenarios, [passTrial("s1"), passTrial("s2")], suite.suiteHash, {
      benchId: "bench-real"
    });
    // Deep-rewrite every string field of a JSON-serializable value, replacing all
    // occurrences of `from` with `to`.
    const deepReplace = (value: unknown, from: string, to: string): unknown => {
      if (typeof value === "string") return value.split(from).join(to);
      if (Array.isArray(value)) return value.map((v) => deepReplace(v, from, to));
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepReplace(v, from, to)]));
      }
      return value;
    };
    // Consistent-replacement forgery: new benchId, a DIFFERENT createdAt, and the OLD
    // benchId rewritten to the NEW one EVERYWHERE — so every artifactsDir now embeds
    // "bench-copy" and the file is internally self-consistent.
    const clone = structuredClone(original);
    clone.benchId = "bench-copy";
    clone.createdAt = "2026-07-20T09:09:09.000Z";
    const forged = deepReplace(clone, "bench-real", "bench-copy") as BenchmarkResults;
    const report = verifySuite(
      [
        { source: "run-real", raw: original },
        { source: "run-copy", raw: forged }
      ],
      suite,
      { policies: ["A"], trials: 2 }
    );
    expect(report.ok).toBe(false);
    // Distinct benchIds → the shared-benchId check does NOT fire.
    expect(report.violations.some((v) => /duplicate benchId/.test(v.message))).toBe(false);
    // The forged file is SELF-CONSISTENT: every artifactsDir embeds its OWN benchId
    // "bench-copy", so c.6 stays silent — that is the point of this bypass, and only
    // the canonical trial-content hash catches it.
    expect(report.violations.some((v) => /artifactsDir not containing/.test(v.message))).toBe(false);
    // The canonical identical-trial-content check fires, naming BOTH sources.
    expect(
      report.violations.some(
        (v) =>
          v.check === "completeness" &&
          /identical trial content/.test(v.message) &&
          /"run-real"/.test(v.message) &&
          /"run-copy"/.test(v.message)
      )
    ).toBe(true);
  });

  it("adversarial (h): FALSE-POSITIVE control — two genuinely distinct sweeps (distinct benchIds, differing durationMs) pass", () => {
    // Two independent sweeps of the same cell differ in wall-clock durationMs (the
    // minimum by which genuine separate runs always differ), so their trial-content
    // hashes differ and the identical-trial-content check must NOT fire. Distinct
    // benchIds and distinct createdAt keep every other check clean.
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    const withDuration = (t: TrialResult, ms: number): TrialResult => ({ ...t, durationMs: ms });
    const run1 = makeResults(
      scenarios,
      [withDuration(passTrial("s1"), 100), withDuration(passTrial("s2"), 111)],
      suite.suiteHash,
      { benchId: "bench-1", createdAt: "2026-07-20T00:00:00.000Z" }
    );
    const run2 = makeResults(
      scenarios,
      [withDuration(passTrial("s1"), 137), withDuration(passTrial("s2"), 154)],
      suite.suiteHash,
      { benchId: "bench-2", createdAt: "2026-07-20T00:05:00.000Z" }
    );
    const report = verifySuite(
      [
        { source: "run-1", raw: run1 },
        { source: "run-2", raw: run2 }
      ],
      suite,
      { policies: ["A"], trials: 2 }
    );
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
