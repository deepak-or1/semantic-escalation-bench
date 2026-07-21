import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BenchmarkResultsSchema,
  LabClient,
  computeBuiltinCatalogHash,
  createRunLogger,
  labCredentials,
  mirrorToLatest,
  readJsonOr,
  writeJson,
  type AccuracyReport,
  type BenchmarkResults,
  type EngineName,
  type PipelineResult,
  type RepairMode,
  type RunPurpose,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import {
  DEFAULT_PIPELINE_TIMEOUTS,
  loadAgentEnvConfig,
  overallAccuracy,
  scoreOdds,
  scoreStats,
  type Engine
} from "../core";
import { baselineEngine } from "../baseline";
import { stagehandEngine } from "../stagehand";
// The single-source registry of every fixed instruction string sent to a model
// (Wave F F1). `promptsHash` is computed over this so it covers the complete
// prompt surface and can never hash a stale hand-maintained copy.
import { FROZEN_INSTRUCTIONS } from "../instructions";
import { hybridEngine } from "../hybrid";
import { buildComparison, classifyOutcome, summarizeEngine } from "./metrics";
import { renderResultsMarkdown } from "./markdown";
import { prepSessionState } from "./prepSession";

export interface BenchmarkRunConfig {
  labUrl: string;
  /** Requested engines; stagehand is auto-skipped when no model key is set. */
  engines: EngineName[];
  scenarios: ScenarioSpec[];
  /** Trials per scenario per engine (default 1). */
  trialsPerScenario: number;
  headless: boolean;
  /** Caller-created run directory (createRunDir({ kind: "bench" })). */
  benchDir: string;
  benchId: string;
  /**
   * Freeze the hybrid engine's deterministic tier (--no-repair): it never
   * invokes the LLM repair path even with a key present. Baseline/stagehand
   * ignore it.
   */
  disableRepair?: boolean;
  /**
   * The hybrid engine's repair dispatch (PROTOCOL_2A §1). When unset it is derived
   * from `disableRepair` (`off` when true, else `llm`) so legacy callers are
   * unchanged. The runner records the RESOLVED mode as `environment.repairMode`
   * and passes it to the hybrid engine. Baseline/stagehand ignore it.
   */
  repairMode?: RepairMode;
  /**
   * Warm-cache seeding (--seed-cache): a healed-cache.json artifact the hybrid
   * loads as each trial's initial selector cache instead of the bootstrap.
   * Baseline/stagehand ignore it. Mutually exclusive with seedCacheManifest.
   */
  seedCacheFile?: string;
  /**
   * Per-scenario warm-cache seeding (--seed-cache-manifest, Wave E 8h / F4). Each
   * scenario present in the manifest seeds the hybrid from its own healed cache;
   * a scenario absent from the manifest falls back to the bootstrap. Loaded and
   * cryptographically verified by loadAndVerifySeedCacheManifest, which supplies
   * `combinedContentHash` (recorded as `seedCacheHash`). Mutually exclusive with
   * seedCacheFile.
   */
  seedCacheManifest?: SeedCacheManifest;
  /**
   * Why this run exists (default "cold"). Recorded in `environment.runPurpose` so
   * evidence separation is machine-enforced: smoke runs can never aggregate with
   * campaign evidence, and paired persistence runs can never blend with the warm
   * economics sweep. Validated against the seeding mode by validateRunPurpose.
   */
  runPurpose?: RunPurpose;
  /**
   * Held-out scenario-suite provenance (PROTOCOL_2A §5 items 4/6). When the CLI
   * runs a `--scenario-suite`, it passes the suite's `protocolId` and the SHA-256
   * of the suite file's raw bytes. Both UNSET means a built-in-catalog run, which
   * stamps protocolId "phase1-catalog" and the catalog's canonical-serialization
   * hash (see resolveSuiteProvenance). Recorded on EVERY run's environment.
   */
  protocolId?: string;
  suiteHash?: string;
  onProgress?: (line: string) => void;
  /**
   * Optional per-trial hooks (PROTOCOL_2A §7, the campaign driver). `beforeTrial`
   * runs at the TOP of every trial iteration (before `lab.configure`); returning
   * `{ stop: reason }` halts ALL remaining trials and stamps `results.stopped` —
   * the incomplete run is still fully persisted (results.json/.md, failures.jsonl,
   * runs/latest mirror) because a stopped campaign is preserved evidence, never
   * discarded. `afterTrial` runs immediately after each trial is recorded (the
   * driver prices the trial's tokens there and enforces the budget). Both are
   * awaited; a run with no hooks behaves exactly as before.
   */
  hooks?: {
    beforeTrial?: (ctx: {
      scenarioId: string;
      engine: EngineName;
      trial: number;
      completed: number;
      total: number;
    }) => Promise<{ stop: string } | undefined>;
    afterTrial?: (record: TrialResult) => Promise<void>;
  };
}

