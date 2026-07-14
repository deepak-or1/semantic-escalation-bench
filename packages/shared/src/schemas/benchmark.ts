import { z } from "zod";
import { ChaosFlagSchema } from "../chaos";
import {
  EngineNameSchema,
  FailureCategorySchema,
  TokensUsageSchema
} from "./run";

export const SessionModeSchema = z.enum(["fresh", "reuse", "expired"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

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
  group: ScenarioGroupSchema.default("core")
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
  healedSteps: z.array(z.string()).optional()
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
  healedTrials: z.number().int().nonnegative().optional()
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
  environment: z.object({
    node: z.string(),
    stagehandVersion: z.string().optional(),
    stagehandModel: z.string().optional(),
    /** Provider whose key was present ("anthropic" | "openai"), or null. */
    modelProvider: z.string().nullable(),
    browserbase: z.boolean()
  })
});
export type BenchmarkResults = z.infer<typeof BenchmarkResultsSchema>;
