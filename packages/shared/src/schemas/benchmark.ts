import { z } from "zod";
import { ChaosFlagSchema } from "../chaos";
import { ChaosParamsSchema } from "../chaosParams";
import {
  EngineNameSchema,
  FailureCategorySchema,
  TokensUsageSchema
} from "./run";

export const SessionModeSchema = z.enum(["fresh", "reuse", "expired"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

/**
 * The hybrid engine's repair dispatch (PROTOCOL_2A §1). `off` freezes the tier
 * (the frozen alias of `--no-repair`, policy B); `deterministic` runs the B2
 * deterministic re-location ladder with NO model call in the code path;
 * `llm` (default) runs the one key-gated LLM repair per broken step (policy C).
 */
export const RepairModeSchema = z.enum(["off", "deterministic", "llm"]);
export type RepairMode = z.infer<typeof RepairModeSchema>;

/**
 * What "correct behaviour" means for a scenario. `validation-failure` means
 * the pipeline should complete with a clean, categorised validation failure
 * (extracting garbage silently counts as a FAIL).
 */
export const ExpectedOutcomeSchema = z.enum([
  "success",
  "validation-failure",
  "success-with-warnings"
]);
export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;

/**
 * Which arc a scenario belongs to. `core` = a single isolated failure mode
 * (the original catalog). `compound` = several obstacles co-occurring in one
 * run. `survival` = the same site frozen at accumulating versions of drift,
 * graded against engines written before that drift existed.
 */
export const ScenarioGroupSchema = z.enum(["core", "compound", "survival"]);
export type ScenarioGroup = z.infer<typeof ScenarioGroupSchema>;

/**
 * Why this run exists. Recorded so evidence separation is machine-enforced:
 * smoke runs can never aggregate with campaign evidence, and persistence runs can
 * never blend with the warm economics sweep.
 */
export const RunPurposeSchema = z.enum(["smoke", "cold", "persistence", "warm"]);
export type RunPurpose = z.infer<typeof RunPurposeSchema>;

/**
 * Behaviour classification of a trial, ORTHOGONAL to the judged pass/fail.
 * Derived from what the pipeline actually did (not from whether it met the
 * scenario's expectation):
 *  - `pass`: succeeded, perfect accuracy, first attempt, no repairs.
 *  - `recovered`: succeeded with perfect accuracy, but only after a retry or an
 *    LLM repair.
 *  - `safe-failure`: failed, but the engine itself caught the data problem
 *    (validation/extraction) — e.g. a schema-violation refusal. Note this is a
 *    CLASS, not a verdict: a clean validation-failure is judged PASS yet still
 *    classed `safe-failure`. The two dimensions are deliberately orthogonal.
 *  - `silent-corruption`: claimed success on data that is wrong or unverifiable.
 *    THE headline safety metric.
 *  - `hard-failure`: failed with visible breakage (navigation/auth/not_found/…).
 */
export const OutcomeClassSchema = z.enum([
  "pass",
  "recovered",
  "safe-failure",
  "silent-corruption",
  "hard-failure"
]);
export type OutcomeClass = z.infer<typeof OutcomeClassSchema>;

export const ScenarioSpecSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  chaos: z.array(ChaosFlagSchema),
  seed: z.number().int(),
  session: SessionModeSchema,
  expected: ExpectedOutcomeSchema,
  group: ScenarioGroupSchema.default("core"),
  /**
   * Phase-2A perturbation parameters (PROTOCOL_2A §3), the parameterized parallel
   * to the binary `chaos` flags. Optional and subject to the §3 flag-XOR-param
   * precedence rule (see chaosParams.validateChaosParamsCompat). Absent for every
   * Phase-1 scenario.
   */
  params: ChaosParamsSchema.optional()
});
export type ScenarioSpec = z.infer<typeof ScenarioSpecSchema>;
export type ScenarioSpecInput = z.input<typeof ScenarioSpecSchema>;

export const AccuracyReportSchema = z.object({
  expectedRows: z.number().int().nonnegative(),
  matchedRows: z.number().int().nonnegative(),
  fieldChecks: z.number().int().nonnegative(),
  fieldMatches: z.number().int().nonnegative(),
  rowCoverage: z.number().min(0).max(1),
  fieldAccuracy: z.number().min(0).max(1),
  /**
   * Entity-completeness guards (Wave E 8e). `duplicateRows` counts extracted
   * rows whose key repeats (the same team/fixture reported twice);
   * `unexpectedRows` counts extracted rows whose key is absent from ground
   * truth (a ghost entity). Both are 0 for a faithful extraction; a
   * success-branch judge PASS requires both to be 0 on every page.
   */
  duplicateRows: z.number().int().nonnegative(),
  unexpectedRows: z.number().int().nonnegative(),
  /** rowCoverage × fieldAccuracy */
  score: z.number().min(0).max(1)
});
export type AccuracyReport = z.infer<typeof AccuracyReportSchema>;

