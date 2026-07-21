/**
 * Generic suite verifier (PROTOCOL_2A §5 item 5). Replaces per-engine verify.ts
 * editing: the acceptance logic is frozen at stage 1 and there is NO per-scenario
 * code, ever.
 *
 *   pnpm verify:suite <runDir...> --suite <scenario-suite.json>
 *
 * For every run directory's results.json it checks, and GATES on (exit nonzero
 * only when one of these is violated):
 *   (a) SCHEMA        — results.json validates under BenchmarkResultsSchema.
 *   (b) PROVENANCE    — the reproducibility stamps are present and uniform
 *                       (gitCommit, gitDirty:false, promptsHash, lockfileHash,
 *                       protocolId, suiteHash, and repairMode for hybrid runs),
 *                       and protocolId/suiteHash match the supplied suite.
 *   (c) COMPLETENESS  — every suite scenario × every observed configuration is
 *                       present with a uniform trial count.
 *   (d) GRADING       — the recorded verdict/reason/outcomeClass equal a
 *                       recomputation from the raw recorded trial data plus the
 *                       scenario oracle, using the SAME frozen judge/classifier
 *                       the runner uses (imported, never reimplemented).
 *
 * It ALSO scores sol's per-policy prediction table (§4a) REPORT-ONLY: a
 * prediction miss is printed and never fails the verifier. A judged POLICY
 * failure is admissible evidence and NEVER fails the verifier — all 2A scenarios
 * are `expected: success`, so policy failures against them are the measurement.
 *
 * Pure verification core (verifySuite) is unit-testable; the CLI is only file I/O.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BenchmarkResultsSchema,
  loadScenarioSuite,
  type BenchmarkResults,
  type LoadedScenarioSuite,
  type Prediction,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import { classifyOutcome, configurationLabel, judge } from "@ssda/agent";

// ── Result shapes ────────────────────────────────────────────────────────────

export type VerifyCheck = "schema" | "provenance" | "completeness" | "grading";

export interface Violation {
  check: VerifyCheck;
  message: string;
}

/** One (scenario × policy) prediction outcome — report-only (§4a). */
export interface PredictionScore {
  scenarioId: string;
  policy: "A" | "B" | "B2" | "C" | "D";
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

// Policy → the configuration label(s) it maps to (see campaign.configurationLabel).
const POLICY_CONFIGS: Record<PredictionScore["policy"], (config: string) => boolean> = {
  A: (c) => c === "A-baseline",
  B: (c) => c === "B-structural",
  B2: (c) => c === "B2-deterministic-repair",
  C: (c) => c.startsWith("C-hybrid-repair") || c === "hybrid-keyless",
  D: (c) => c === "D-full-semantic"
};

const AUTH_ERROR_PATTERNS = /401|authentication|invalid x-api-key|unauthorized/i;

function reason(check: VerifyCheck, message: string): Violation {
  return { check, message };
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
 * The pure verification core. Accepts already-read run inputs (source + raw
 * results.json content) plus the loaded suite, and returns every gate violation
 * plus the report-only prediction scores. Never throws on a policy failure or a
 * prediction miss.
 */
export function verifySuite(inputs: VerifyInput[], suite: LoadedScenarioSuite): VerifyReport {
  const violations: Violation[] = [];
  const notes: string[] = [];

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

  // (c) COMPLETENESS — every suite scenario × observed configuration, uniform N.
  const suiteIds = suite.scenarios.map((s) => s.id);
  const suiteIdSet = new Set(suiteIds);
  const observedConfigs = new Set<string>();
  const cellCounts = new Map<string, number>(); // `${scenarioId}${config}` → trial count
  const cellKey = (scenarioId: string, config: string) => `${scenarioId}${config}`;
  for (const { source, results } of runs) {
    for (const t of results.trials) {
      const config = configurationLabel(t.engine, results.environment);
      observedConfigs.add(config);
      cellCounts.set(cellKey(t.scenarioId, config), (cellCounts.get(cellKey(t.scenarioId, config)) ?? 0) + 1);
      if (!suiteIdSet.has(t.scenarioId)) {
        violations.push(
          reason("completeness", `${source}: trial for scenario "${t.scenarioId}" not present in the supplied suite`)
        );
      }
    }
  }
  const presentCounts = new Set<number>();
  for (const config of observedConfigs) {
    for (const scenarioId of suiteIds) {
      const count = cellCounts.get(cellKey(scenarioId, config)) ?? 0;
      if (count === 0) {
        violations.push(
          reason("completeness", `missing sweep: scenario "${scenarioId}" has no trials for configuration "${config}"`)
        );
      } else {
        presentCounts.add(count);
      }
    }
  }
  if (presentCounts.size > 1) {
    violations.push(
      reason("completeness", `non-uniform trial counts across cells: ${[...presentCounts].sort((a, b) => a - b).join(", ")}`)
    );
  }

  // (d) GRADING — recompute the judge + classifier from raw trial data + oracle.
  for (const { source, results } of runs) {
    const byId = new Map<string, ScenarioSpec>(results.scenarios.map((s) => [s.id, s]));
    for (const t of results.trials) {
      const scenario = byId.get(t.scenarioId);
      if (!scenario) {
        violations.push(
          reason("grading", `${source}/${t.runId}: no scenario "${t.scenarioId}" in the run's recorded scenarios`)
        );
        continue;
      }
      const overall = t.accuracy?.overall;
      const reports = t.accuracy ? { stats: t.accuracy.stats, odds: t.accuracy.odds } : undefined;
      const recomputed = judge(scenario, pseudoResult(t), overall, reports);
      const recomputedClass = classifyOutcome({
        pipelineSuccess: t.pipelineSuccess,
        overall,
        expected: scenario.expected,
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

  // (e) PREDICTIONS — report-only scoring (§4a). Never a violation.
  const predictions: PredictionScore[] = [];
  const passTotalFor = (scenarioId: string, matches: (config: string) => boolean) => {
    let pass = 0;
    let total = 0;
    for (const { results } of runs) {
      for (const t of results.trials) {
        if (t.scenarioId !== scenarioId) continue;
        if (!matches(configurationLabel(t.engine, results.environment))) continue;
        total += 1;
        if (t.outcome === "pass") pass += 1;
      }
    }
    return total === 0 ? null : { pass, total };
  };
  for (const scenario of suite.scenarios) {
    for (const policy of ["A", "B", "B2", "C", "D"] as const) {
      const predicted = scenario.predictions[policy];
      const observed = passTotalFor(scenario.id, POLICY_CONFIGS[policy]);
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

function bail(message: string): never {
  console.error(message);
  process.exit(2); // 2 = usage error (distinct from a verification FAIL exit 1)
}

interface CliArgs {
  runDirs: string[];
  suiteFile: string;
}

export function parseVerifyArgs(argv: string[]): CliArgs {
  const runDirs: string[] = [];
  let suiteFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === "--") continue;
    if (arg === "--suite") {
      suiteFile = argv[++i];
      if (!suiteFile) bail("--suite needs a path to a scenario-suite JSON");
    } else if (!arg.startsWith("--")) {
      runDirs.push(arg);
    } else {
      bail(`Unexpected flag "${arg}". Usage: pnpm verify:suite <runDir...> --suite <scenario-suite.json>`);
    }
  }
  if (!suiteFile) bail("Usage: pnpm verify:suite <runDir...> --suite <scenario-suite.json>");
  if (runDirs.length === 0) bail("Usage: pnpm verify:suite <runDir...> --suite <scenario-suite.json>");
  return { runDirs: runDirs.map((d) => path.resolve(d)), suiteFile: path.resolve(suiteFile) };
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

  const report = verifySuite(inputs, suite!);
  console.log(formatReport(report));
  // Exit nonzero ONLY on (a)-(d) violations — never on a prediction miss or a
  // judged policy failure.
  process.exit(report.ok ? 0 : 1);
}

const isEntrypoint =
  !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isEntrypoint) main();
