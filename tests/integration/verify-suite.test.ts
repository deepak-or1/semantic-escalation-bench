import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BenchmarkResultsSchema,
  assessDataset,
  computeDisplayOverrides,
  generateGroundTruth,
  loadScenarioSuite,
  type BenchmarkResults,
  type ChaosFlag,
  type DisplayOverride,
  type GroundTruth,
  type LoadedScenarioSuite,
  type ScenarioSpec,
  type StepTraceEntry,
  type SuiteScenario,
  type TrialResult
} from "@ssda/shared";
import {
  buildComparison,
  buildDataset,
  checkOddsSchema,
  checkStatsSchema,
  normalizeOdds,
  normalizeStats,
  overallAccuracy,
  scoreOdds,
  scoreStats,
  summarizeEngine,
  unanimousChromeVersion
} from "@ssda/agent";
// The verifier core lives at the repo root; importing it never runs main().
import { formatReport, verifySuite, type ExpectGrid } from "../../scripts/verify-suite";

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
function loadSuite(
  scenarioIds: string[],
  predictionA: "all-pass" | "observed-failure" = "observed-failure",
  chaos: string[] = []
): LoadedScenarioSuite {
  const suite = {
    protocolId: "phase2a-v1",
    scenarios: scenarioIds.map((id, i) => ({
      id,
      name: id,
      description: `${id} condition`,
      chaos,
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

function scenario(
  id: string,
  seed: number,
  chaos: ChaosFlag[] = [],
  mode: Partial<Pick<ScenarioSpec, "expected" | "session">> = {}
): ScenarioSpec {
  return {
    id,
    name: id,
    description: id,
    chaos,
    seed,
    session: mode.session ?? "fresh",
    expected: mode.expected ?? "success",
    group: "core"
  };
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

/**
 * The RAW pre-normalization payloads a perfect extraction produces from a ground
 * truth — the page as an honest extractor read it, before anything validated it.
 * Everything the record ships downstream is derived from these by the runner's
 * own normalizers, so the fixtures below are built the way a real trial is.
 */
function rawFrom(truth: GroundTruth): { stats: { rows: unknown[] }; odds: { rows: unknown[] } } {
  return {
    stats: {
      rows: truth.teams.map((t) => ({
        team: t.name,
        played: t.played,
        wins: t.wins,
        draws: t.draws,
        losses: t.losses,
        goalsFor: t.goalsFor,
        goalsAgainst: t.goalsAgainst,
        points: t.points,
        form: t.form
      }))
    },
    odds: {
      rows: truth.markets.map((m) => ({
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        kickoff: m.kickoff,
        homeOdds: m.oneXTwo.home.toFixed(2),
        drawOdds: m.oneXTwo.draw.toFixed(2),
        awayOdds: m.oneXTwo.away.toFixed(2),
        totalsLine: String(m.totals.line),
        overOdds: m.totals.over.toFixed(2),
        underOdds: m.totals.under.toFixed(2)
      }))
    }
  };
}

/**
 * A complete `canonical` block built from raw payloads THE SAME WAY the pipeline
 * builds it: run the extraction checks, then the normalizers, then take the rows
 * and annotations they produce. A fixture assembled this way is self-consistent
 * by construction — which is what makes a hand-edited one detectable.
 */
function canonicalFromRaw(raw: {
  stats: { rows: unknown[] } | null;
  odds: { rows: unknown[] } | null;
}): NonNullable<TrialResult["canonical"]> {
  const statsCheck = checkStatsSchema(raw.stats);
  const oddsCheck = checkOddsSchema(raw.odds);
  const dataset = buildDataset({
    engine: "baseline",
    source: "http://127.0.0.1:0",
    ...(statsCheck.parsed ? { stats: normalizeStats(statsCheck.parsed) } : {}),
    ...(oddsCheck.parsed ? { odds: normalizeOdds(oddsCheck.parsed) } : {})
  });
  return {
    raw,
    stats: dataset.teams,
    odds: dataset.markets,
    failures: dataset.failures,
    warnings: dataset.warnings
  };
}

/** The canonical block of a perfect extraction of `truth`. */
function canonicalFrom(truth: GroundTruth): NonNullable<TrialResult["canonical"]> {
  return canonicalFromRaw(rawFrom(truth));
}

/**
 * The oracle the verifier RE-DERIVES for a scenario, built here the same way the
 * lab does (apps/lab/src/state.ts). A fixture that ships this is faithful; a
 * fixture that ships anything else is a forgery.
 */
function derivedOracle(seed: number, chaos: ChaosFlag[] = []): { truth: GroundTruth; overrides: DisplayOverride[] } {
  const truth = generateGroundTruth(seed);
  return { truth, overrides: computeDisplayOverrides(truth, chaos, seed) };
}

/**
 * A record-version-2 PASS trial: it ships the rows the scorer consumed, and its
 * recorded counters are produced by the runner's own scoring module from exactly
 * those rows — so a faithful record recomputes identically and a tampered row
 * cannot.
 */
function v2PassTrial(
  scenarioId: string,
  truth: GroundTruth,
  canonical = canonicalFrom(truth),
  overrides: DisplayOverride[] = []
): TrialResult {
  const stats = scoreStats(canonical.stats ?? [], truth, overrides);
  const odds = scoreOdds(canonical.odds ?? [], truth, overrides);
  const overall = overallAccuracy(stats, odds)!;
  return {
    ...passTrial(scenarioId),
    outcomeReason: `success: pipeline succeeded (accuracy ${overall.toFixed(2)})`,
    accuracy: { stats, odds, overall },
    recordVersion: 2,
    canonical
  };
}

/**
 * A record-version-2 HARD FAILURE: the pipeline died before it produced any
 * normalized dataset, so the record ships no rows for either page and claims no
 * accuracy. THE most common shape of a real failing trial — a v2 record cannot
 * recompute anything from it, and the verifier must still accept it as an
 * internally consistent record rather than treat "no rows" as tampering.
 */
function v2HardFailureTrial(scenarioId: string): TrialResult {
  return {
    ...passTrial(scenarioId),
    outcome: "fail",
    outcomeReason: "expected success but pipeline failed [navigation] stats page never rendered",
    outcomeClass: "hard-failure",
    pipelineSuccess: false,
    extractionSuccess: false,
    validationSuccess: false,
    accuracy: null,
    failureCategory: "navigation",
    failureDetail: "stats page never rendered",
    recordVersion: 2,
    canonical: {
      raw: { stats: null, odds: null },
      stats: null,
      odds: null,
      failures: [],
      warnings: []
    },
    chromeVersion: null
  };
}

/**
 * A record-version-2 record of a REAL validation failure that nonetheless scores
 * PERFECT accuracy — the corruptData scenario. The lab renders one team's `wins`
 * as played+8; an honest extractor reads it verbatim, and the domain validator
 * rejects the dataset (W+D+L ≠ played). The scorer never grades `wins`, so every
 * graded cell still matches and accuracy is 1.00. This gap between "the rows are
 * genuine" and "the pipeline succeeded" is exactly what ATTACK-BOOLFLIP exploits.
 */
function v2ValidationFailureTrial(scenarioId: string, seed: number): TrialResult {
  const { truth, overrides } = derivedOracle(seed, ["corruptData"]);
  const corruptWins = overrides.find((o) => o.page === "stats" && o.field === "wins")!;
  // The corruption is applied to the RAW page — what the lab actually displayed —
  // and everything downstream is derived from it, exactly as a real trial does.
  const raw = rawFrom(truth);
  raw.stats.rows = raw.stats.rows.map((row) => {
    const r = row as { team: string };
    return r.team === corruptWins.rowKey ? { ...r, wins: Number(corruptWins.displayed) } : r;
  });
  const canonical = canonicalFromRaw(raw);
  const assessment = assessDataset({
    teams: canonical.stats!,
    markets: canonical.odds!,
    failures: canonical.failures,
    warnings: canonical.warnings
  });
  const statsReport = scoreStats(canonical.stats!, truth, overrides);
  const oddsReport = scoreOdds(canonical.odds!, truth, overrides);
  const overall = overallAccuracy(statsReport, oddsReport)!;
  const failureDetail = assessment.failures.join(" | ");
  return {
    ...passTrial(scenarioId),
    outcome: "fail",
    outcomeReason: `expected success but pipeline failed [validation] ${failureDetail}`,
    outcomeClass: "safe-failure",
    // Extraction READ the page fine; the domain layer is what rejected it.
    pipelineSuccess: false,
    extractionSuccess: true,
    validationSuccess: false,
    accuracy: { stats: statsReport, odds: oddsReport, overall },
    failureCategory: "validation",
    failureDetail,
    recordVersion: 2,
    canonical
  };
}

/**
 * A record-version-2 record of a REAL validation failure whose ROWS ARE PERFECT.
 * The page rendered one extra, nameless row — a ghost the normalizer records as a
 * hard failure and DROPS, so all twelve real teams still score 1.00 while the
 * domain validator rejects the dataset. That gap between "the rows are genuine"
 * and "the dataset is sound" lives entirely in the failures array, which is what
 * ATTACK-FAILURE-STRIP deletes.
 */
function v2GhostRowTrial(scenarioId: string, seed: number): TrialResult {
  const truth = generateGroundTruth(seed);
  const raw = rawFrom(truth);
  raw.stats.rows = [
    ...raw.stats.rows,
    { team: "", played: 3, wins: 1, draws: 1, losses: 1, goalsFor: 2, goalsAgainst: 2, points: 4 }
  ];
  const canonical = canonicalFromRaw(raw);
  const statsReport = scoreStats(canonical.stats!, truth, []);
  const oddsReport = scoreOdds(canonical.odds!, truth, []);
  const failureDetail = canonical.failures.slice(0, 5).join(" | ");
  return {
    ...passTrial(scenarioId),
    outcome: "fail",
    outcomeReason: `expected success but pipeline failed [validation] ${failureDetail}`,
    outcomeClass: "safe-failure",
    pipelineSuccess: false,
    extractionSuccess: true,
    validationSuccess: false,
    accuracy: {
      stats: statsReport,
      odds: oddsReport,
      overall: overallAccuracy(statsReport, oddsReport)!
    },
    failureCategory: "validation",
    failureDetail,
    recordVersion: 2,
    canonical
  };
}

/** Strip a v2 record down to a v1 one: no version, no rows — nothing to recompute from. */
function downgradedToV1(t: TrialResult): TrialResult {
  const { recordVersion: _version, canonical: _rows, ...rest } = t;
  return rest;
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
    oracles?: BenchmarkResults["oracles"];
  }
): BenchmarkResults {
  const benchId = opts?.benchId ?? "bench";
  // Mirror the runner: every trial's artifacts live under runs/<benchId>/..., so the
  // artifactsDir embeds the run's own benchId (the internal-consistency invariant the
  // verifier's c.6 check relies on). Stamping it here means a valid fixture is always
  // self-consistent, and a copy that edits ONLY benchId (test g) is not.
  const withArtifacts = trials.map((t) => ({ ...t, artifactsDir: `runs/${benchId}/trials/${t.runId}` }));
  // Mirror the recorder's v2 PROVENANCE too: a real v2 record always carries a
  // chromeVersion key (null when the build could not be read), and a real v2 run
  // always stamps modelConfig/pricesPinnedAt/chromeVersion. Defaulting them here
  // keeps every fixture an HONEST v2 record, so a test that deletes one of them
  // is deleting something a genuine record would have had. v1 fixtures are left
  // exactly as they were — a v1 run genuinely has none of these fields.
  const runIsV2 = withArtifacts.some((t) => t.recordVersion === 2);
  const stampedTrials = withArtifacts.map((t) =>
    t.recordVersion === 2 && !Object.hasOwn(t, "chromeVersion") ? { ...t, chromeVersion: null } : t
  );
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
    ...(opts?.oracles ? { oracles: opts.oracles } : {}),
    environment: {
      ...env(suiteHash),
      ...(runIsV2
        ? {
            modelConfig: { temperature: null, temperatureSource: "n/a-no-model" as const },
            pricesPinnedAt: "2026-07-14",
            chromeVersion: unanimousChromeVersion(stampedTrials)
          }
        : {}),
      ...(opts?.env ?? {})
    }
  });
}

/**
 * A LoadedScenarioSuite built DIRECTLY, bypassing loadScenarioSuite. Needed only
 * for the two modes below: the loader enforces PROTOCOL_2A §3 (every suite cell
 * must be fresh-session and expected: "success"), so a suite carrying a
 * validation-failure expectation, a reuse session, or a success-with-warnings
 * expectation cannot be produced through it. The verifier still has to behave
 * correctly if one ever reaches it — later phases may relax §3 — so these probes
 * hand `verifySuite` the object the loader would otherwise have built.
 */
function unloadableSuite(
  id: string,
  seed: number,
  mode: { expected?: string; session?: string }
): LoadedScenarioSuite {
  return {
    protocolId: "phase2a-v1",
    suiteHash: "f".repeat(64),
    scenarios: [
      {
        id,
        name: id,
        description: `${id} condition`,
        chaos: [],
        seed,
        session: (mode.session ?? "fresh") as SuiteScenario["session"],
        expected: (mode.expected ?? "success") as SuiteScenario["expected"],
        stratum: "K",
        stratumId: "header-1",
        predictions: {
          A: "observed-failure",
          B: "observed-failure",
          B2: "observed-failure",
          C: "observed-failure",
          D: "observed-failure"
        }
      }
    ]
  };
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

  // ── Record version 2: recompute the counters, never trust them ───────────────

  it("v2: a faithful record recomputes identically and is counted as recomputed, not attested", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const results = makeResults([scenario("s1", 2201)], [v2PassTrial("s1", truth)], suite.suiteHash, {
      oracles: { s1: { truth, overrides: [] } }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.records).toEqual({ total: 1, recomputed: 1, v2NoRows: 0, attestedV1: 0 });
  });

  it("v2: a TAMPERED raw payload — one flipped cell — moves the whole chain and is a GRADING violation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    // Flip ONE cell of ONE RAW row — the root of the chain — while leaving every
    // downstream value the record claims (rows, counters, verdict) untouched.
    // Re-deriving from raw moves all of them at once.
    const raw = rawFrom(truth);
    const first = raw.stats.rows[0] as { goalsFor: number };
    raw.stats.rows[0] = { ...first, goalsFor: first.goalsFor + 7 };
    const trial = v2PassTrial("s1", truth);
    const tampered: TrialResult = { ...trial, canonical: { ...trial.canonical!, raw } };
    const results = makeResults([scenario("s1", 2201)], [tampered], suite.suiteHash, {
      oracles: { s1: { truth, overrides: [] } }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    // The counters no longer follow from the payload the record itself ships.
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /recorded accuracy does not follow from the shipped raw payloads/.test(v.message) &&
          /stats\.fieldMatches/.test(v.message)
      )
    ).toBe(true);
    // ...nor do the shipped normalized rows...
    expect(
      report.violations.some(
        (v) => v.check === "grading" && /shipped canonical stats rows do not follow/.test(v.message)
      )
    ).toBe(true);
    // ...and the judged verdict recomputed from that payload flips PASS → FAIL.
    expect(
      report.violations.some((v) => v.check === "grading" && /recorded outcome "pass".*recomputed "fail"/.test(v.message))
    ).toBe(true);
  });

  it("v2: a record that ships rows but no oracle for its scenario cannot be recomputed → GRADING violation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    // v2 record, but the run omits the oracles map entirely.
    const results = makeResults([scenario("s1", 2201)], [v2PassTrial("s1", truth)], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) => v.check === "grading" && /ships no oracles entry for scenario "s1"/.test(v.message))
    ).toBe(true);
  });

  it("v1 records stay on the counter-based re-grade and are labelled attested, not recomputed", () => {
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    const results = makeResults(scenarios, [failTrial("s1"), passTrial("s2")], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.records).toEqual({ total: 2, recomputed: 0, v2NoRows: 0, attestedV1: 2 });
    // The formatted report says so in words, so a mixed bundle is legible.
    expect(formatReport(report)).toContain("2 attested (v1, raw payloads not shipped)");
  });

  it("v2: an honest HARD-FAILURE record (no dataset produced, accuracy null) PASSES and is counted as its own class", () => {
    // PASS-PINNING for the most common real v2 record shape: a trial that failed
    // before producing any normalized dataset ships both row pages null and
    // `accuracy: null`. There is nothing to recompute, so it must NOT be counted
    // as recomputed — and it must NOT be treated as a malformed record either.
    const suite = loadSuite(["s1"]);
    const results = makeResults([scenario("s1", 2201)], [v2HardFailureTrial("s1")], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.records).toEqual({ total: 1, recomputed: 0, v2NoRows: 1, attestedV1: 0 });
    expect(formatReport(report)).toContain("1 hard-failure (v2, no payload produced — consistency-checked)");
  });

  it("v2: a record that declares version 2 but ships NO canonical block is a GRADING violation and is never counted as recomputed", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const { canonical: _rows, ...noCanonical } = v2PassTrial("s1", truth);
    const results = makeResults([scenario("s1", 2201)], [noCanonical], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) => v.check === "grading" && /record version 2 but no canonical rows/.test(v.message)
      )
    ).toBe(true);
    // M1: a blocked recompute is counted in NO class — never as recomputed.
    expect(report.records).toEqual({ total: 1, recomputed: 0, v2NoRows: 0, attestedV1: 0 });
    expect(formatReport(report)).toContain("1 v2 record(s) could NOT be recomputed");
  });

  it("v2: a record that ships rows for only ONE page is a GRADING violation (the scorer consumed both)", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const trial = v2PassTrial("s1", truth);
    const halved: TrialResult = { ...trial, canonical: { ...trial.canonical!, odds: null } };
    const results = makeResults([scenario("s1", 2201)], [halved], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /canonical ships rows for only one page \(stats present, odds null\)/.test(v.message)
      )
    ).toBe(true);
    expect(report.records.recomputed).toBe(0);
  });

  it("v2: both row pages null WITH an accuracy report recorded is a GRADING violation (nothing was scored)", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const trial = v2PassTrial("s1", truth);
    // Keeps the perfect accuracy report but claims no dataset ever existed.
    const contradictory: TrialResult = {
      ...trial,
      canonical: {
        raw: { stats: null, odds: null },
        stats: null,
        odds: null,
        failures: [],
        warnings: []
      }
    };
    const results = makeResults([scenario("s1", 2201)], [contradictory], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /canonical ships no rows for either page, yet an accuracy report is recorded/.test(v.message)
      )
    ).toBe(true);
    // Not the honest hard-failure class either — it is inconsistent, not empty.
    expect(report.records).toEqual({ total: 1, recomputed: 0, v2NoRows: 0, attestedV1: 0 });
  });

  it("v2: `accuracy: null` shipped ALONGSIDE rows is a GRADING violation (the rows recompute to a report)", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const trial: TrialResult = { ...v2PassTrial("s1", truth), accuracy: null };
    const results = makeResults([scenario("s1", 2201)], [trial], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /stats: no accuracy report recorded, but the shipped rows recompute to one/.test(v.message)
      )
    ).toBe(true);
    expect(
      report.violations.some(
        (v) => v.check === "grading" && /recorded overall accuracy \(absent\) ≠ recomputed 1/.test(v.message)
      )
    ).toBe(true);
  });

  it("v2: a tampered OVERALL alone — per-page reports untouched — is caught by the standalone overall check", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const trial = v2PassTrial("s1", truth);
    // Only the aggregate is rewritten; both per-page reports still follow from the rows.
    const tampered: TrialResult = { ...trial, accuracy: { ...trial.accuracy!, overall: 0.5 } };
    const results = makeResults([scenario("s1", 2201)], [tampered], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    // The per-page checks stay silent, so ONLY the standalone overall message fires.
    expect(report.violations.map((v) => v.message)).toEqual([
      "run-a/s1-baseline-t1: recorded overall accuracy 0.5 ≠ recomputed 1"
    ]);
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

  // ── Record-version-2 forgery suite (NAMED regressions, adversarial review) ────
  // Each attack below was EXECUTED against the v2 implementation and printed
  // VERIFY: PASS. Each must now fail, for the stated reason.

  it("ATTACK-DOWNGRADE (1/2): a v2 trial stripped to a v1 record is rejected by --expect-record-version 2", () => {
    // NAMED REGRESSION: delete `recordVersion` and `canonical` from a v2 trial and
    // rewrite its counters/verdict into pass strings, and the trial silently rejoins
    // the ATTESTED-v1 path — its own counters become the only evidence, and they
    // re-grade to PASS. The version a record DECLARES is therefore itself a claim the
    // caller must be able to pin.
    const suite = loadSuite(["s1", "s2"], "observed-failure", ["corruptData"]);
    const scenarios = [scenario("s1", 2201, ["corruptData"]), scenario("s2", 2202, ["corruptData"])];
    const honest = v2ValidationFailureTrial("s1", 2201);
    const forged: TrialResult = {
      ...downgradedToV1(v2ValidationFailureTrial("s2", 2202)),
      outcome: "pass",
      outcomeReason: "success: pipeline succeeded (accuracy 1.00)",
      outcomeClass: "pass",
      pipelineSuccess: true,
      validationSuccess: true,
      accuracy: { overall: 1 }
    };
    delete (forged as { failureCategory?: unknown }).failureCategory;
    delete (forged as { failureDetail?: unknown }).failureDetail;
    const results = makeResults(scenarios, [honest, forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201, ["corruptData"]), s2: derivedOracle(2202, ["corruptData"]) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, {
      policies: ["A"],
      trials: 1,
      recordVersion: 2
    });
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "provenance" &&
          /s2-baseline-t1: trial declares record version 1 \(recordVersion absent\), but --expect-record-version 2 was given/.test(
            v.message
          )
      )
    ).toBe(true);
    // The honest v2 sibling declares 2 and is not implicated.
    expect(report.violations.some((v) => /s1-baseline-t1: trial declares record version/.test(v.message))).toBe(false);
  });

  it("ATTACK-DOWNGRADE (2/2): the same forgery is caught WITHOUT the flag, by intra-run record-version uniformity", () => {
    // NAMED REGRESSION, second line of defence: a caller who forgets
    // --expect-record-version must still catch a downgraded trial, because one
    // execution writes ONE record format — a run whose trials disagree has been
    // edited. Note what does NOT fire: the grading check is completely silent,
    // because the downgraded record is internally consistent with its own rewritten
    // counters. That silence is precisely why the version must be pinned.
    const suite = loadSuite(["s1", "s2"], "observed-failure", ["corruptData"]);
    const scenarios = [scenario("s1", 2201, ["corruptData"]), scenario("s2", 2202, ["corruptData"])];
    const honest = v2ValidationFailureTrial("s1", 2201);
    const forged: TrialResult = {
      ...downgradedToV1(v2ValidationFailureTrial("s2", 2202)),
      outcome: "pass",
      outcomeReason: "success: pipeline succeeded (accuracy 1.00)",
      outcomeClass: "pass",
      pipelineSuccess: true,
      validationSuccess: true,
      accuracy: { overall: 1 }
    };
    delete (forged as { failureCategory?: unknown }).failureCategory;
    delete (forged as { failureDetail?: unknown }).failureDetail;
    const results = makeResults(scenarios, [honest, forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201, ["corruptData"]), s2: derivedOracle(2202, ["corruptData"]) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["A"], trials: 1 });
    expect(report.ok).toBe(false);
    expect(report.violations.filter((v) => v.check === "grading")).toEqual([]);
    expect(
      report.violations.some(
        (v) =>
          v.check === "provenance" &&
          /trials declare mixed record versions \(1, 2\) — every trial in one run must declare the same record version/.test(
            v.message
          )
      )
    ).toBe(true);
  });

  it("ATTACK-BOOLFLIP: flipping pipelineSuccess/validationSuccess on GENUINE rows is caught by the validation recompute", () => {
    // NAMED REGRESSION: keep the real rows and the real oracle, flip the pipeline's
    // self-reported booleans to true, drop the failure category/detail, and rewrite
    // the verdict strings. Every counter still recomputes exactly (the corrupt cell
    // is excluded from scoring), and the judge reads its success flag straight off
    // the record — so the forgery passed. Recomputing the DOMAIN VALIDATOR over the
    // shipped dataset is what closes it.
    const suite = loadSuite(["s1"], "observed-failure", ["corruptData"]);
    const scenarios = [scenario("s1", 2201, ["corruptData"])];
    const oracles = { s1: derivedOracle(2201, ["corruptData"]) };
    const honest = v2ValidationFailureTrial("s1", 2201);

    // Control: the honest record — genuine rows, perfect accuracy, validation failed
    // — verifies clean. Only the boolean flip below may fail.
    const clean = verifySuite(
      [{ source: "run-a", raw: makeResults(scenarios, [honest], suite.suiteHash, { oracles }) }],
      suite,
      EXPECT_A1
    );
    expect(clean.violations).toEqual([]);
    expect(honest.accuracy!.overall).toBe(1);

    const forged: TrialResult = {
      ...honest,
      outcome: "pass",
      outcomeReason: "success: pipeline succeeded (accuracy 1.00)",
      outcomeClass: "pass",
      pipelineSuccess: true,
      validationSuccess: true
    };
    delete (forged as { failureCategory?: unknown }).failureCategory;
    delete (forged as { failureDetail?: unknown }).failureDetail;
    const report = verifySuite(
      [{ source: "run-a", raw: makeResults(scenarios, [forged], suite.suiteHash, { oracles }) }],
      suite,
      EXPECT_A1
    );
    expect(report.ok).toBe(false);
    // The counters still match — the rows really are genuine — so ONLY the
    // recomputed validation verdict exposes the flip.
    expect(report.violations.some((v) => /does not follow from the shipped raw payloads/.test(v.message))).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /recorded validationSuccess true ≠ recomputed false from the shipped raw payloads/.test(v.message) &&
          /W\+D\+L/.test(v.message)
      )
    ).toBe(true);
  });

  it("ATTACK-BOOLFLIP-PIPELINE: flipping ONLY pipelineSuccess — validationSuccess left honest — is caught by the pipeline recompute", () => {
    // NAMED REGRESSION for the narrower sibling of ATTACK-BOOLFLIP: a forger who
    // flips only `pipelineSuccess` leaves `validationSuccess: false` intact, so the
    // validation recompute agrees with the record and stays silent — yet the judge
    // still reads the flipped success flag and returns PASS. The pipeline's own
    // identity `success = extractOk && domainOk` is what refutes it: with domainOk
    // recomputed false, no honest record can claim pipelineSuccess true.
    const suite = loadSuite(["s1"], "observed-failure", ["corruptData"]);
    const scenarios = [scenario("s1", 2201, ["corruptData"])];
    const oracles = { s1: derivedOracle(2201, ["corruptData"]) };
    const honest = v2ValidationFailureTrial("s1", 2201);
    const forged: TrialResult = {
      ...honest,
      outcome: "pass",
      outcomeReason: "success: pipeline succeeded (accuracy 1.00)",
      outcomeClass: "pass",
      // ONLY this flag moves; validationSuccess stays honestly false.
      pipelineSuccess: true
    };
    delete (forged as { failureCategory?: unknown }).failureCategory;
    delete (forged as { failureDetail?: unknown }).failureDetail;
    expect(forged.validationSuccess).toBe(false);
    const report = verifySuite(
      [{ source: "run-a", raw: makeResults(scenarios, [forged], suite.suiteHash, { oracles }) }],
      suite,
      EXPECT_A1
    );
    expect(report.ok).toBe(false);
    // The counters and the validation verdict both still agree with the record —
    // ONLY the recomputed pipeline verdict exposes the flip.
    expect(report.violations.some((v) => /does not follow from the shipped raw payloads/.test(v.message))).toBe(false);
    expect(report.violations.some((v) => /recorded validationSuccess/.test(v.message))).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /recorded pipelineSuccess true ≠ recomputed false from the shipped raw payloads/.test(v.message) &&
          /recomputed domainOk false/.test(v.message)
      )
    ).toBe(true);
  });

  it("a v2 record that ships NO rows yet claims pipelineSuccess is a GRADING violation (it succeeded at nothing)", () => {
    // The hard-failure shape carries no dataset at all, so both success flags are
    // hard-coded false by the pipeline. A record claiming otherwise is refuted by
    // its own contents — and nothing else catches it, because with no rows there is
    // nothing to recompute the counters from.
    const suite = loadSuite(["s1"]);
    const forged: TrialResult = {
      ...v2HardFailureTrial("s1"),
      pipelineSuccess: true,
      // The verdict fields are what the frozen judge/classifier emit for a record
      // claiming success with no accuracy sample, so ONLY the new check fires.
      outcome: "fail",
      outcomeReason: "expected success but no accuracy sample — cannot verify extraction",
      outcomeClass: "silent-corruption"
    };
    delete (forged as { failureCategory?: unknown }).failureCategory;
    delete (forged as { failureDetail?: unknown }).failureDetail;
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.message)).toEqual([
      "run-a/s1-baseline-t1: canonical ships no rows for either page, yet the record claims pipelineSuccess true — a trial that produced no normalized dataset succeeded at none of them"
    ]);
    // An inconsistent no-rows record is NOT counted as a clean hard-failure record.
    expect(report.records).toEqual({ total: 1, recomputed: 0, v2NoRows: 0, attestedV1: 0 });
  });

  it("ATTACK-OVERRIDES: injected `corrupt` overrides that make the scorer skip the tampered cells are caught by oracle re-derivation", () => {
    // NAMED REGRESSION: leave the truth untouched and ship WRONG rows, then add one
    // `{ kind: "corrupt" }` override per tampered cell. The scorer excludes corrupt
    // cells by design, so the wrong cells were never graded and the record
    // recomputed to a perfect score against the oracle it shipped. Re-deriving the
    // overrides from the suite's seed — the lab's only input — closes it.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const victim = truth.teams[0]!;
    // The forgery is made SELF-CONSISTENT down the whole chain: the wrong value
    // is planted in the RAW payload, so the shipped rows genuinely follow from it
    // and the rows-vs-raw check stays silent. Only the oracle is fabricated.
    const raw = rawFrom(truth);
    raw.stats.rows = raw.stats.rows.map((row) => {
      const r = row as { team: string; goalsFor: number };
      return r.team === victim.name ? { ...r, goalsFor: r.goalsFor + 7 } : r;
    });
    const injected: DisplayOverride[] = [
      { page: "stats", rowKey: victim.name, field: "goalsFor", displayed: "N/A", kind: "corrupt" }
    ];
    const trial = v2PassTrial("s1", truth, canonicalFromRaw(raw), injected);
    expect(trial.accuracy!.overall).toBe(1); // perfect, because the bad cell is skipped
    const results = makeResults([scenario("s1", 2201)], [trial], suite.suiteHash, {
      oracles: { s1: { truth, overrides: injected } }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /the run's recorded oracle for scenario "s1" diverges from the oracle re-derived from the supplied suite's seed \(overrides\)/.test(
            v.message
          )
      )
    ).toBe(true);
    // Graded against the RE-DERIVED oracle (no overrides), the skipped cell is
    // graded again — so the recorded report is one field check short.
    expect(
      report.violations.some(
        (v) => v.check === "grading" && /does not follow from the shipped raw payloads — stats\.fieldChecks/.test(v.message)
      )
    ).toBe(true);
    expect(
      report.violations.some((v) => v.check === "grading" && /recorded outcome "pass".*recomputed "fail"/.test(v.message))
    ).toBe(true);
  });

  it("ATTACK-ORACLE: rewriting the rows AND the shipped truth together is caught by oracle re-derivation", () => {
    // NAMED REGRESSION for the exploit the v2 design always acknowledged: a record
    // that ships both the rows and the ground truth they were graded against can be
    // made self-consistent by editing BOTH. It recomputed perfectly. The truth is
    // not the run's to state: the lab derives it from the scenario seed, so the
    // verifier re-derives it from the SUPPLIED suite and compares.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const forgedTruth: GroundTruth = structuredClone(truth);
    forgedTruth.teams[0]!.goalsFor += 7;
    // Rows and oracle agree with each other — and with nothing else.
    const trial = v2PassTrial("s1", forgedTruth);
    expect(trial.accuracy!.overall).toBe(1);
    const results = makeResults([scenario("s1", 2201)], [trial], suite.suiteHash, {
      oracles: { s1: { truth: forgedTruth, overrides: [] } }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /the run's recorded oracle for scenario "s1" diverges from the oracle re-derived from the supplied suite's seed \(truth\)/.test(
            v.message
          )
      )
    ).toBe(true);
    // ...and the rows, graded against the RE-DERIVED truth, no longer add up.
    expect(
      report.violations.some(
        (v) => v.check === "grading" && /does not follow from the shipped raw payloads — stats\.fieldMatches/.test(v.message)
      )
    ).toBe(true);
  });

  it("ATTACK-FAILURE-STRIP: deleting the dataset's failures array to flip validationSuccess is caught by re-normalizing raw", () => {
    // NAMED REGRESSION for the hole the external review found in the rows-only
    // format: `assessDataset` is SEEDED from the dataset's own failures array, and
    // a normalization-produced failure cannot be re-derived from the normalized
    // rows — the offending row was dropped. So a forger shipped genuine, perfect
    // rows with the failures array emptied, and the domain validator had nothing
    // left to fire on. Shipping RAW closes it: normalization is re-run and the
    // failure comes back.
    const suite = loadSuite(["s1"]);
    const scenarios = [scenario("s1", 2201)];
    const oracles = { s1: derivedOracle(2201) };
    const honest = v2GhostRowTrial("s1", 2201);

    // Control: the honest record — perfect rows, a real validation failure.
    const clean = verifySuite(
      [{ source: "run-a", raw: makeResults(scenarios, [honest], suite.suiteHash, { oracles }) }],
      suite,
      EXPECT_A1
    );
    expect(clean.violations).toEqual([]);
    expect(honest.accuracy!.overall).toBe(1);
    expect(honest.canonical!.failures.length).toBeGreaterThan(0);

    const forged: TrialResult = {
      ...honest,
      outcome: "pass",
      outcomeReason: "success: pipeline succeeded (accuracy 1.00)",
      outcomeClass: "pass",
      pipelineSuccess: true,
      validationSuccess: true,
      // The rows are untouched and genuine; ONLY the annotations are deleted.
      canonical: { ...honest.canonical!, failures: [] }
    };
    delete (forged as { failureCategory?: unknown }).failureCategory;
    delete (forged as { failureDetail?: unknown }).failureDetail;
    const report = verifySuite(
      [{ source: "run-a", raw: makeResults(scenarios, [forged], suite.suiteHash, { oracles }) }],
      suite,
      EXPECT_A1
    );
    expect(report.ok).toBe(false);
    // The rows really are genuine, so the row checks stay silent...
    expect(
      report.violations.some((v) => /shipped canonical stats rows do not follow/.test(v.message))
    ).toBe(false);
    // ...and it is re-normalization that puts the deleted failure back.
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /shipped canonical failures do not follow from the shipped raw payloads/.test(v.message)
      )
    ).toBe(true);
    expect(
      report.violations.some(
        (v) => v.check === "grading" && /recorded validationSuccess true ≠ recomputed false/.test(v.message)
      )
    ).toBe(true);
  });

  it("ATTACK-ROWS-VS-RAW: shipping rows that do not follow from the shipped raw payload is a GRADING violation", () => {
    // NAMED REGRESSION: the raw payload is genuine and the counters are computed
    // from the rows the record ships, so every OTHER check agrees with itself —
    // the record is internally consistent from the normalized rows downward. Only
    // re-running normalization from raw exposes that the rows were edited.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const trial = v2PassTrial("s1", truth);
    const rows = [...trial.canonical!.stats!];
    rows[0] = { ...rows[0]!, goalsFor: (rows[0]!.goalsFor ?? 0) + 7 };
    const forged: TrialResult = { ...trial, canonical: { ...trial.canonical!, stats: rows } };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.message)).toEqual([
      "run-a/s1-baseline-t1: shipped canonical stats rows do not follow from the shipped raw payloads (normalization derives 12 entr(y/ies), the record ships 12)"
    ]);
  });

  it("ATTACK-EXTRACTION-FLIP: raw that fails the extraction schema with extractionSuccess recorded true is a GRADING violation", () => {
    // NAMED REGRESSION: extractionSuccess feeds a HEADLINE metric
    // (extractionSuccessRate) without touching the judged verdict, so flipping it
    // alone inflates a published number while leaving every other field honest.
    // With raw shipped it is the verdict of re-running the extraction schemas.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    // A page the extractor read as unusable: `played` came back as text.
    const raw = rawFrom(truth);
    raw.stats.rows = raw.stats.rows.map((row) => ({
      ...(row as Record<string, unknown>),
      played: "twelve"
    }));
    const canonical = canonicalFromRaw(raw);
    const statsReport = scoreStats(canonical.stats ?? [], truth, []);
    const oddsReport = scoreOdds(canonical.odds ?? [], truth, []);
    const overall = overallAccuracy(statsReport, oddsReport)!;
    // The detail the pipeline records for an extraction failure: the schema
    // issues, in order, capped exactly as runPipeline caps them.
    const assessment = assessDataset({
      teams: canonical.stats ?? [],
      markets: canonical.odds ?? [],
      failures: canonical.failures,
      warnings: canonical.warnings
    });
    const failureDetail = [...checkStatsSchema(raw.stats).issues, ...assessment.failures]
      .slice(0, 5)
      .join(" | ");
    // Everything below is the HONEST record of that failure — except the one flag.
    const forged: TrialResult = {
      ...passTrial("s1"),
      outcome: "fail",
      outcomeReason: `expected success but pipeline failed [extraction] ${failureDetail}`,
      outcomeClass: "safe-failure",
      pipelineSuccess: false,
      extractionSuccess: true, // the lie
      validationSuccess: false,
      accuracy: { stats: statsReport, odds: oddsReport, overall },
      failureCategory: "extraction",
      failureDetail,
      recordVersion: 2,
      canonical
    };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    // Exactly one divergence: extractionSuccess is no longer attested.
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.check).toBe("grading");
    expect(report.violations[0]!.message).toMatch(
      /recorded extractionSuccess true ≠ recomputed false from the shipped raw payloads \(first issue: stats /
    );
  });

  it("ATTACK-TRACE-CALLS: a step trace whose model calls do not add up to tokens.llmCalls is a GRADING violation", () => {
    // NAMED REGRESSION: the step trace is the record's account of WHERE inference
    // was spent — the evidence behind every escalation claim. Unreconciled it is
    // free text, so a record could show a clean deterministic trace while its own
    // token count admits model calls. It is cross-checked against that count.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const forged: TrialResult = {
      ...v2PassTrial("s1", truth),
      tokens: { llmCalls: 3 },
      stepTrace: [
        { step: "reveal-table", readinessOutcome: "ready", modelCallsAtStep: 0 },
        {
          step: "extract-stats",
          escalationTriggered: false,
          repairAttempted: false,
          repairSucceeded: false,
          repairKind: null,
          modelCallsAtStep: 0,
          note: "header-mappable table found; no extraction repair needed"
        }
      ]
    };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) },
      // The forgery's own tokens claim 3 model calls, so the run it belongs to
      // named a model — otherwise the modelless-run check fires too and the
      // trace mismatch under test is no longer the only violation.
      env: keyedEnv()
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.message)).toEqual([
      "run-a/s1-baseline-t1: stepTrace accounts for 0 model call(s) but tokens.llmCalls records 3"
    ]);
  });

  it("a step trace that claims a successful llm repair the record does not list in healedSteps is a GRADING violation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const forged: TrialResult = {
      ...v2PassTrial("s1", truth),
      tokens: { llmCalls: 1 },
      // healedSteps is absent: the trace claims a repair the record never disclosed.
      stepTrace: [
        {
          step: "reveal-table",
          escalationTriggered: true,
          repairAttempted: true,
          repairSucceeded: true,
          repairKind: "llm",
          modelCallsAtStep: 1,
          downstreamRecovered: true
        }
      ]
    };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /stepTrace reports successful llm repair\(s\) at \[reveal-table\] but healedSteps records \[\(none\)\]/.test(
            v.message
          )
      )
    ).toBe(true);
  });

  // ── Trace reconciliation, per-field semantics (external review F1) ──────────

  it("PASS-PIN: a stagehand guard that FIRED but did not clear the blocker verifies clean", () => {
    // NAMED REGRESSION for a FALSE POSITIVE on honest evidence: `deterministicFallbacks`
    // is pushed when the hand-written guard FIRES, before anyone knows whether it
    // worked (stagehand/engine.ts), while `deterministicRepairSteps` is written on
    // SUCCESS. Equating the two made the most honest possible record — "the guard
    // ran and the wall stayed up" — read as a forgery.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const honest: TrialResult = {
      ...v2PassTrial("s1", truth),
      engine: "stagehand",
      runId: "s1-stagehand-t1",
      deterministicFallbacks: ["consent"],
      tokens: { llmCalls: 1 },
      stepTrace: [
        {
          step: "consent",
          escalationTriggered: true,
          repairAttempted: true,
          repairSucceeded: false,
          repairKind: "deterministic",
          modelCallsAtStep: 0,
          note: "semantic act did not clear the consent wall; hand-written guard fired"
        },
        { step: "consent", modelCallsAtStep: 1, note: "llm call site: act(instruction)" }
      ]
    };
    const results = makeResults([scenario("s1", 2201)], [honest], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) },
      // A stagehand trial only exists on a KEYED run — it is the full-semantic
      // engine — and this one spends a model call, so the run must name a model.
      env: keyedEnv()
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["D"], trials: 1 });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("stagehand: deterministicFallbacks that disagree with the ATTEMPTED guards in the trace is a GRADING violation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const forged: TrialResult = {
      ...v2PassTrial("s1", truth),
      engine: "stagehand",
      runId: "s1-stagehand-t1",
      // The trace says a guard fired at `consent`; the record discloses none.
      deterministicFallbacks: [],
      tokens: { llmCalls: 0 },
      stepTrace: [
        {
          step: "consent",
          escalationTriggered: true,
          repairAttempted: true,
          repairSucceeded: true,
          repairKind: "deterministic",
          modelCallsAtStep: 0
        }
      ]
    };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["D"], trials: 1 });
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        /stepTrace reports ATTEMPTED deterministic guard\(s\) at \[consent\] but deterministicFallbacks records \[\(none\)\]/.test(
          v.message
        )
      )
    ).toBe(true);
  });

  it("hybrid: deterministicRepairSteps that disagree with the SUCCEEDED repairs in the trace is a GRADING violation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const forged: TrialResult = {
      ...v2PassTrial("s1", truth),
      engine: "hybrid",
      runId: "s1-hybrid-t1",
      deterministicRepairSteps: ["login", "reveal-table"], // the trace succeeded at one
      tokens: { llmCalls: 0 },
      stepTrace: [
        {
          step: "login",
          escalationTriggered: true,
          repairAttempted: true,
          repairSucceeded: true,
          repairKind: "deterministic",
          modelCallsAtStep: 0,
          downstreamRecovered: true
        }
      ]
    };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) },
      env: { repairMode: "deterministic" }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["B2"], trials: 1 });
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        /stepTrace reports SUCCESSFUL deterministic repair\(s\) at \[login\] but deterministicRepairSteps records \[login, reveal-table\]/.test(
          v.message
        )
      )
    ).toBe(true);
  });

  // ── The reconciliation cannot be silenced by deleting evidence (F3) ─────────

  it("an engine with escalation machinery that ships no trace and no tokens is a GRADING violation per missing piece", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const forged: TrialResult = {
      ...v2PassTrial("s1", truth),
      engine: "hybrid",
      runId: "s1-hybrid-t1",
      healedSteps: ["extract-stats"],
      outcomeClass: "recovered"
    };
    delete (forged as { tokens?: unknown }).tokens;
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) },
      env: { repairMode: "deterministic" }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, { policies: ["B2"], trials: 1 });
    expect(report.ok).toBe(false);
    // Each strip is named on its own line, so the report says WHAT is missing.
    expect(report.violations.some((v) => /ships no tokens block/.test(v.message))).toBe(true);
    expect(report.violations.some((v) => /ships no stepTrace/.test(v.message))).toBe(true);
    expect(
      report.violations.some((v) => /claims repair\(s\) at \[extract-stats\] but ships no stepTrace/.test(v.message))
    ).toBe(true);
  });

  it("a trace whose entries omit modelCallsAtStep cannot silence the model-call reconciliation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const forged: TrialResult = {
      ...v2PassTrial("s1", truth),
      tokens: { llmCalls: 42 },
      stepTrace: [
        { step: "reveal-table", readinessOutcome: "ready" },
        { step: "extract-stats", escalationTriggered: false, note: "no extraction repair needed" }
      ]
    };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        /tokens\.llmCalls records 42 model call\(s\) but the stepTrace does not account for them \(2 entr\(y\/ies\) omit modelCallsAtStep\)/.test(
          v.message
        )
      )
    ).toBe(true);
  });

  it("deleting the tokens block while the trace counts model calls is a GRADING violation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const forged: TrialResult = {
      ...v2PassTrial("s1", truth),
      stepTrace: [{ step: "extract-stats", modelCallsAtStep: 7, note: "llm call site: extract(stats)" }]
    };
    delete (forged as { tokens?: unknown }).tokens;
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        /stepTrace accounts for model calls but the record ships no tokens block/.test(v.message)
      )
    ).toBe(true);
  });

  // ── Failure attribution (F2) ───────────────────────────────────────────────

  it("ATTACK-ATTRIBUTION-LAUNDER: re-labelling a graded extraction failure as a navigation crash is a GRADING violation", () => {
    // NAMED REGRESSION: every recomputable number stays honest — genuine raw,
    // genuine rows, genuine counters, a correctly judged FAIL. Only the failure
    // ATTRIBUTION is rewritten, moving the trial out of the safe-failure column
    // and into hard-failure, which is what the safety headline counts. The
    // pipeline does not choose a category, it DERIVES one, so neither may a record.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const raw = rawFrom(truth);
    raw.stats.rows = raw.stats.rows.map((row) => ({
      ...(row as Record<string, unknown>),
      played: "twelve"
    }));
    const canonical = canonicalFromRaw(raw);
    const statsReport = scoreStats(canonical.stats ?? [], truth, []);
    const oddsReport = scoreOdds(canonical.odds ?? [], truth, []);
    const overall = overallAccuracy(statsReport, oddsReport)!;
    const assessment = assessDataset({
      teams: canonical.stats ?? [],
      markets: canonical.odds ?? [],
      failures: canonical.failures,
      warnings: canonical.warnings
    });
    const honestDetail = [...checkStatsSchema(raw.stats).issues, ...assessment.failures]
      .slice(0, 5)
      .join(" | ");
    const honest: TrialResult = {
      ...passTrial("s1"),
      outcome: "fail",
      outcomeReason: `expected success but pipeline failed [extraction] ${honestDetail}`,
      outcomeClass: "safe-failure",
      pipelineSuccess: false,
      extractionSuccess: false,
      validationSuccess: false,
      accuracy: { stats: statsReport, odds: oddsReport, overall },
      failureCategory: "extraction",
      failureDetail: honestDetail,
      recordVersion: 2,
      canonical
    };
    // Control: the honest attribution verifies clean.
    const clean = verifySuite(
      [
        {
          source: "run-a",
          raw: makeResults([scenario("s1", 2201)], [honest], suite.suiteHash, {
            oracles: { s1: derivedOracle(2201) }
          })
        }
      ],
      suite,
      EXPECT_A1
    );
    expect(clean.violations).toEqual([]);

    const laundered: TrialResult = {
      ...honest,
      failureCategory: "navigation",
      failureDetail: "stats page never rendered",
      outcomeReason: "expected success but pipeline failed [navigation] stats page never rendered",
      outcomeClass: "hard-failure"
    };
    const report = verifySuite(
      [
        {
          source: "run-a",
          raw: makeResults([scenario("s1", 2201)], [laundered], suite.suiteHash, {
            oracles: { s1: derivedOracle(2201) }
          })
        }
      ],
      suite,
      EXPECT_A1
    );
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        /recorded failureCategory "navigation" ≠ recomputed "extraction"/.test(v.message)
      )
    ).toBe(true);
    expect(
      report.violations.some((v) =>
        /recorded failureDetail ≠ recomputed from the shipped raw payloads/.test(v.message)
      )
    ).toBe(true);
  });

  // ── No-payload class invariants (F4, F6) ───────────────────────────────────

  it("a no-rows record claiming extractionSuccess is a GRADING violation (there was no payload to check)", () => {
    const suite = loadSuite(["s1"]);
    const forged: TrialResult = { ...v2HardFailureTrial("s1"), extractionSuccess: true };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.message)).toEqual([
      "run-a/s1-baseline-t1: canonical ships no rows for either page, yet the record claims extractionSuccess true — a trial that produced no normalized dataset succeeded at none of them"
    ]);
    expect(report.records).toEqual({ total: 1, recomputed: 0, v2NoRows: 0, attestedV1: 0 });
  });

  it("a no-rows record with invented failures/warnings is a GRADING violation (normalization never ran)", () => {
    const suite = loadSuite(["s1"]);
    const trial = v2HardFailureTrial("s1");
    const forged: TrialResult = {
      ...trial,
      canonical: { ...trial.canonical!, failures: ["invented failure"], warnings: ["invented warning"] }
    };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => v.message)).toEqual([
      "run-a/s1-baseline-t1: canonical ships no rows for either page, yet records 1 failure(s) and 1 warning(s) — normalization never ran, so both lists must be empty"
    ]);
  });

  it("a record with NO normalized rows but a raw payload present is malformed", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const trial = v2HardFailureTrial("s1");
    const forged: TrialResult = {
      ...trial,
      canonical: { ...trial.canonical!, raw: { stats: rawFrom(truth).stats, odds: null } }
    };
    const results = makeResults([scenario("s1", 2201)], [forged], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        /ships no normalized rows for either page, yet ships a raw payload \(stats present, odds null\)/.test(v.message)
      )
    ).toBe(true);
  });

  // ── Run-level browser provenance is re-derived, not trusted (F7) ────────────

  it("environment.chromeVersion that does not follow from the per-trial values is a PROVENANCE violation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const trial: TrialResult = { ...v2PassTrial("s1", truth), chromeVersion: "HeadlessChrome/1.2.3.4" };
    const results = makeResults([scenario("s1", 2201)], [trial], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) },
      env: { chromeVersion: "Chrome/999.0.0.0" }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) =>
          v.check === "provenance" &&
          /environment\.chromeVersion "Chrome\/999\.0\.0\.0" ≠ "HeadlessChrome\/1\.2\.3\.4" re-derived from the per-trial values/.test(
            v.message
          )
      )
    ).toBe(true);
  });

  // ── pagesRequested pins the extraction verdict's domain ────────────────────

  it("PASS-PIN: an honest single-page raw null alongside present rows verifies clean", () => {
    // The stats page produced no payload while normalization still built a dataset
    // from the odds page. Legitimate, and distinct from "no dataset at all".
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const canonical = canonicalFromRaw({ stats: null, odds: rawFrom(truth).odds });
    const statsReport = scoreStats(canonical.stats ?? [], truth, []);
    const oddsReport = scoreOdds(canonical.odds ?? [], truth, []);
    const assessment = assessDataset({
      teams: canonical.stats ?? [],
      markets: canonical.odds ?? [],
      failures: canonical.failures,
      warnings: canonical.warnings
    });
    const detail = [...checkStatsSchema(null).issues, ...assessment.failures].slice(0, 5).join(" | ");
    const honest: TrialResult = {
      ...passTrial("s1"),
      outcome: "fail",
      outcomeReason: `expected success but pipeline failed [extraction] ${detail}`,
      outcomeClass: "safe-failure",
      pipelineSuccess: false,
      extractionSuccess: false,
      validationSuccess: false,
      accuracy: {
        stats: statsReport,
        odds: oddsReport,
        overall: overallAccuracy(statsReport, oddsReport)!
      },
      failureCategory: "extraction",
      failureDetail: detail,
      recordVersion: 2,
      canonical
    };
    const results = makeResults([scenario("s1", 2201)], [honest], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.records).toEqual({ total: 1, recomputed: 1, v2NoRows: 0, attestedV1: 0 });
  });

  it("pagesRequested narrows the extraction recomputation to exactly the pages that were asked for", () => {
    // A record that asked for ODDS ONLY: the absent stats payload is not an
    // extraction failure, because no stats extraction was ever run. Without the
    // field the verifier must assume both pages, and the same record reads as a
    // failed stats extraction — which is precisely the false positive the field
    // exists to prevent.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const canonical = canonicalFromRaw({ stats: null, odds: rawFrom(truth).odds });
    const statsReport = scoreStats(canonical.stats ?? [], truth, []);
    const oddsReport = scoreOdds(canonical.odds ?? [], truth, []);
    const assessment = assessDataset({
      teams: canonical.stats ?? [],
      markets: canonical.odds ?? [],
      failures: canonical.failures,
      warnings: canonical.warnings
    });
    const detail = assessment.failures.slice(0, 5).join(" | ");
    const oddsOnly: TrialResult = {
      ...passTrial("s1"),
      outcome: "fail",
      outcomeReason: `expected success but pipeline failed [validation] ${detail}`,
      outcomeClass: "safe-failure",
      pipelineSuccess: false,
      extractionSuccess: true, // the odds page — the only one requested — parsed
      validationSuccess: false,
      accuracy: {
        stats: statsReport,
        odds: oddsReport,
        overall: overallAccuracy(statsReport, oddsReport)!
      },
      failureCategory: "validation",
      failureDetail: detail,
      recordVersion: 2,
      pagesRequested: ["odds"],
      canonical
    };
    const withField = verifySuite(
      [
        {
          source: "run-a",
          raw: makeResults([scenario("s1", 2201)], [oddsOnly], suite.suiteHash, {
            oracles: { s1: derivedOracle(2201) }
          })
        }
      ],
      suite,
      EXPECT_A1
    );
    expect(withField.violations).toEqual([]);

    // Drop the field: the same record now claims a stats extraction that failed.
    const { pagesRequested: _dropped, ...assumesBoth } = oddsOnly;
    const without = verifySuite(
      [
        {
          source: "run-a",
          raw: makeResults([scenario("s1", 2201)], [assumesBoth], suite.suiteHash, {
            oracles: { s1: derivedOracle(2201) }
          })
        }
      ],
      suite,
      EXPECT_A1
    );
    expect(
      without.violations.some((v) => /recorded extractionSuccess true ≠ recomputed false/.test(v.message))
    ).toBe(true);
  });

  // ── Payload deletion cannot manufacture an EXPECTED failure (sol gate 2) ────

  it("ATTACK-PAYLOAD-DROP-EXPECTED-FAILURE: a no-payload record claiming failureCategory \"validation\" is a GRADING violation", () => {
    // NAMED REGRESSION for the one path by which evidence DELETION could reach a
    // judged PASS rather than degrade toward fail. On a `validation-failure`
    // scenario the judge passes exactly when `failureCategory === "validation"`,
    // and a no-payload record otherwise satisfies every class invariant — so
    // dropping the payloads and writing that one word manufactures the expected
    // outcome with no evidence at all. The pipeline derives that category only
    // from a dataset it built, so a no-payload record cannot have earned it.
    const suite = unloadableSuite("s1", 2201, { expected: "validation-failure" });
    const scenarios = [scenario("s1", 2201, [], { expected: "validation-failure" })];
    const oracles = { s1: derivedOracle(2201) };

    // PASS-PIN: the HONEST equivalent — a genuine categorised validation failure
    // WITH payloads shipped — verifies clean through the whole chain on the very
    // same scenario, so the rule rejects the forgery and not the real thing.
    const genuine = v2GhostRowTrial("s1", 2201);
    const honest: TrialResult = {
      ...genuine,
      outcome: "pass",
      outcomeReason: "validation-failure: clean categorised validation failure as expected",
      outcomeClass: "safe-failure"
    };
    const clean = verifySuite(
      [{ source: "run-a", raw: makeResults(scenarios, [honest], suite.suiteHash, { oracles }) }],
      suite,
      EXPECT_A1
    );
    expect(clean.violations).toEqual([]);
    expect(clean.ok).toBe(true);

    // The forgery: same verdict, same category, no evidence whatsoever.
    const laundered: TrialResult = {
      ...v2HardFailureTrial("s1"),
      outcome: "pass",
      outcomeReason: "validation-failure: clean categorised validation failure as expected",
      outcomeClass: "safe-failure",
      failureCategory: "validation",
      failureDetail: "domain validation rejected the dataset"
    };
    const report = verifySuite(
      [{ source: "run-a", raw: makeResults(scenarios, [laundered], suite.suiteHash, { oracles }) }],
      suite,
      EXPECT_A1
    );
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        /canonical ships no rows for either page, yet failureCategory is "validation"/.test(v.message)
      )
    ).toBe(true);
    // …and it is not counted as a consistency-checked hard-failure record.
    expect(report.records).toEqual({ total: 1, recomputed: 0, v2NoRows: 0, attestedV1: 0 });
  });

  it("PASS-PIN: a no-payload record whose failureCategory is \"extraction\" stays legal (a throwing extract step really does produce one)", () => {
    // The narrowing that keeps the rule above from rejecting real evidence: an
    // extract step that throws carries category "extraction" out of the pipeline's
    // no-outcome path, and a keyless layout-variant hybrid trial produces exactly
    // that record. Banning it would reject honest evidence — and close nothing,
    // since the judge fails an "extraction" category under every expected mode.
    const suite = loadSuite(["s1"]);
    const trial: TrialResult = {
      ...v2HardFailureTrial("s1"),
      outcomeReason:
        "expected success but pipeline failed [extraction] no header-mappable table found; semantic extraction unavailable (no model key)",
      outcomeClass: "safe-failure",
      failureCategory: "extraction",
      failureDetail: "no header-mappable table found; semantic extraction unavailable (no model key)"
    };
    const results = makeResults([scenario("s1", 2201)], [trial], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.records).toEqual({ total: 1, recomputed: 0, v2NoRows: 1, attestedV1: 0 });
  });

  // ── Raw is verbatim, so a malformed payload recomputes to its own error ─────

  it("PASS-PIN: an honestly MALFORMED top-level raw payload verifies clean, attribution recompute included", () => {
    // Regression for the reshaping an earlier draft did: anything that was not
    // `{ rows: [...] }` was rewritten to null on the way into the record. The
    // rewrite changed what the schema check recomputes to ("received null"
    // instead of "received string"), so stage 7 rejected a record whose only sin
    // was that its page came back malformed. Raw now ships verbatim.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const raw = { stats: "<html>502 Bad Gateway</html>" as unknown, odds: rawFrom(truth).odds };
    const canonical = canonicalFromRaw(raw as never);
    const statsReport = scoreStats(canonical.stats ?? [], truth, []);
    const oddsReport = scoreOdds(canonical.odds ?? [], truth, []);
    const assessment = assessDataset({
      teams: canonical.stats ?? [],
      markets: canonical.odds ?? [],
      failures: canonical.failures,
      warnings: canonical.warnings
    });
    const detail = [...checkStatsSchema(raw.stats).issues, ...assessment.failures]
      .slice(0, 5)
      .join(" | ");
    // The detail names what the payload ACTUALLY was — only possible because the
    // record carries the string itself, not a null the record layer substituted.
    expect(detail).toContain("received string");
    const honest: TrialResult = {
      ...passTrial("s1"),
      outcome: "fail",
      outcomeReason: `expected success but pipeline failed [extraction] ${detail}`,
      outcomeClass: "safe-failure",
      pipelineSuccess: false,
      extractionSuccess: false,
      validationSuccess: false,
      accuracy: {
        stats: statsReport,
        odds: oddsReport,
        overall: overallAccuracy(statsReport, oddsReport)!
      },
      failureCategory: "extraction",
      failureDetail: detail,
      recordVersion: 2,
      canonical
    };
    const results = makeResults([scenario("s1", 2201)], [honest], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.records).toEqual({ total: 1, recomputed: 1, v2NoRows: 0, attestedV1: 0 });
  });

  // ── Per-entry trace invariants (sol gate 2) ────────────────────────────────

  it("each stepTrace logical invariant is enforced, and the honest entry that satisfies it is not", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const check = (entry: StepTraceEntry, tokens: TrialResult["tokens"], expected: RegExp | null) => {
      const trial: TrialResult = { ...v2PassTrial("s1", truth), tokens, stepTrace: [entry] };
      const results = makeResults([scenario("s1", 2201)], [trial], suite.suiteHash, {
        oracles: { s1: derivedOracle(2201) }
      });
      const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
      const traceViolations = report.violations.filter((v) => /^run-a\/s1-baseline-t1: stepTrace\[/.test(v.message));
      if (expected === null) {
        expect(traceViolations).toEqual([]);
      } else {
        expect(traceViolations.some((v) => expected.test(v.message))).toBe(true);
      }
    };
    const llmRepair: StepTraceEntry = {
      step: "extract-stats",
      escalationTriggered: true,
      repairAttempted: true,
      repairSucceeded: true,
      repairKind: "llm",
      modelCallsAtStep: 1,
      downstreamRecovered: true
    };
    // Honest direction first: the fully-populated successful llm repair is legal.
    check(llmRepair, { llmCalls: 1 }, null);
    check({ ...llmRepair, repairAttempted: false }, { llmCalls: 1 }, /nothing can succeed unattempted/);
    check({ ...llmRepair, escalationTriggered: false }, { llmCalls: 1 }, /a repair only runs once a trigger fired/);
    check(
      { step: "reveal-table", readinessOutcome: "ready", modelCallsAtStep: 0, downstreamRecovered: true },
      { llmCalls: 0 },
      /nothing for the step to have recovered from/
    );
    check({ ...llmRepair, modelCallsAtStep: 0 }, { llmCalls: 0 }, /the repair IS the call/);
    check(
      {
        step: "login",
        cachedSelectorMatched: true,
        escalationTriggered: true,
        repairAttempted: false,
        repairSucceeded: false,
        repairKind: null,
        modelCallsAtStep: 0
      },
      { llmCalls: 0 },
      /exactly what does NOT trigger escalation/
    );
  });

  // ── Certified scope of the recompute (sol gate 2) ──────────────────────────

  it("a reuse-session scenario is REFUSED by the v2 recompute (the replayed judge cannot see the login step)", () => {
    const suite = unloadableSuite("s1", 2201, { session: "reuse" });
    const scenarios = [scenario("s1", 2201, [], { session: "reuse" })];
    const truth = generateGroundTruth(2201);
    const results = makeResults(scenarios, [v2PassTrial("s1", truth)], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        /declares session "reuse", which is OUTSIDE the record-version-2 recompute's certified scope/.test(v.message)
      )
    ).toBe(true);
  });

  it("a success-with-warnings scenario is REFUSED by the v2 recompute (the replay cannot count dataset warnings)", () => {
    const suite = unloadableSuite("s1", 2201, { expected: "success-with-warnings" });
    const scenarios = [scenario("s1", 2201, [], { expected: "success-with-warnings" })];
    const truth = generateGroundTruth(2201);
    const results = makeResults(scenarios, [v2PassTrial("s1", truth)], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some((v) =>
        /declares expected "success-with-warnings", which is OUTSIDE the record-version-2 recompute's certified scope/.test(
          v.message
        )
      )
    ).toBe(true);
  });

  // ── v2 provenance presence (external gate-2 re-review) ─────────────────────
  // Every probe below starts from an otherwise-PASSING v2 fixture and deletes
  // EXACTLY ONE field. The v2 provenance fields are schema-optional so v1 bundles
  // keep parsing, which is precisely why their absence has to be caught here
  // instead: without these checks a producer could ship a v2 run with no model
  // config, no price pin and no browser evidence at all, and verify clean.

  /** An otherwise-clean single-trial v2 run, as an object ready to be tampered with. */
  const provenanceFixture = (): { suite: LoadedScenarioSuite; results: BenchmarkResults } => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const results = makeResults([scenario("s1", 2201)], [v2PassTrial("s1", truth)], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    return { suite, results };
  };

  it("PASS-PIN: the v2 provenance fixture verifies clean before anything is deleted", () => {
    const { suite, results } = provenanceFixture();
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("ATTACK-PROVENANCE-STRIP-MODELCONFIG: deleting environment.modelConfig from a v2 run is a PROVENANCE violation", () => {
    const { suite, results } = provenanceFixture();
    delete (results.environment as { modelConfig?: unknown }).modelConfig;
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => `${v.check}: ${v.message}`)).toEqual([
      "provenance: run-a: environment.modelConfig is missing (record version 2 requires it)"
    ]);
  });

  it("ATTACK-PROVENANCE-STRIP-PRICES: deleting environment.pricesPinnedAt from a v2 run is a PROVENANCE violation", () => {
    const { suite, results } = provenanceFixture();
    delete (results.environment as { pricesPinnedAt?: unknown }).pricesPinnedAt;
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => `${v.check}: ${v.message}`)).toEqual([
      "provenance: run-a: environment.pricesPinnedAt is missing (record version 2 requires it)"
    ]);
  });

  it("ATTACK-PROVENANCE-STRIP-CHROME-TRIAL: deleting a v2 trial's chromeVersion key is a PROVENANCE violation", () => {
    const { suite, results } = provenanceFixture();
    delete (results.trials[0] as { chromeVersion?: unknown }).chromeVersion;
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => `${v.check}: ${v.message}`)).toEqual([
      "provenance: run-a/s1-baseline-t1: chromeVersion is missing (record version 2 requires the key; null is the value for an unknown build)"
    ]);
  });

  it("ATTACK-PROVENANCE-STRIP-CHROME-RUN: deleting environment.chromeVersion is a PROVENANCE violation even when unanimity re-derives null", () => {
    // The re-derivation returns null here (the trial reports no build), so the
    // VALUE check stays silent — an absent key would otherwise read as "null" and
    // pass. Presence is a separate claim from the value, and both are required.
    const { suite, results } = provenanceFixture();
    expect(results.environment.chromeVersion).toBeNull();
    delete (results.environment as { chromeVersion?: unknown }).chromeVersion;
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => `${v.check}: ${v.message}`)).toEqual([
      "provenance: run-a: environment.chromeVersion is missing (record version 2 requires the key; null is the value when the run's trials do not agree on one build)"
    ]);
  });

  it("PASS-PIN: a v2 trial whose chromeVersion is explicitly null passes the presence checks", () => {
    // null is the recorder's honest "the build could not be read" — a legitimate
    // record, and the whole reason presence is checked with hasOwn rather than by
    // testing the value.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const trial: TrialResult = { ...v2PassTrial("s1", truth), chromeVersion: null };
    const results = makeResults([scenario("s1", 2201)], [trial], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) }
    });
    expect(Object.hasOwn(results.trials[0]!, "chromeVersion")).toBe(true);
    expect(results.trials[0]!.chromeVersion).toBeNull();
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("PASS-PIN: a v1 run is exempt — none of the v2 provenance requirements fire on it", () => {
    // v1 records genuinely predate every one of these fields. The phase2a bundle
    // is 800 of them, and it must keep verifying byte-for-byte.
    const suite = loadSuite(["s1", "s2"]);
    const scenarios = [scenario("s1", 2201), scenario("s2", 2202)];
    const results = makeResults(scenarios, [failTrial("s1"), passTrial("s2")], suite.suiteHash);
    for (const field of ["modelConfig", "pricesPinnedAt", "chromeVersion"] as const) {
      expect(Object.hasOwn(results.environment, field)).toBe(false);
    }
    expect(Object.hasOwn(results.trials[0]!, "chromeVersion")).toBe(false);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  // ── modelConfig semantic consistency (external gate-2 round 3) ─────────────
  // Presence is not consistency. Every probe below ships a WELL-FORMED
  // modelConfig that passes the batch-6 presence check and still describes a run
  // that cannot exist. The signal the verifier reads is `environment.stagehandModel`
  // — the recorder stamps it from the same expression that picks the
  // temperatureSource (runner.ts:540 and :552), so an honest record cannot
  // disagree with itself here.

  /** The env of a run that CONFIGURED a model, exactly as the recorder stamps it. */
  const keyedEnv = (): Partial<BenchmarkResults["environment"]> => ({
    stagehandModel: "provider/some-model-id",
    modelConfig: { temperature: null, temperatureSource: "provider-default" }
  });

  it("PASS-PIN: the honest KEYLESS modelConfig shape (no model, n/a-no-model, temperature null) verifies clean", () => {
    const { suite, results } = provenanceFixture();
    expect(Object.hasOwn(results.environment, "stagehandModel")).toBe(false);
    expect(results.environment.modelConfig).toEqual({
      temperature: null,
      temperatureSource: "n/a-no-model"
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("PASS-PIN: the honest KEYED modelConfig shape (model named, provider-default, temperature null) verifies clean", () => {
    // Mirrors the recorder's model-bearing branch exactly. This side cannot be
    // produced live — it would require a real key and paid inference — so the
    // fixture IS the recorder's own expression, written out.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const results = makeResults([scenario("s1", 2201)], [v2PassTrial("s1", truth)], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) },
      env: keyedEnv()
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("ATTACK-MODELCONFIG-NA-WITH-MODEL: \"n/a-no-model\" on a run that names a model is a PROVENANCE violation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const results = makeResults([scenario("s1", 2201)], [v2PassTrial("s1", truth)], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) },
      env: {
        ...keyedEnv(),
        modelConfig: { temperature: null, temperatureSource: "n/a-no-model" }
      }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => `${v.check}: ${v.message}`)).toEqual([
      'provenance: run-a: environment.modelConfig.temperatureSource is "n/a-no-model" but the run configured the model "provider/some-model-id" — a run cannot both name a model and record that the temperature question did not arise'
    ]);
  });

  it("ATTACK-MODELCONFIG-DEFAULT-NO-MODEL: \"provider-default\" on a run with no model is a PROVENANCE violation", () => {
    const { suite, results } = provenanceFixture();
    (results.environment as { modelConfig?: unknown }).modelConfig = {
      temperature: null,
      temperatureSource: "provider-default"
    };
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => `${v.check}: ${v.message}`)).toEqual([
      'provenance: run-a: environment.modelConfig.temperatureSource is "provider-default" but the run configured no model (environment.stagehandModel absent) — with no model there is no temperature source to report but "n/a-no-model"'
    ]);
  });

  it("ATTACK-MODELCONFIG-EXPLICIT-NULL: \"explicit\" with a null temperature is a PROVENANCE violation", () => {
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const results = makeResults([scenario("s1", 2201)], [v2PassTrial("s1", truth)], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) },
      env: {
        ...keyedEnv(),
        modelConfig: { temperature: null, temperatureSource: "explicit" }
      }
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => `${v.check}: ${v.message}`)).toEqual([
      'provenance: run-a: environment.modelConfig.temperatureSource is "explicit" but temperature is null — an explicitly set temperature is the number that was set'
    ]);
  });

  it("ATTACK-MODELCONFIG-CALLS-WITHOUT-MODEL: a modelless run whose trial records model calls is a PROVENANCE violation", () => {
    // NAMED REGRESSION for the last way out of the batch-7 consistency layer: a
    // keyed record laundered to look keyless — stagehandModel deleted,
    // modelProvider null, "n/a-no-model" stamped — is internally consistent
    // across every modelConfig rule, and sheds the "this run used a model"
    // evidence a reader would weigh. Its own trials still record the calls.
    const { suite, results } = provenanceFixture();
    expect(Object.hasOwn(results.environment, "stagehandModel")).toBe(false);
    // The launderer edits the ENVIRONMENT, not the trial: the token block and
    // the trace that accounts for it are left exactly as the keyed run wrote
    // them, so every reconciliation check downstream still agrees with itself.
    (results.trials[0] as { tokens?: unknown }).tokens = {
      llmCalls: 4,
      inputTokens: 1200,
      outputTokens: 300
    };
    (results.trials[0] as { stepTrace?: unknown }).stepTrace = [
      { step: "extract-stats", modelCallsAtStep: 4, note: "llm call site: extract(stats)" }
    ];
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => `${v.check}: ${v.message}`)).toEqual([
      "provenance: run-a/s1-baseline-t1: the run configured no model (environment.stagehandModel absent) yet this trial records llmCalls 4, inputTokens 1200, outputTokens 300 — a run with no model cannot have spent inference, so every usage and cost counter must be zero"
    ]);
  });

  it("ATTACK-MODELCONFIG-USAGE-WITHOUT-MODEL: a modelless run whose trial zeroes only llmCalls but keeps the usage is a PROVENANCE violation", () => {
    // NAMED REGRESSION for the last deletion-shaped path: the token block's
    // fields are independent in the schema, so a launderer who strips the model
    // signal can zero the ONE counter the earlier check read and keep the rest.
    // The tokens and the cost are still the record of inference that was spent.
    const { suite, results } = provenanceFixture();
    expect(Object.hasOwn(results.environment, "stagehandModel")).toBe(false);
    (results.trials[0] as { tokens?: unknown }).tokens = {
      llmCalls: 0,
      inputTokens: 1200,
      outputTokens: 300,
      estimatedCostUsd: 1
    };
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(report.violations.map((v) => `${v.check}: ${v.message}`)).toEqual([
      "provenance: run-a/s1-baseline-t1: the run configured no model (environment.stagehandModel absent) yet this trial records inputTokens 1200, outputTokens 300, estimatedCostUsd 1 — a run with no model cannot have spent inference, so every usage and cost counter must be zero"
    ]);
  });

  it("PASS-PIN: a modelless run whose trials report tokens with llmCalls 0 verifies clean (the honest hybrid-keyless shape)", () => {
    // What a real keyless hybrid trial records: a token block is present because
    // the engine asked Stagehand for its metrics, and every counter is zero
    // because the repair path was key-gated shut. tokens null (the baseline) is
    // already covered by every other modelless fixture in this file.
    const { suite, results } = provenanceFixture();
    (results.trials[0] as { tokens?: unknown }).tokens = {
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0
    };
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("PASS-PIN: a MODEL-BEARING run whose trials record model calls verifies clean (the check is one-directional)", () => {
    // The rule catches calls without a model, never a model without calls, and
    // never calls WITH one. A keyed run that actually spent inference is the
    // ordinary case and must stay legal.
    const suite = loadSuite(["s1"]);
    const truth = generateGroundTruth(2201);
    const trial: TrialResult = {
      ...v2PassTrial("s1", truth),
      tokens: { llmCalls: 9, inputTokens: 4000, outputTokens: 800 },
      stepTrace: [
        { step: "extract-stats", modelCallsAtStep: 9, note: "llm call site: extract(stats)" }
      ]
    };
    const results = makeResults([scenario("s1", 2201)], [trial], suite.suiteHash, {
      oracles: { s1: derivedOracle(2201) },
      env: keyedEnv()
    });
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("a scenario id that names an Object.prototype member does not resolve an oracle up the prototype chain", () => {
    // `oracles` is a plain JSON object, so `oracles["constructor"]` would otherwise
    // return Object's constructor and read as a shipped oracle.
    const suite = loadSuite(["constructor"]);
    const truth = generateGroundTruth(2201);
    const results = makeResults([scenario("constructor", 2201)], [v2PassTrial("constructor", truth)], suite.suiteHash);
    const report = verifySuite([{ source: "run-a", raw: results }], suite, EXPECT_A1);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) => v.check === "grading" && /ships no oracles entry for scenario "constructor"/.test(v.message)
      )
    ).toBe(true);
  });
});