export const TrialResultSchema = z.object({
  scenarioId: z.string().min(1),
  engine: EngineNameSchema,
  trial: z.number().int().positive(),
  runId: z.string().min(1),
  /** Pass/fail judged against the scenario's `expected` outcome. */
  outcome: z.enum(["pass", "fail"]),
  outcomeReason: z.string(),
  /**
   * Behaviour class of the trial (see OutcomeClassSchema), computed from the
   * pipeline's behaviour and INDEPENDENT of the judged `outcome` above.
   */
  outcomeClass: OutcomeClassSchema,
  pipelineSuccess: z.boolean(),
  extractionSuccess: z.boolean(),
  validationSuccess: z.boolean(),
  accuracy: z
    .object({
      stats: AccuracyReportSchema.optional(),
      odds: AccuracyReportSchema.optional(),
      overall: z.number().min(0).max(1).optional()
    })
    .nullable(),
  durationMs: z.number().nonnegative(),
  retries: z.number().int().nonnegative(),
  recoveredAfterFailure: z.boolean(),
  failureCategory: FailureCategorySchema.optional(),
  failureDetail: z.string().optional(),
  artifactsDir: z.string(),
  tokens: TokensUsageSchema.nullable().optional(),
  /** Step names the engine repaired via LLM observe this trial (hybrid only). */
  healedSteps: z.array(z.string()).optional(),
  /**
   * Step names the B2 deterministic ladder re-located/re-read this trial
   * (PROTOCOL_2A §2; hybrid `--repair-mode deterministic` only). DISTINCT from
   * `healedSteps` (semantic/LLM repair, which B2 never writes) and from
   * `deterministicFallbacks` (stagehand's guards). Present and non-empty only
   * when a deterministic repair actually fired.
   */
  deterministicRepairSteps: z.array(z.string()).optional(),
  /**
   * Steps where a hand-written deterministic guard fired after the semantic act
   * failed to clear a session blocker (stagehand engine only). Disclosed so
   * full-semantic results never silently lean on hand-written code.
   */
  deterministicFallbacks: z.array(z.string()).optional()
});
export type TrialResult = z.infer<typeof TrialResultSchema>;

export const EngineSummarySchema = z.object({
  engine: EngineNameSchema,
  trials: z.number().int().nonnegative(),
  /** Set when the engine could not run at all (e.g. no model key). */
  skippedReason: z.string().optional(),
  taskSuccessRate: z.number().min(0).max(1).nullable(),
  extractionSuccessRate: z.number().min(0).max(1).nullable(),
  validationSuccessRate: z.number().min(0).max(1).nullable(),
  meanAccuracy: z.number().min(0).max(1).nullable(),
  meanDurationMs: z.number().nonnegative().nullable(),
  totalRetries: z.number().int().nonnegative(),
  recovery: z.object({
    firstAttemptFailures: z.number().int().nonnegative(),
    recovered: z.number().int().nonnegative(),
    recoveryRate: z.number().min(0).max(1).nullable()
  }),
  /**
   * Trials that reached a perfect success only after a whole-attempt RETRY
   * (from recoveredAfterFailure) — reported separately from the heal-based
   * `recovered` outcome class (Wave E 8d): a retry-only success is class
   * `pass`, whereas class `recovered` now requires a semantic repair
   * (healedSteps nonempty). Equals `recovery.recovered` numerically; surfaced
   * under a distinct name so the two notions of "recovery" never blur.
   */
  retryRecoveries: z.number().int().nonnegative(),
  failuresByCategory: z.record(z.number().int().nonnegative()),
  /** Count of trials per behaviour class (see OutcomeClassSchema keys). */
  outcomeClasses: z.record(z.number().int().nonnegative()),
  /**
   * Share of trials that claimed success on wrong/unverifiable data
   * (silent-corruption count / trials). null when the engine ran no trials.
   */
  silentCorruptionRate: z.number().min(0).max(1).nullable(),
  tokens: TokensUsageSchema.nullable().optional(),
  /**
   * Number of trials in which at least one step was LLM-repaired (hybrid only).
   * Omitted when no trial healed anything.
   */
  healedTrials: z.number().int().nonnegative().optional(),
  /**
   * Number of trials in which the B2 deterministic ladder repaired ≥1 step
   * (hybrid `--repair-mode deterministic` only). Omitted when none fired.
   */
  deterministicRepairTrials: z.number().int().nonnegative().optional()
});
export type EngineSummary = z.infer<typeof EngineSummarySchema>;

