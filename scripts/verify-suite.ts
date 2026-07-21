/**
 * Generic suite verifier (PROTOCOL_2A §5 item 5). Replaces per-engine verify.ts
 * editing: the acceptance logic is frozen at stage 1 and there is NO per-scenario
 * code, ever.
 *
 *   pnpm verify:suite <runDir...> --suite <scenario-suite.json> \
 *     --expect-policies <A,B,B2,C,D subset> --expect-trials <n>
 *
 * The caller DECLARES the expected experiment grid: which frozen policies must be
 * present and how many independent sweeps (distinct runs) each (scenario × policy)
 * cell must carry. The verifier refuses to certify anything that does not match
 * that grid exactly — a partial campaign, a policy presented under the wrong label
 * (e.g. `hybrid-keyless` masquerading as C), or N trials smuggled out of one run.
 *
 * For every run directory's results.json it checks, and GATES on (exit nonzero
 * only when one of these is violated):
 *   (a) SCHEMA        — results.json validates under BenchmarkResultsSchema.
 *   (b) PROVENANCE    — the reproducibility stamps are present and uniform
 *                       (gitCommit, gitDirty:false, promptsHash, lockfileHash,
 *                       protocolId, suiteHash, and repairMode for hybrid runs),
 *                       and protocolId/suiteHash match the supplied suite.
 *   (c) COMPLETENESS  — the observed runs realise the declared expect-grid EXACTLY:
 *                       each expected policy maps (string equality, no predicates)
 *                       to ONE admissible configuration label; every suite scenario
 *                       × expected policy cell holds exactly expect.trials trials;
 *                       those trials come from expect.trials DISTINCT runs (one
 *                       sweep each); no configuration outside the expected images
 *                       appears; no two inputs share a benchId or carry identical
 *                       trial content (a relabeled copy is not a distinct sweep);
 *                       every trial's artifactsDir embeds its run's own benchId; and
 *                       every trial's scenario is present in the supplied suite.
 *   (d) GRADING       — the recorded verdict/reason/outcomeClass equal a
 *                       recomputation from the raw recorded trial data plus the
 *                       SUPPLIED SUITE's scenario oracle (never the run's own
 *                       recorded oracle), using the SAME frozen judge/classifier
 *                       the runner uses (imported, never reimplemented). The run's
 *                       recorded scenario is ALSO cross-checked against the suite
 *                       (id/seed/chaos/params/session/expected); any divergence is
 *                       a grading violation.
 *
 * It ALSO scores sol's per-policy prediction table (§4a). FROZEN SEMANTICS
 * (auditor-required, do not weaken): a judged POLICY failure is admissible evidence
 * and NEVER fails the verifier; the verifier gates only completeness, provenance,
 * schema validity, and grading consistency; prediction misses are report-only and
 * never gate. All 2A scenarios are `expected: success`, so policy failures against
 * them are the measurement, not a defect.
 *
 * SCOPE (honest boundary): the verifier checks the structure and internal
 * consistency of self-reported evidence files — it detects copy-based forgery (a
 * relabeled run, a shared benchId, a benchId edited without touching the trial
 * artifact paths) but cannot cryptographically prove two files came from separate
 * executions; fabricated fresh content is countered by publishing raw run
 * artifacts, not by this tool.
 *
 * Pure verification core (verifySuite) is unit-testable; the CLI is only file I/O.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BenchmarkResultsSchema,
  loadScenarioSuite,
  suiteScenarioToSpec,
  type BenchmarkResults,
  type LoadedScenarioSuite,
  type Prediction,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import { classifyOutcome, configurationLabel, judge } from "@ssda/agent";

// ── Result shapes ────────────────────────────────────────────────────────────

export type VerifyCheck = "schema" | "provenance" | "completeness" | "grading";

/** The five frozen engine policies (PROTOCOL_2A §1). */
export type Policy = "A" | "B" | "B2" | "C" | "D";

/** The expected experiment grid the caller certifies against (see verifySuite). */
export interface ExpectGrid {
  policies: Policy[];
  trials: number;
}

export interface Violation {
  check: VerifyCheck;
  message: string;
}