/**
 * Resolve the protocol/suite provenance a run stamps (PROTOCOL_2A §5 items 4/6).
 * A `--scenario-suite` run supplies both fields (the suite's protocolId + its
 * file-bytes hash); a built-in Phase-1 catalog run supplies neither and stamps
 * protocolId "phase1-catalog" with the catalog's canonical-serialization hash
 * (the same code path suite verification uses). Both are stamped on every run.
 */
export function resolveSuiteProvenance(config: {
  protocolId?: string;
  suiteHash?: string;
}): { protocolId: string; suiteHash: string } {
  return {
    protocolId: config.protocolId ?? "phase1-catalog",
    suiteHash: config.suiteHash ?? computeBuiltinCatalogHash()
  };
}

/**
 * Enforce that a run's purpose matches its seeding mode so evidence separation is
 * machine-checked at run time (before a lab is spawned): "persistence" and "warm"
 * are seeded-cache campaigns and REQUIRE a seed (file or manifest); "cold" and
 * "smoke" are unseeded and REQUIRE no seed. A mismatch throws, naming BOTH the
 * purpose and the seedCacheMode.
 */
export function validateRunPurpose(
  purpose: RunPurpose,
  seedCacheMode: "none" | "file" | "manifest"
): void {
  const seeded = seedCacheMode !== "none";
  if ((purpose === "persistence" || purpose === "warm") && !seeded) {
    throw new Error(
      `runPurpose "${purpose}" requires a seeded cache (seedCacheMode "file" or "manifest"), ` +
        `but seedCacheMode is "${seedCacheMode}".`
    );
  }
  if ((purpose === "cold" || purpose === "smoke") && seeded) {
    throw new Error(
      `runPurpose "${purpose}" requires an unseeded run (seedCacheMode "none"), ` +
        `but seedCacheMode is "${seedCacheMode}".`
    );
  }
}

/**
 * A loaded, verified --seed-cache-manifest (Wave F F4): the runner only needs
 * each scenario's `cacheFile`, plus the manifest's `combinedContentHash` (sha256
 * over the manifest text and every referenced cache file's verified content
 * hash) which becomes the run's `seedCacheHash`. See seedManifest.ts for the
 * on-disk v2 manifest format and the verifying loader.
 */
export interface SeedCacheManifest {
  path: string;
  combinedContentHash: string;
  scenarios: Record<string, { cacheFile: string }>;
}

// Unlike stagehand, hybrid is never auto-skipped: it is designed to run keyless
// (a model key only unlocks its repair path).
const ENGINE_IMPLS: Record<EngineName, Engine> = {
  stagehand: stagehandEngine,
  baseline: baselineEngine,
  hybrid: hybridEngine
};

const NO_KEY_REASON =
  "no model provider key — set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env";

const STAGEHAND_PKG_JSON =
  "packages/agent/node_modules/@browserbasehq/stagehand/package.json";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `git rev-parse HEAD`, or null when git/HEAD is unavailable (read-only). */
function readGitCommit(): string | null {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  const commit = r.stdout.trim();
  return commit.length > 0 ? commit : null;
}

