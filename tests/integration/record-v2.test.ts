import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PRICES_PINNED_AT,
  buildDataset,
  checkOddsSchema,
  checkStatsSchema,
  normalizeOdds,
  normalizeStats,
  overallAccuracy,
  runBenchmark,
  scoreOdds,
  scoreStats
} from "@ssda/agent";
import {
  BenchmarkResultsSchema,
  createRunDir,
  loadScenarioSuite,
  type BenchmarkResults,
  type LoadedScenarioSuite,
  type ScenarioSpec
} from "@ssda/shared";
import { verifySuite } from "../../scripts/verify-suite";
import { startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * Record version 2 end to end (docs/RECORD_FORMAT.md): drive a REAL keyless
 * benchmark run through the bench runner over one scenario, then check that the
 * record it wrote is evidence-complete — it ships the rows the scorer consumed,
 * the oracle it graded them against, and the run's model/browser/price stamps —
 * and that the frozen verifier can recompute the stored accuracy from those
 * shipped inputs alone, bit for bit.
 *
 * Keyless by construction: the baseline engine makes no model call ever, and the
 * hybrid engine's repair path is key-gated, so this test never spends anything.
 * The hybrid engine is included because it is the one engine that OWNS an
 * escalation decision and therefore records a stepTrace.
 */

const SCENARIO_ID = "k-clean-extraction";

/**
 * One unperturbed scenario, seeded inside the reserved suite range (§4) so the
 * SAME spec can be handed to the runner and written into the fixture suite the
 * verifier grades against.
 */
const scenario: ScenarioSpec = {
  id: SCENARIO_ID,
  name: "clean extraction",
  description: "no perturbation — every engine should read the tables as displayed",
  chaos: [],
  seed: 2201,
  session: "fresh",
  expected: "success",
  group: "core"
};

let lab: Lab;
let tempRunsDir: string;
let prevRunsDir: string | undefined;
let benchDir: string;
let results: BenchmarkResults;
let suite: LoadedScenarioSuite;

beforeAll(async () => {
  prevRunsDir = process.env.SSDA_RUNS_DIR;
  tempRunsDir = await tmpDir("ssda-runs-v2-");
  process.env.SSDA_RUNS_DIR = tempRunsDir;

  lab = await startLab();

  const { dir, runId } = await createRunDir({ kind: "bench", labUrl: lab.url });
  benchDir = dir;
  results = await runBenchmark({
    labUrl: lab.url,
    engines: ["baseline", "hybrid"],
    scenarios: [scenario],
    trialsPerScenario: 1,
    headless: true,
    benchDir: dir,
    benchId: runId
  });

  // A scenario suite carrying the SAME oracle-defining fields as the run, so the
  // verifier's grading check has something to grade against. Only the grading
  // check is under test here; provenance/completeness are exercised elsewhere.
  const suiteFile = path.join(tempRunsDir, "suite.json");
  await writeFile(
    suiteFile,
    JSON.stringify({
      protocolId: "record-v2-fixture",
      scenarios: [
        {
          id: scenario.id,
          name: scenario.name,
          description: scenario.description,
          chaos: scenario.chaos,
          seed: scenario.seed,
          session: scenario.session,
          expected: scenario.expected,
          stratum: "K",
          stratumId: "record-v2",
          predictions: {
            A: "all-pass",
            B: "all-pass",
            B2: "all-pass",
            C: "all-pass",
            D: "all-pass"
          }
        }
      ]
    }),
    "utf8"
  );
  suite = loadScenarioSuite(suiteFile);
});

afterAll(async () => {
  await stopLab(lab);
  if (prevRunsDir === undefined) delete process.env.SSDA_RUNS_DIR;
  else process.env.SSDA_RUNS_DIR = prevRunsDir;
});

describe("record version 2 — a real keyless run ships its grading inputs", () => {
  it("writes a results.json that still parses under BenchmarkResultsSchema", async () => {
    const raw: unknown = JSON.parse(await readFile(path.join(benchDir, "results.json"), "utf8"));
    expect(BenchmarkResultsSchema.safeParse(raw).success).toBe(true);
  });

  it("stamps recordVersion 2 on every trial", () => {
    expect(results.trials.length).toBeGreaterThan(0);
    for (const t of results.trials) expect(t.recordVersion).toBe(2);
  });

  it("ships non-empty canonical rows for a passing trial", () => {
    const passing = results.trials.filter((t) => t.outcome === "pass");
    expect(passing.length).toBeGreaterThan(0);
    for (const t of passing) {
      expect(t.canonical).toBeDefined();
      expect(t.canonical!.stats).not.toBeNull();
      expect(t.canonical!.odds).not.toBeNull();
      expect(t.canonical!.stats!.length).toBeGreaterThan(0);
      expect(t.canonical!.odds!.length).toBeGreaterThan(0);
      // The dataset's own issue arrays ship too — they are what the domain
      // validator seeds its verdict from. A clean extraction records neither.
      expect(t.canonical!.failures).toEqual([]);
      expect(t.canonical!.warnings).toEqual([]);
      // …and so do the PRE-normalization payloads, which are the root of the
      // whole chain: without them the rows and annotations above would be
      // assertions rather than re-derivable claims.
      // Verbatim `unknown`: the record imposes no shape, so the test asserts
      // what the ENGINES actually produce rather than what a schema would allow.
      for (const page of ["stats", "odds"] as const) {
        const raw = t.canonical!.raw[page] as { rows?: unknown[] } | null;
        expect(raw).not.toBeNull();
        expect(Array.isArray(raw!.rows)).toBe(true);
        expect(raw!.rows!.length).toBeGreaterThan(0);
      }
    }
  });

  it("re-derives the shipped rows and annotations from the shipped raw payloads", () => {
    for (const t of results.trials) {
      if (t.canonical?.stats == null || t.canonical.odds == null) continue;
      const statsCheck = checkStatsSchema(t.canonical.raw.stats);
      const oddsCheck = checkOddsSchema(t.canonical.raw.odds);
      expect(statsCheck.ok && oddsCheck.ok).toBe(t.extractionSuccess);
      const dataset = buildDataset({
        engine: t.engine,
        source: results.labUrl,
        ...(statsCheck.parsed ? { stats: normalizeStats(statsCheck.parsed) } : {}),
        ...(oddsCheck.parsed ? { odds: normalizeOdds(oddsCheck.parsed) } : {})
      });
      expect(dataset.teams).toEqual(t.canonical.stats);
      expect(dataset.markets).toEqual(t.canonical.odds);
      expect(dataset.failures).toEqual(t.canonical.failures);
      expect(dataset.warnings).toEqual(t.canonical.warnings);
    }
  });

  it("records the scenario's oracle ONCE at the run level", () => {
    expect(results.oracles).toBeDefined();
    expect(Object.keys(results.oracles!)).toEqual([SCENARIO_ID]);
    const oracle = results.oracles![SCENARIO_ID]!;
    expect(oracle.truth.seed).toBe(scenario.seed);
    expect(oracle.truth.teams.length).toBeGreaterThan(0);
    expect(Array.isArray(oracle.overrides)).toBe(true);
  });

  it("records the run's model config and price pin", () => {
    const env = results.environment;
    // Keyless: no model was configured, so the temperature question does not arise.
    expect(env.modelConfig).toEqual({ temperature: null, temperatureSource: "n/a-no-model" });
    expect(env.pricesPinnedAt).toBe(PRICES_PINNED_AT);
  });

  it("records the browser build PER TRIAL, and summarises it at the run level only when unanimous", () => {
    // Every trial carries the build that executed it. The two engines read it from
    // different sources (Playwright's accessor vs the CDP /json/version string) and
    // neither is rewritten to match the other, so this two-engine run is honestly
    // NOT unanimous — and the run-level field must therefore be null rather than
    // silently adopting one engine's answer.
    for (const t of results.trials) {
      expect(t.chromeVersion === null || typeof t.chromeVersion === "string").toBe(true);
    }
    const reported = new Set(results.trials.map((t) => t.chromeVersion));
    const unanimous = reported.size === 1 && !reported.has(null);
    expect(results.environment.chromeVersion).toBe(unanimous ? [...reported][0] : null);
  });

  it("traces escalation for the hybrid engine and nothing for the baseline", () => {
    const hybrid = results.trials.find((t) => t.engine === "hybrid");
    expect(hybrid).toBeDefined();
    expect(hybrid!.stepTrace).toBeDefined();
    expect(hybrid!.stepTrace!.length).toBeGreaterThan(0);
    // Keyless, repair-mode llm: a trigger may fire, but no repair can be attempted
    // and none can succeed — the four facts stay distinct.
    for (const entry of hybrid!.stepTrace!) {
      expect(entry.step.length).toBeGreaterThan(0);
      if (entry.repairAttempted !== undefined) expect(entry.repairAttempted).toBe(false);
      if (entry.repairSucceeded !== undefined) expect(entry.repairSucceeded).toBe(false);
      if (entry.modelCallsAtStep !== undefined) expect(entry.modelCallsAtStep).toBe(0);
    }
    // The trace reconciles against the trial's own token evidence.
    const traced = hybrid!.stepTrace!.reduce((sum, e) => sum + (e.modelCallsAtStep ?? 0), 0);
    expect(traced).toBe(hybrid!.tokens?.llmCalls ?? 0);
    // The baseline has no escalation machinery, so it claims no trace at all.
    const baseline = results.trials.find((t) => t.engine === "baseline");
    expect(baseline).toBeDefined();
    expect(baseline!.stepTrace).toBeUndefined();
  });

  it("recomputes the stored accuracy EXACTLY from the shipped rows and oracle", () => {
    const oracle = results.oracles![SCENARIO_ID]!;
    for (const t of results.trials) {
      if (t.accuracy === null) continue;
      const stats = scoreStats(t.canonical!.stats!, oracle.truth, oracle.overrides);
      const odds = scoreOdds(t.canonical!.odds!, oracle.truth, oracle.overrides);
      expect(stats).toEqual(t.accuracy.stats);
      expect(odds).toEqual(t.accuracy.odds);
      expect(overallAccuracy(stats, odds)).toBe(t.accuracy.overall);
    }
  });

  it("passes the verifier's GRADING check, which recomputes from the shipped rows", () => {
    const report = verifySuite([{ source: "run-a", raw: results }], suite, {
      policies: ["A"],
      trials: 1
    });
    // Only grading is asserted: this is a two-engine catalog run in a dirty tree,
    // so provenance and completeness legitimately complain and are not the subject.
    expect(report.violations.filter((v) => v.check === "grading")).toEqual([]);
    expect(report.records.recomputed).toBe(results.trials.length);
    expect(report.records.attestedV1).toBe(0);
  });

  it("flags a tampered canonical row as a GRADING violation (it no longer follows from the raw payload)", () => {
    const passing = results.trials.find((t) => t.outcome === "pass" && t.accuracy !== null)!;
    const rows = [...passing.canonical!.stats!];
    rows[0] = { ...rows[0]!, goalsFor: (rows[0]!.goalsFor ?? 0) + 7 };
    const tampered: BenchmarkResults = {
      ...results,
      trials: results.trials.map((t) =>
        t === passing ? { ...t, canonical: { ...t.canonical!, stats: rows } } : t
      )
    };
    const report = verifySuite([{ source: "run-a", raw: tampered }], suite, {
      policies: ["A"],
      trials: 1
    });
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /shipped canonical stats rows do not follow from the shipped raw payloads/.test(v.message)
      )
    ).toBe(true);
  });

  it("flags a tampered RAW payload as a GRADING violation (the whole chain moves)", () => {
    const passing = results.trials.find((t) => t.outcome === "pass" && t.accuracy !== null)!;
    const raw = structuredClone(passing.canonical!.raw) as {
      stats: { rows: Record<string, unknown>[] };
      odds: unknown;
    };
    const first = raw.stats.rows[0] as { goalsFor: number };
    raw.stats.rows[0] = { ...first, goalsFor: first.goalsFor + 7 };
    const tampered: BenchmarkResults = {
      ...results,
      trials: results.trials.map((t) =>
        t === passing ? { ...t, canonical: { ...t.canonical!, raw } } : t
      )
    };
    const report = verifySuite([{ source: "run-a", raw: tampered }], suite, {
      policies: ["A"],
      trials: 1
    });
    expect(
      report.violations.some(
        (v) =>
          v.check === "grading" &&
          /recorded accuracy does not follow from the shipped raw payloads/.test(v.message)
      )
    ).toBe(true);
  });
});