/** One (scenario × policy) prediction outcome — report-only (§4a). */
export interface PredictionScore {
  scenarioId: string;
  policy: Policy;
  predicted: Prediction;
  /** Judged pass count / trial count for the mapped configuration, or null if it never ran. */
  observed: { pass: number; total: number } | null;
  status: "hit" | "miss" | "not-run";
}

export interface VerifyReport {
  ok: boolean;
  violations: Violation[];
  predictions: PredictionScore[];
  notes: string[];
}

/** A run paired with the source label used in messages. */
export interface VerifyInput {
  source: string;
  raw: unknown;
}

const ALL_POLICIES: readonly Policy[] = ["A", "B", "B2", "C", "D"];

/**
 * Policy → its SINGLE admissible configuration label (see campaign.configurationLabel),
 * matched by string equality — NO predicates. Phase 2A is cold-only, so C admits only
 * `C-hybrid-repair-cold` (persistence/warm/seeded C labels are inadmissible). Note
 * `hybrid-keyless` is the image of NO policy: it can never count toward C (or anything).
 */
const POLICY_LABEL: Record<Policy, string> = {
  A: "A-baseline",
  B: "B-structural",
  B2: "B2-deterministic-repair",
  C: "C-hybrid-repair-cold",
  D: "D-full-semantic"
};

const AUTH_ERROR_PATTERNS = /401|authentication|invalid x-api-key|unauthorized/i;

function reason(check: VerifyCheck, message: string): Violation {
  return { check, message };
}

/** Join source labels for a message: `"a" and "b"`, or `"a", "b" and "c"`. */
function joinSources(sources: string[]): string {
  const quoted = sources.map((s) => `"${s}"`);
  if (quoted.length <= 1) return quoted[0] ?? "";
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * Reconstruct the minimal PipelineResult the frozen judge reads from a recorded
 * TrialResult. The recorded trial data is the raw evidence; the judge reads
 * success, failureCategory/Detail, and (for reuse sessions / success-with-warnings
 * only) steps/normalized — neither of which is recorded. Phase-2A is fresh-session
 * and `expected: success` throughout (§3), so those unreconstructable branches
 * never fire; a reuse or success-with-warnings scenario would be out of scope.
 */
function pseudoResult(t: TrialResult): Parameters<typeof judge>[1] {
  const partial = {
    success: t.pipelineSuccess,
    steps: [] as never[],
    ...(t.failureCategory ? { failureCategory: t.failureCategory } : {}),
    ...(t.failureDetail ? { failureDetail: t.failureDetail } : {})
  };
  return partial as unknown as Parameters<typeof judge>[1];
}

/**
 * The oracle-defining fields of a scenario, normalized so absent chaos/params and
 * key ordering never masquerade as divergence: chaos is order-insensitive and
 * params collapses to null when absent. Used to cross-check a run's recorded
 * scenario against the supplied suite (check d).
 */
function oracleFields(s: ScenarioSpec): Record<string, unknown> {
  return {
    id: s.id,
    seed: s.seed,
    chaos: [...s.chaos].sort(),
    params: s.params ?? null,
    session: s.session,
    expected: s.expected
  };
}

/** First oracle field on which `recorded` diverges from `suiteSpec`, or null. */
function firstOracleDivergence(recorded: ScenarioSpec, suiteSpec: ScenarioSpec): string | null {
  const a = oracleFields(recorded);
  const b = oracleFields(suiteSpec);
  for (const field of ["id", "seed", "chaos", "params", "session", "expected"] as const) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) return field;
  }
  return null;
}

/**
 * The pure verification core. Accepts already-read run inputs (source + raw
 * results.json content), the loaded suite, and the EXPECTED grid the caller
 * certifies against (which policies must be present, and how many distinct sweeps
 * per cell). Returns every gate violation plus the report-only prediction scores.
 * Never throws on a policy failure or a prediction miss.
 */