/** true/false from `git status --porcelain`, or null when git is unavailable. */
function readGitDirty(): boolean | null {
  const r = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (r.status !== 0 || r.stdout == null) return null;
  return r.stdout.trim().length > 0;
}

interface Provenance {
  gitCommit: string | null;
  gitDirty: boolean | null;
  disableRepair: boolean;
  repairMode: RepairMode;
  seedCacheMode: "none" | "file" | "manifest";
  seedCacheHash: string | null;
  promptsHash: string;
  lockfileHash: string;
}

/**
 * Resolve the hybrid repair dispatch for a run (PROTOCOL_2A §1). An explicit
 * `repairMode` wins; otherwise `disableRepair` maps to "off" and its absence to
 * "llm", so legacy callers keep their exact behaviour.
 */
function resolveRepairMode(config: BenchmarkRunConfig): RepairMode {
  return config.repairMode ?? (config.disableRepair === true ? "off" : "llm");
}

/** Gather the reproducibility provenance recorded in results.environment (8j). */
async function collectProvenance(
  config: BenchmarkRunConfig,
  repairMode: RepairMode
): Promise<Provenance> {
  // Canonical sorted registry of ALL fixed instruction strings (Wave F F1).
  const promptsHash = sha256(
    JSON.stringify(
      Object.entries(FROZEN_INSTRUCTIONS).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    )
  );
  let lockfileHash: string;
  try {
    lockfileHash = sha256(
      await readFile(path.resolve(process.cwd(), "pnpm-lock.yaml"), "utf8")
    );
  } catch {
    lockfileHash = sha256(""); // lockfile unreadable — deterministic sentinel
  }

  const seedCacheMode: Provenance["seedCacheMode"] = config.seedCacheManifest
    ? "manifest"
    : config.seedCacheFile
      ? "file"
      : "none";
  let seedCacheHash: string | null = null;
  if (config.seedCacheManifest) {
    // Manifest mode (Wave F F4): the content hash covers the manifest text AND
    // every referenced cache file's verified sha256, so a swapped cache changes
    // the recorded provenance. loadAndVerifySeedCacheManifest computed it.
    seedCacheHash = config.seedCacheManifest.combinedContentHash;
  } else if (config.seedCacheFile) {
    // File mode: hash the single seed-cache file's contents (unchanged).
    try {
      seedCacheHash = sha256(await readFile(config.seedCacheFile, "utf8"));
    } catch {
      seedCacheHash = null;
    }
  }

  return {
    gitCommit: readGitCommit(),
    gitDirty: readGitDirty(),
    // "off" is the frozen alias of --no-repair: record disableRepair from the
    // resolved mode so the aggregator's B-structural label is unchanged.
    disableRepair: repairMode === "off",
    repairMode,
    seedCacheMode,
    seedCacheHash,
    promptsHash,
    lockfileHash
  };
}