export const ScenarioComparisonSchema = z.object({
  scenarioId: z.string().min(1),
  /** One verdict per requested engine; engines that never ran are "skipped". */
  results: z.record(EngineNameSchema, z.enum(["pass", "fail", "skipped"])),
  note: z.string().optional()
});
export type ScenarioComparison = z.infer<typeof ScenarioComparisonSchema>;

export const BenchmarkResultsSchema = z.object({
  benchId: z.string().min(1),
  createdAt: z.string(),
  labUrl: z.string().min(1),
  trialsPerScenario: z.number().int().positive(),
  scenarios: z.array(ScenarioSpecSchema),
  trials: z.array(TrialResultSchema),
  engines: z.array(EngineSummarySchema),
  comparison: z.array(ScenarioComparisonSchema),
  /**
   * Present only when a `beforeTrial` hook halted the run early (PROTOCOL_2A §7:
   * the pre-trial budget stop). An incomplete campaign is PRESERVED evidence — the
   * runner still writes every artifact — so this records why it stopped and how
   * far it got. `completedTrials` is how many trials actually ran; `plannedTrials`
   * is how many the full scenario × engine × trial grid would have produced.
   * Absent on any run that ran to completion (keeps every prior results.json
   * parsing).
   */
  stopped: z
    .object({
      reason: z.string(),
      completedTrials: z.number().int().nonnegative(),
      plannedTrials: z.number().int().nonnegative()
    })
    .optional(),
  environment: z.object({
    node: z.string(),
    stagehandVersion: z.string().optional(),
    stagehandModel: z.string().optional(),
    /** Provider whose key was present ("anthropic" | "openai"), or null. */
    modelProvider: z.string().nullable(),
    browserbase: z.boolean(),
    // ── Reproducibility provenance (Wave E 8j) ──────────────────────────────
    /** `git rev-parse HEAD` at run time, or null when git is unavailable. */
    gitCommit: z.string().nullable(),
    /** True when `git status --porcelain` was non-empty; null when unknown. */
    gitDirty: z.boolean().nullable(),
    /** Whether the hybrid repair path was frozen for this run (--no-repair). */
    disableRepair: z.boolean(),
    /**
     * The hybrid engine's resolved repair dispatch for this run (PROTOCOL_2A §1).
     * Optional for backward compatibility with committed Phase-1 results.json
     * files, which predate the flag; absent there. `--no-repair` records "off".
     */
    repairMode: RepairModeSchema.optional(),
    /** Which warm-cache seeding mode was active. */
    seedCacheMode: z.enum(["none", "file", "manifest"]),
    /**
     * content hash: sha256 of the seed-cache file for --seed-cache; for
     * --seed-cache-manifest, sha256 over the manifest hash plus every referenced
     * cache file's verified content sha256. null when seedCacheMode is "none".
     */
    seedCacheHash: z.string().nullable(),
    /**
     * Why this run exists. Recorded so evidence separation is machine-enforced:
     * smoke runs can never aggregate with campaign evidence, and persistence runs
     * can never blend with the warm economics sweep. The `.default("cold")` keeps
     * committed pre-v3 results parseable.
     */
    runPurpose: RunPurposeSchema.default("cold"),
    /**
     * sha256 over the canonical sorted registry of ALL fixed instruction strings
     * (packages/agent/src/instructions.ts): stagehand extraction + act/observe
     * instructions and the hybrid's repair instructions. Pins the complete
     * prompt surface for the protocol.
     */
    promptsHash: z.string(),
    /** sha256 of pnpm-lock.yaml — pins the exact dependency graph. */
    lockfileHash: z.string(),
    /**
     * Protocol identifier (PROTOCOL_2A §5 item 6; e.g. "phase2a-v1"). Optional for
     * backward compatibility with Phase-1 files, which predate it. Populated by a
     * later stage-1 deliverable; the aggregator refuses to mix protocolIds.
     */
    protocolId: z.string().optional(),
    /**
     * sha256 of the scenario-suite file bytes (or the built-in catalog's canonical
     * serialization) for this run (PROTOCOL_2A §5 item 4). Optional for backward
     * compatibility with Phase-1 files; populated by a later stage-1 deliverable.
     */
    suiteHash: z.string().optional()
  })
});
export type BenchmarkResults = z.infer<typeof BenchmarkResultsSchema>;