export function verifySuite(
  inputs: VerifyInput[],
  suite: LoadedScenarioSuite,
  expect: ExpectGrid
): VerifyReport {
  const violations: Violation[] = [];
  const notes: string[] = [];

  // The expected policies in canonical order (deterministic output), and the set
  // of configuration labels those policies may legitimately appear under.
  const expectedPolicies = ALL_POLICIES.filter((p) => expect.policies.includes(p));
  const imageLabels = new Set(expectedPolicies.map((p) => POLICY_LABEL[p]));

  // (a) SCHEMA — parse each run; a failure excludes it from later checks.
  const runs: { source: string; results: BenchmarkResults }[] = [];
  for (const input of inputs) {
    const parsed = BenchmarkResultsSchema.safeParse(input.raw);
    if (!parsed.success) {
      violations.push(
        reason(
          "schema",
          `${input.source}: results.json failed BenchmarkResultsSchema — ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`
        )
      );
      continue;
    }
    runs.push({ source: input.source, results: parsed.data });
  }

  if (runs.length === 0) {
    return { ok: violations.length === 0, violations, predictions: [], notes };
  }

  // A run halted by the pre-trial budget stop (PROTOCOL_2A §7) carries `stopped`.
  // Surface it as a NOTE for the human reader — never a violation. The
  // completeness checks below already catch the shortfall a stopped run leaves in
  // the grid; this note just explains WHY the campaign is incomplete evidence.
  for (const { source, results } of runs) {
    if (results.stopped) {
      notes.push(
        `${source}: run is marked stopped (${results.stopped.reason}) — incomplete campaign evidence`
      );
    }
  }

  // (b) PROVENANCE — per-run presence + cross-run uniformity + suite match.
  const stampSets = {
    gitCommit: new Set<string>(),
    promptsHash: new Set<string>(),
    lockfileHash: new Set<string>(),
    protocolId: new Set<string>(),
    suiteHash: new Set<string>()
  };
  for (const { source, results } of runs) {
    const env = results.environment;
    if (env.gitCommit == null) violations.push(reason("provenance", `${source}: gitCommit is missing`));
    else stampSets.gitCommit.add(env.gitCommit);
    if (env.gitDirty !== false) {
      violations.push(reason("provenance", `${source}: gitDirty must be false (got ${env.gitDirty})`));
    }
    if (!env.promptsHash) violations.push(reason("provenance", `${source}: promptsHash is missing`));
    else stampSets.promptsHash.add(env.promptsHash);
    if (!env.lockfileHash) violations.push(reason("provenance", `${source}: lockfileHash is missing`));
    else stampSets.lockfileHash.add(env.lockfileHash);
    if (!env.protocolId) violations.push(reason("provenance", `${source}: protocolId is missing`));
    else stampSets.protocolId.add(env.protocolId);
    if (!env.suiteHash) violations.push(reason("provenance", `${source}: suiteHash is missing`));
    else stampSets.suiteHash.add(env.suiteHash);
    // repairMode is required where applicable: a run that exercised the hybrid engine.
    const hasHybrid = results.trials.some((t) => t.engine === "hybrid");
    if (hasHybrid && env.repairMode === undefined) {
      violations.push(reason("provenance", `${source}: repairMode is missing for a hybrid run`));
    }
    if (env.protocolId !== undefined && env.protocolId !== suite.protocolId) {
      violations.push(
        reason(
          "provenance",
          `${source}: protocolId "${env.protocolId}" does not match the supplied suite "${suite.protocolId}"`
        )
      );
    }
    if (env.suiteHash !== undefined && env.suiteHash !== suite.suiteHash) {
      violations.push(
        reason(
          "provenance",
          `${source}: suiteHash "${env.suiteHash}" does not match the supplied suite hash "${suite.suiteHash}"`
        )
      );
    }
  }
  for (const [field, values] of Object.entries(stampSets)) {
    if (values.size > 1) {
      violations.push(
        reason("provenance", `runs disagree on environment.${field}: ${[...values].join(", ")}`)
      );
    }
  }

  // (c) COMPLETENESS — the observed runs must realise the declared expect-grid.
  const suiteIds = suite.scenarios.map((s) => s.id);
  const suiteIdSet = new Set(suiteIds);

  // Per-cell tallies keyed by (scenarioId, configurationLabel).
  const cellKey = (scenarioId: string, config: string) => `${scenarioId} ${config}`;
  const cellTrials = new Map<string, number>(); // trial count in the cell
  const cellBenchIds = new Map<string, Set<string>>(); // distinct source runs contributing
  const observedConfigCount = new Map<string, number>(); // total trials per observed label
  const reportedForeign = new Set<string>(); // dedupe the not-in-suite message per (source, id)
  for (const { source, results } of runs) {
    let artifactsMismatch = 0;
    let firstBadArtifactsDir: string | undefined;
    for (const t of results.trials) {
      const config = configurationLabel(t.engine, results.environment);
      observedConfigCount.set(config, (observedConfigCount.get(config) ?? 0) + 1);
      const key = cellKey(t.scenarioId, config);
      cellTrials.set(key, (cellTrials.get(key) ?? 0) + 1);
      let ids = cellBenchIds.get(key);
      if (!ids) {
        ids = new Set<string>();
        cellBenchIds.set(key, ids);
      }
      ids.add(results.benchId);
      // c.5 — every trial's scenario must be in the supplied suite.
      if (!suiteIdSet.has(t.scenarioId)) {
        const fk = `${source} ${t.scenarioId}`;
        if (!reportedForeign.has(fk)) {
          reportedForeign.add(fk);
          violations.push(
            reason("completeness", `${source}: trial for scenario "${t.scenarioId}" not present in the supplied suite`)
          );
        }
      }
      // c.6 — internal consistency: every trial's artifactsDir embeds the run's own
      // benchId (the runner writes each trial under runs/<benchId>/...; verified to
      // hold on every real results.json). A trial whose artifactsDir omits the
      // recorded benchId means the file is self-inconsistent — the exact tell of a
      // relabeled copy whose benchId field was edited but whose trial artifact paths
      // were not.
      if (!t.artifactsDir.includes(results.benchId)) {
        artifactsMismatch += 1;
        if (firstBadArtifactsDir === undefined) firstBadArtifactsDir = t.artifactsDir;
      }
    }
    if (artifactsMismatch > 0) {
      violations.push(
        reason(
          "completeness",
          `${source}: ${artifactsMismatch} of ${results.trials.length} trial(s) have an artifactsDir not containing the run's benchId "${results.benchId}" (e.g. "${firstBadArtifactsDir}") — a relabeled copy whose benchId was edited but whose trial artifact paths were not`
        )
      );
    }
  }

  // c.1 exact per-cell trial count + c.2 distinct-run sweep count, per expected policy.
  for (const policy of expectedPolicies) {
    const label = POLICY_LABEL[policy];
    let policyTotal = 0;
    for (const id of suiteIds) policyTotal += cellTrials.get(cellKey(id, label)) ?? 0;
    // A policy entirely absent gets ONE aggregated line — never one per scenario.
    if (policyTotal === 0) {
      violations.push(reason("completeness", `policy ${policy} ("${label}"): no trials for any suite scenario`));
      continue;
    }
    // c.1 — exact trial count per (scenario, policy) cell.
    for (const id of suiteIds) {
      const got = cellTrials.get(cellKey(id, label)) ?? 0;
      if (got !== expect.trials) {
        violations.push(
          reason("completeness", `policy ${policy} ("${label}") scenario "${id}": got ${got} trial(s), want ${expect.trials}`)
        );
      }
    }
    // c.2 — the trials in each correctly-counted cell must come from expect.trials
    // DISTINCT runs (one sweep each). Cells that already fail c.1 are c.1's to report.
    const badDistinct: { id: string; distinct: number }[] = [];
    for (const id of suiteIds) {
      const got = cellTrials.get(cellKey(id, label)) ?? 0;
      if (got !== expect.trials) continue;
      const distinct = cellBenchIds.get(cellKey(id, label))?.size ?? 0;
      if (distinct !== expect.trials) badDistinct.push({ id, distinct });
    }
    if (badDistinct.length > 0) {
      if (badDistinct.length === suiteIds.length) {
        // Holds for every scenario → aggregate to one readable line.
        const distincts = [...new Set(badDistinct.map((b) => b.distinct))].sort((a, b) => a - b).join("/");
        violations.push(
          reason(
            "completeness",
            `policy ${policy} ("${label}"): each scenario's ${expect.trials} trials come from ${distincts} distinct run(s), need ${expect.trials} distinct sweep(s) (a single run's repeated trials are not separate sweeps)`
          )
        );
      } else {
        for (const b of badDistinct) {
          violations.push(
            reason(
              "completeness",
              `policy ${policy} ("${label}") scenario "${b.id}": ${expect.trials} trials come from ${b.distinct} distinct run(s), need ${expect.trials} distinct sweep(s)`
            )
          );
        }
      }
    }
  }

  // c.3 — any observed configuration that is not the image of an expected policy.
  // Catches hybrid-keyless presented as C, seeded/warm C variants, smoke prefixes, etc.
  for (const config of [...observedConfigCount.keys()].sort()) {
    if (imageLabels.has(config)) continue;
    const n = observedConfigCount.get(config) ?? 0;
    violations.push(
      reason(
        "completeness",
        `unexpected configuration "${config}" (${n} trial(s)) — not among expected policies [${expectedPolicies.join(", ")}]`
      )
    );
  }

  // c.4 — duplicate-run rejection: shared benchId, or identical TRIAL CONTENT. The
  // trial-content hash covers ONLY results.scenarios + results.trials, so the
  // caller-editable top-level identity fields (benchId, createdAt) are excluded by
  // construction — a relabeled `cp results.json` with one field edited no longer
  // slips past as a "distinct sweep" (pre-tag audit finding). Genuine separate
  // sweeps always differ (distinct wall-clock durationMs at minimum), so this never
  // false-positives on real runs.
  const benchIdCounts = new Map<string, number>();
  const trialContentSources = new Map<string, string[]>();
  const createdAtSources = new Map<string, string[]>();
  for (const { source, results } of runs) {
    benchIdCounts.set(results.benchId, (benchIdCounts.get(results.benchId) ?? 0) + 1);
    const trialHash = createHash("sha256")
      .update(JSON.stringify({ scenarios: results.scenarios, trials: results.trials }))
      .digest("hex");
    const tBucket = trialContentSources.get(trialHash);
    if (tBucket) tBucket.push(source);
    else trialContentSources.set(trialHash, [source]);
    const cBucket = createdAtSources.get(results.createdAt);
    if (cBucket) cBucket.push(source);
    else createdAtSources.set(results.createdAt, [source]);
  }
  for (const [benchId, count] of benchIdCounts) {
    if (count > 1) {
      violations.push(
        reason("completeness", `duplicate benchId "${benchId}" appears in ${count} run inputs — each sweep must be a distinct run`)
      );
    }
  }
  for (const sources of trialContentSources.values()) {
    if (sources.length > 1) {
      violations.push(
        reason(
          "completeness",
          `inputs ${joinSources(sources)} contain identical trial content — a relabeled copy of one run is not a distinct sweep`
        )
      );
    }
  }
  // c.4 advisory (NEVER a violation): a top-level createdAt shared across inputs is
  // suspicious — independent sweeps start at different wall-clock times — but not
  // conclusive on its own, so it is surfaced as a NOTE only.
  for (const [createdAt, sources] of createdAtSources) {
    if (sources.length > 1) {
      notes.push(
        `NOTE: inputs ${joinSources(sources)} share an identical createdAt "${createdAt}" — suspicious for independent sweeps, but not conclusive`
      );
    }
  }

  // (d) GRADING — recompute the judge + classifier from raw trial data against the
  // SUPPLIED SUITE's oracle (never the run's own recorded scenario), and cross-check
  // that the run's recorded oracle agrees with the suite.
  const oracleById = new Map<string, ScenarioSpec>(suite.scenarios.map((s) => [s.id, suiteScenarioToSpec(s)]));
  for (const { source, results } of runs) {
    const recordedById = new Map<string, ScenarioSpec>(results.scenarios.map((s) => [s.id, s]));
    const crossChecked = new Set<string>(); // once per scenario per run
    for (const t of results.trials) {
      const suiteSpec = oracleById.get(t.scenarioId);
      // A trial whose scenario is not in the suite is a completeness violation
      // already; there is no oracle to grade it against, so skip grading.
      if (!suiteSpec) continue;

      // Cross-check the run's recorded oracle against the supplied suite (once).
      if (!crossChecked.has(t.scenarioId)) {
        crossChecked.add(t.scenarioId);
        const recorded = recordedById.get(t.scenarioId);
        if (!recorded) {
          violations.push(
            reason("grading", `${source}: no scenario "${t.scenarioId}" in the run's recorded scenarios`)
          );
        } else {
          const field = firstOracleDivergence(recorded, suiteSpec);
          if (field) {
            violations.push(
              reason("grading", `run-recorded scenario oracle for "${t.scenarioId}" diverges from the supplied suite (${field})`)
            );
          }
        }
      }

      const overall = t.accuracy?.overall;
      const reports = t.accuracy ? { stats: t.accuracy.stats, odds: t.accuracy.odds } : undefined;
      const recomputed = judge(suiteSpec, pseudoResult(t), overall, reports);
      const recomputedClass = classifyOutcome({
        pipelineSuccess: t.pipelineSuccess,
        overall,
        expected: suiteSpec.expected,
        ...(t.healedSteps ? { healedSteps: t.healedSteps } : {}),
        ...(t.failureCategory ? { failureCategory: t.failureCategory } : {})
      });
      if (recomputed.outcome !== t.outcome) {
        violations.push(
          reason("grading", `${source}/${t.runId}: recorded outcome "${t.outcome}" ≠ recomputed "${recomputed.outcome}"`)
        );
      }
      if (recomputed.reason !== t.outcomeReason) {
        violations.push(
          reason(
            "grading",
            `${source}/${t.runId}: recorded outcomeReason ≠ recomputed.\n    recorded:   ${t.outcomeReason}\n    recomputed: ${recomputed.reason}`
          )
        );
      }
      if (recomputedClass !== t.outcomeClass) {
        violations.push(
          reason("grading", `${source}/${t.runId}: recorded outcomeClass "${t.outcomeClass}" ≠ recomputed "${recomputedClass}"`)
        );
      }
      // Advisory only (never a gate): a policy/auth error should never appear.
      if (t.failureDetail && AUTH_ERROR_PATTERNS.test(t.failureDetail)) {
        notes.push(`${source}/${t.runId}: NOTE failureDetail mentions a provider/auth error — ${t.failureDetail}`);
      }
    }
  }

  // (e) PREDICTIONS — report-only scoring (§4a). Never a violation. Scored with the
  // same EXACT-match map; policies not in expect.policies typically show not-run.
  const predictions: PredictionScore[] = [];
  const passTotalFor = (scenarioId: string, label: string) => {
    let pass = 0;
    let total = 0;
    for (const { results } of runs) {
      for (const t of results.trials) {
        if (t.scenarioId !== scenarioId) continue;
        if (configurationLabel(t.engine, results.environment) !== label) continue;
        total += 1;
        if (t.outcome === "pass") pass += 1;
      }
    }
    return total === 0 ? null : { pass, total };
  };
  for (const scenario of suite.scenarios) {
    for (const policy of ALL_POLICIES) {
      const predicted = scenario.predictions[policy];
      const observed = passTotalFor(scenario.id, POLICY_LABEL[policy]);
      let status: PredictionScore["status"];
      if (observed === null) status = "not-run";
      else {
        const allPass = observed.pass === observed.total; // observed N/N
        const hit = predicted === "all-pass" ? allPass : !allPass;
        status = hit ? "hit" : "miss";
      }
      predictions.push({ scenarioId: scenario.id, policy, predicted, observed, status });
    }
  }

  return { ok: violations.length === 0, violations, predictions, notes };
}