export async function runBenchmark(
  config: BenchmarkRunConfig
): Promise<BenchmarkResults> {
  // Evidence separation is machine-enforced before anything runs: reject a run
  // whose purpose contradicts its seeding mode (fail fast).
  const runPurpose: RunPurpose = config.runPurpose ?? "cold";
  const seedCacheMode: "none" | "file" | "manifest" = config.seedCacheManifest
    ? "manifest"
    : config.seedCacheFile
      ? "file"
      : "none";
  validateRunPurpose(runPurpose, seedCacheMode);

  // Resolve the hybrid repair dispatch once: recorded as environment.repairMode
  // and passed to the hybrid engine ("off" also sets disableRepair for the
  // aggregator's B-structural label).
  const repairMode = resolveRepairMode(config);
  const disableRepairResolved = repairMode === "off";

  const lab = new LabClient(config.labUrl);
  const envConfig = loadAgentEnvConfig();

  // Stagehand needs an LLM key; without one it is reported as skipped, never
  // run, and never given fabricated trial data.
  const skipStagehand =
    config.engines.includes("stagehand") && envConfig.modelProvider === null;
  const skippedEngines: EngineName[] = skipStagehand ? ["stagehand"] : [];
  const runnableEngines = config.engines.filter(
    (e) => !(e === "stagehand" && skipStagehand)
  );

  const trials: TrialResult[] = [];
  const total =
    config.scenarios.length * runnableEngines.length * config.trialsPerScenario;
  let k = 0;
  // Set when a beforeTrial hook halts the run early (PROTOCOL_2A §7). Recorded on
  // results.stopped; every artifact is still written (preserved evidence).
  let stopped: BenchmarkResults["stopped"] | undefined;

  scenarioLoop: for (const scenario of config.scenarios) {
    // Per-scenario warm-cache resolution (8h): a manifest seeds each scenario
    // from its own healed cache (absent scenarios fall back to the bootstrap);
    // otherwise the single --seed-cache file (if any) seeds every scenario.
    const scenarioSeedCache = config.seedCacheManifest
      ? config.seedCacheManifest.scenarios[scenario.id]?.cacheFile
      : config.seedCacheFile;
    for (const engine of runnableEngines) {
      const impl = ENGINE_IMPLS[engine];
      for (let trial = 1; trial <= config.trialsPerScenario; trial++) {
        // (0) Pre-trial hook (PROTOCOL_2A §7): checked at the TOP of every trial
        // iteration, before the lab is touched. A `{ stop }` return halts ALL
        // remaining trials; results built so far become PRESERVED incomplete
        // evidence (still fully written below) stamped with results.stopped.
        if (config.hooks?.beforeTrial) {
          const decision = await config.hooks.beforeTrial({
            scenarioId: scenario.id,
            engine,
            trial,
            completed: trials.length,
            total
          });
          if (decision) {
            stopped = {
              reason: decision.stop,
              completedTrials: trials.length,
              plannedTrials: total
            };
            config.onProgress?.(
              `STOP after ${trials.length}/${total} trial(s): ${decision.stop} — ` +
                `preserving the incomplete campaign as evidence`
            );
            break scenarioLoop;
          }
        }
        // (1) Reconfigure the lab per trial — this also resets sessions, which
        // session prep below relies on. Suite scenarios carry §3 perturbation
        // params (decoy/pageSize/vocab/…); pass them so a suite run actually
        // renders its perturbations. Built-in catalog scenarios have no params,
        // so this is a no-op for them.
        await lab.configure({
          seed: scenario.seed,
          chaos: scenario.chaos,
          ...(scenario.params ? { params: scenario.params } : {})
        });
        // (2) Ground truth for accuracy scoring.
        const { truth, overrides } = await lab.groundTruth();

        const runId = `${scenario.id}-${engine}-t${trial}`;
        const runDir = path.join(config.benchDir, "trials", runId);

        // (3) Session prep.
        let stateFile: string | undefined;
        if (scenario.session !== "fresh") {
          stateFile = path.join(runDir, "session.json");
          await prepSessionState(config.labUrl, labCredentials(), stateFile);
          if (scenario.session === "expired") {
            await lab.expireAllSessions();
          }
        }

        // (4) Per-trial artifacts directory + logger.
        const logger = createRunLogger({
          runId,
          file: path.join(runDir, "events.jsonl"),
          engine,
          scenarioId: scenario.id,
          console: false
        });

        k += 1;
        const started = Date.now();
        let record: TrialResult;
        try {
          // (5) Run the engine.
          const result = await impl.run({
            labUrl: config.labUrl,
            pages: ["stats", "odds"],
            credentials: labCredentials(),
            session: {
              mode: scenario.session,
              ...(stateFile ? { stateFile } : {})
            },
            runId,
            runDir,
            logger,
            scenarioId: scenario.id,
            seed: scenario.seed,
            headless: config.headless,
            maxAttempts: 2,
            navTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.navTimeoutMs,
            stepTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.stepTimeoutMs,
            env: "local",
            repairMode,
            ...(disableRepairResolved ? { disableRepair: true } : {}),
            ...(scenarioSeedCache ? { seedCacheFile: scenarioSeedCache } : {})
          });
          record = buildTrialResult(scenario, engine, trial, runId, runDir, result, {
            truth,
            overrides
          });
        } catch (error) {
          // A thrown engine (not a pre-checked setup error) is an internal
          // failure — record it, never fabricate a clean result.
          const message = error instanceof Error ? error.message : String(error);
          record = {
            scenarioId: scenario.id,
            engine,
            trial,
            runId,
            outcome: "fail",
            outcomeReason: `engine threw before producing a result: ${message}`,
            // A thrown engine is visible breakage (category "internal").
            outcomeClass: "hard-failure",
            pipelineSuccess: false,
            extractionSuccess: false,
            validationSuccess: false,
            accuracy: null,
            durationMs: Date.now() - started,
            retries: 0,
            recoveredAfterFailure: false,
            failureCategory: "internal",
            failureDetail: message,
            artifactsDir: path.relative(process.cwd(), runDir),
            tokens: null
          };
        }

        trials.push(record);
        // (7) Post-trial hook (PROTOCOL_2A §7): the driver prices this trial's
        // tokens here and enforces the budget. Awaited before the next iteration
        // so the pre-trial check on the following trial sees the updated spend.
        if (config.hooks?.afterTrial) await config.hooks.afterTrial(record);
        config.onProgress?.(
          `[${k}/${total}] ${scenario.id} ${engine} -> ${
            record.outcome === "pass" ? "PASS" : "FAIL"
          } (${record.outcomeReason})`
        );
      }
    }
  }

  // Engine summaries: one per requested engine (skipped stagehand included).
  const engines = config.engines.map((engine) => {
    if (engine === "stagehand" && skipStagehand) {
      return summarizeEngine("stagehand", [], NO_KEY_REASON);
    }
    return summarizeEngine(
      engine,
      trials.filter((t) => t.engine === engine)
    );
  });

  const comparison = buildComparison(
    config.scenarios,
    trials,
    config.engines,
    skippedEngines
  );

  const stagehandPkg = await readJsonOr<{ version?: string }>(
    path.resolve(process.cwd(), STAGEHAND_PKG_JSON),
    {}
  );
  const provenance = await collectProvenance(config, repairMode);
  // Protocol/suite provenance stamped on EVERY run (PROTOCOL_2A §5 items 4/6):
  // suite runs carry the suite's protocolId + file hash; built-in-catalog runs
  // carry "phase1-catalog" + the catalog's canonical-serialization hash.
  const { protocolId, suiteHash } = resolveSuiteProvenance(config);

  const results = BenchmarkResultsSchema.parse({
    benchId: config.benchId,
    createdAt: new Date().toISOString(),
    labUrl: config.labUrl,
    trialsPerScenario: config.trialsPerScenario,
    scenarios: config.scenarios,
    trials,
    engines,
    comparison,
    // Present only on an early budget stop (PROTOCOL_2A §7). The artifacts below
    // are written regardless — an incomplete campaign is preserved evidence.
    ...(stopped ? { stopped } : {}),
    environment: {
      node: process.version,
      ...(stagehandPkg.version ? { stagehandVersion: stagehandPkg.version } : {}),
      ...(envConfig.stagehandModel
        ? { stagehandModel: envConfig.stagehandModel }
        : {}),
      modelProvider: envConfig.modelProvider ?? null,
      browserbase: envConfig.browserbase.ready,
      runPurpose,
      protocolId,
      suiteHash,
      ...provenance
    }
  });

  // Persist: results.json, results.md, failures.jsonl, then mirror to latest.
  await writeJson(path.join(config.benchDir, "results.json"), results);
  await writeFile(
    path.join(config.benchDir, "results.md"),
    renderResultsMarkdown(results),
    "utf8"
  );

  const failureLines = results.trials
    .filter((t) => t.outcome === "fail")
    .map((t) =>
      JSON.stringify({
        scenarioId: t.scenarioId,
        engine: t.engine,
        trial: t.trial,
        failureCategory: t.failureCategory,
        failureDetail: t.failureDetail,
        outcomeReason: t.outcomeReason,
        artifactsDir: t.artifactsDir
      })
    );
  await writeFile(
    path.join(config.benchDir, "failures.jsonl"),
    failureLines.length > 0 ? failureLines.join("\n") + "\n" : "",
    "utf8"
  );

  await mirrorToLatest(config.benchDir);

  return results;
}