/** Render a VerifyReport to a deterministic, human-readable block. */
export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push("# Suite verification");
  lines.push("");
  const byCheck = (check: VerifyCheck) => report.violations.filter((v) => v.check === check);
  for (const check of ["schema", "provenance", "completeness", "grading"] as const) {
    const vs = byCheck(check);
    lines.push(`## ${check}: ${vs.length === 0 ? "OK" : `${vs.length} violation(s)`}`);
    for (const v of vs) lines.push(`  - ${v.message}`);
  }
  lines.push("");
  lines.push("## predictions (report-only — never a gate)");
  const hits = report.predictions.filter((p) => p.status === "hit").length;
  const misses = report.predictions.filter((p) => p.status === "miss");
  const notRun = report.predictions.filter((p) => p.status === "not-run").length;
  lines.push(`  ${hits} hit · ${misses.length} miss · ${notRun} not-run`);
  for (const p of misses) {
    const obs = p.observed ? `${p.observed.pass}/${p.observed.total}` : "—";
    lines.push(`  - MISS ${p.scenarioId} policy ${p.policy}: predicted ${p.predicted}, observed ${obs}`);
  }
  if (report.notes.length > 0) {
    lines.push("");
    lines.push("## notes");
    for (const n of report.notes) lines.push(`  - ${n}`);
  }
  lines.push("");
  lines.push(report.ok ? "VERIFY: PASS" : "VERIFY: FAIL");
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE =
  "Usage: pnpm verify:suite <runDir...> --suite <scenario-suite.json> " +
  "--expect-policies <A,B,B2,C,D subset> --expect-trials <n>";

function bail(message: string): never {
  console.error(message);
  process.exit(2); // 2 = usage error (distinct from a verification FAIL exit 1)
}

interface CliArgs {
  runDirs: string[];
  suiteFile: string;
  expect: ExpectGrid;
}

/** Parse + validate --expect-policies / --expect-trials into an ExpectGrid (bails on invalid). */
export function parseExpectGrid(policiesCsv: string, trialsRaw: string): ExpectGrid {
  const tokens = policiesCsv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) {
    bail(`--expect-policies must be a nonempty subset of ${ALL_POLICIES.join(",")}`);
  }
  const policies: Policy[] = [];
  for (const tok of tokens) {
    if (!ALL_POLICIES.includes(tok as Policy)) {
      bail(`--expect-policies has an unknown policy "${tok}" (valid: ${ALL_POLICIES.join(", ")})`);
    }
    if (policies.includes(tok as Policy)) {
      bail(`--expect-policies has a duplicate policy "${tok}"`);
    }
    policies.push(tok as Policy);
  }
  if (!/^\d+$/.test(trialsRaw)) {
    bail(`--expect-trials must be a positive integer (got "${trialsRaw}")`);
  }
  const trials = Number.parseInt(trialsRaw, 10);
  if (!Number.isInteger(trials) || trials <= 0) {
    bail(`--expect-trials must be a positive integer (got "${trialsRaw}")`);
  }
  return { policies, trials };
}