interface GroundTruth {
  truth: Awaited<ReturnType<LabClient["groundTruth"]>>["truth"];
  overrides: Awaited<ReturnType<LabClient["groundTruth"]>>["overrides"];
}

function buildTrialResult(
  scenario: ScenarioSpec,
  engine: EngineName,
  trial: number,
  runId: string,
  runDir: string,
  // The hybrid engine carries B2's deterministicRepairSteps out-of-schema on the
  // transient PipelineResult (its schema home is TrialRecord); read it here.
  result: PipelineResult & { deterministicRepairSteps?: string[] },
  gt: GroundTruth
): TrialResult {
  let accuracy: TrialResult["accuracy"] = null;
  let overall: number | undefined;
  let reports: { stats?: AccuracyReport; odds?: AccuracyReport } | undefined;
  if (result.normalized) {
    const stats = scoreStats(result.normalized.teams, gt.truth, gt.overrides);
    const odds = scoreOdds(result.normalized.markets, gt.truth, gt.overrides);
    overall = overallAccuracy(stats, odds);
    accuracy = { stats, odds, ...(overall !== undefined ? { overall } : {}) };
    reports = { stats, odds };
  }

  const { outcome, reason } = judge(scenario, result, overall, reports);
  // Behaviour class is orthogonal to the judged outcome (e.g. a schema-violation
  // refusal is judged PASS but classed safe-failure).
  const outcomeClass = classifyOutcome({
    pipelineSuccess: result.success,
    overall,
    expected: scenario.expected,
    ...(result.healedSteps ? { healedSteps: result.healedSteps } : {}),
    ...(result.failureCategory ? { failureCategory: result.failureCategory } : {})
  });

  return {
    scenarioId: scenario.id,
    engine,
    trial,
    runId,
    outcome,
    outcomeReason: reason,
    outcomeClass,
    pipelineSuccess: result.success,
    extractionSuccess: result.validation.extractOk,
    validationSuccess: result.validation.domainOk,
    accuracy,
    durationMs: result.durationMs,
    retries: result.retries,
    recoveredAfterFailure: result.recoveredAfterFailure,
    ...(result.failureCategory ? { failureCategory: result.failureCategory } : {}),
    ...(result.failureDetail ? { failureDetail: result.failureDetail } : {}),
    artifactsDir: path.relative(process.cwd(), runDir),
    tokens: result.tokens ?? null,
    ...(result.healedSteps && result.healedSteps.length > 0
      ? { healedSteps: result.healedSteps }
      : {}),
    ...(result.deterministicRepairSteps && result.deterministicRepairSteps.length > 0
      ? { deterministicRepairSteps: result.deterministicRepairSteps }
      : {}),
    ...(result.deterministicFallbacks && result.deterministicFallbacks.length > 0
      ? { deterministicFallbacks: result.deterministicFallbacks }
      : {})
  };
}