export function parseVerifyArgs(argv: string[]): CliArgs {
  const runDirs: string[] = [];
  let suiteFile: string | undefined;
  let policiesCsv: string | undefined;
  let trialsRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === "--") continue;
    if (arg === "--suite") {
      suiteFile = argv[++i];
      if (!suiteFile) bail("--suite needs a path to a scenario-suite JSON");
    } else if (arg === "--expect-policies") {
      policiesCsv = argv[++i];
      if (policiesCsv === undefined) bail("--expect-policies needs a comma-separated subset of A,B,B2,C,D");
    } else if (arg === "--expect-trials") {
      trialsRaw = argv[++i];
      if (trialsRaw === undefined) bail("--expect-trials needs a positive integer");
    } else if (!arg.startsWith("--")) {
      runDirs.push(arg);
    } else {
      bail(`Unexpected flag "${arg}". ${USAGE}`);
    }
  }
  if (!suiteFile) bail(USAGE);
  if (runDirs.length === 0) bail(USAGE);
  if (policiesCsv === undefined) bail(USAGE);
  if (trialsRaw === undefined) bail(USAGE);
  const expect = parseExpectGrid(policiesCsv, trialsRaw);
  return { runDirs: runDirs.map((d) => path.resolve(d)), suiteFile: path.resolve(suiteFile), expect };
}

function main(): void {
  const args = parseVerifyArgs(process.argv.slice(2));
  let suite: LoadedScenarioSuite;
  try {
    suite = loadScenarioSuite(args.suiteFile);
  } catch (error) {
    bail(`Could not load --suite ${args.suiteFile}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const inputs: VerifyInput[] = [];
  for (const dir of args.runDirs) {
    const file = path.join(dir, "results.json");
    if (!existsSync(file)) bail(`No results.json at ${file}`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      bail(`results.json at ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    inputs.push({ source: path.relative(process.cwd(), file), raw });
  }

  const report = verifySuite(inputs, suite!, args.expect);
  console.log(formatReport(report));
  // Exit nonzero ONLY on (a)-(d) violations — never on a prediction miss or a
  // judged policy failure.
  process.exit(report.ok ? 0 : 1);
}

const isEntrypoint =
  !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isEntrypoint) main();