/**
 * Judge a pipeline result against the scenario's expected outcome. Every
 * outcomeReason names the specific rule that decided the verdict.
 *
 * For the `success` and `success-with-warnings` branches the accuracy bar is
 * PERFECT extraction: overall must be present and == 1 (within 1e-9). With
 * override-aware scoring and the odds tolerance, 1.0 means every graded cell is
 * correct within tolerance, so a successful pipeline that scores below 1 — or
 * that produced no accuracy sample at all — is a FAIL (it cannot be shown to
 * have extracted the right data). A success-branch pass ADDITIONALLY requires
 * zero duplicate and zero unexpected rows on both pages (Wave E 8e), when the
 * per-page accuracy `reports` are supplied. The `validation-failure` branch is
 * unchanged.
 */
export function judge(
  scenario: ScenarioSpec,
  result: PipelineResult,
  overall: number | undefined,
  reports?: { stats?: AccuracyReport; odds?: AccuracyReport }
): { outcome: "pass" | "fail"; reason: string } {
  const accuracyPresent = overall !== undefined;
  const accuracyPerfect = overall !== undefined && overall >= 1 - 1e-9;
  const accuracyNote =
    overall === undefined ? "no accuracy sample" : `accuracy ${overall.toFixed(2)}`;
  const failedNote = `pipeline failed [${result.failureCategory ?? "unknown"}] ${
    result.failureDetail ?? ""
  }`.trim();
  // Entity-completeness gate (8e): duplicate/ghost rows fail a success branch
  // even at perfect cell accuracy. Skipped when reports are absent (unit tests
  // that only exercise the accuracy bar).
  const completenessViolation = ((): string | null => {
    if (!reports) return null;
    for (const [page, rep] of [
      ["stats", reports.stats],
      ["odds", reports.odds]
    ] as const) {
      if (!rep) continue;
      if (rep.duplicateRows > 0) return `${page} reported ${rep.duplicateRows} duplicate row(s)`;
      if (rep.unexpectedRows > 0) return `${page} reported ${rep.unexpectedRows} unexpected row(s)`;
    }
    return null;
  })();

  switch (scenario.expected) {
    case "success": {
      const loggedIn = result.steps.some((s) => s.name === "login");
      const noLoginOk = scenario.session === "reuse" ? !loggedIn : true;
      if (!result.success) {
        return { outcome: "fail", reason: `expected success but ${failedNote}` };
      }
      if (!noLoginOk) {
        return {
          outcome: "fail",
          reason: "expected success via reused session but a login step ran"
        };
      }
      if (!accuracyPresent) {
        return {
          outcome: "fail",
          reason: "expected success but no accuracy sample — cannot verify extraction"
        };
      }
      if (!accuracyPerfect) {
        return {
          outcome: "fail",
          reason: `expected success but accuracy 1.00 required, got ${overall!.toFixed(2)}`
        };
      }
      if (completenessViolation) {
        return { outcome: "fail", reason: `expected success but ${completenessViolation}` };
      }
      return { outcome: "pass", reason: `success: pipeline succeeded (${accuracyNote})` };
    }
    case "success-with-warnings": {
      const warnings = result.normalized?.warnings.length ?? 0;
      if (!result.success) {
        return { outcome: "fail", reason: `expected success-with-warnings but ${failedNote}` };
      }
      if (warnings === 0) {
        return {
          outcome: "fail",
          reason: "expected success-with-warnings but no warnings were emitted"
        };
      }
      if (!accuracyPresent) {
        return {
          outcome: "fail",
          reason:
            "expected success-with-warnings but no accuracy sample — cannot verify extraction"
        };
      }
      if (!accuracyPerfect) {
        return {
          outcome: "fail",
          reason: `expected success-with-warnings but accuracy 1.00 required, got ${overall!.toFixed(2)}`
        };
      }
      if (completenessViolation) {
        return {
          outcome: "fail",
          reason: `expected success-with-warnings but ${completenessViolation}`
        };
      }
      return {
        outcome: "pass",
        reason: `success-with-warnings: succeeded with ${warnings} warning(s) (${accuracyNote})`
      };
    }
    case "validation-failure": {
      if (result.success) {
        return {
          outcome: "fail",
          reason: "expected a validation failure but the pipeline succeeded"
        };
      }
      if (result.failureCategory !== "validation") {
        return {
          outcome: "fail",
          reason: `expected a validation failure but failure category was ${
            result.failureCategory ?? "unknown"
          }`
        };
      }
      return {
        outcome: "pass",
        reason: "validation-failure: clean categorised validation failure as expected"
      };
    }
  }
}
