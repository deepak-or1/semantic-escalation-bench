import { z } from "zod";
import { NormalizedDatasetSchema } from "./domain";

export const ENGINES = ["stagehand", "baseline", "hybrid"] as const;
export type EngineName = (typeof ENGINES)[number];
export const EngineNameSchema = z.enum(ENGINES);

export const FAILURE_CATEGORIES = [
  "navigation",
  "auth",
  "blocked_ui",
  "not_found",
  "extraction",
  "validation",
  "timeout",
  "internal"
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];
export const FailureCategorySchema = z.enum(FAILURE_CATEGORIES);

export const StepResultSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["passed", "failed", "recovered", "skipped"]),
  attempts: z.number().int().positive(),
  durationMs: z.number().nonnegative(),
  category: FailureCategorySchema.optional(),
  error: z.string().optional()
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const PageExtractionSchema = z.object({
  page: z.enum(["stats", "odds"]),
  ok: z.boolean(),
  /** Raw extractor output before normalization (persisted to raw/*.json). */
  raw: z.unknown().optional(),
  schemaOk: z.boolean(),
  issues: z.array(z.string()),
  durationMs: z.number().nonnegative()
});
export type PageExtraction = z.infer<typeof PageExtractionSchema>;

export const TokensUsageSchema = z.object({
  llmCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional()
});
export type TokensUsage = z.infer<typeof TokensUsageSchema>;

export const PipelineResultSchema = z.object({
  engine: EngineNameSchema,
  runId: z.string().min(1),
  scenarioId: z.string().optional(),
  labUrl: z.string().min(1),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().nonnegative(),
  success: z.boolean(),
  /** Whole-pipeline attempts (1 = no retry needed). */
  attempts: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
  recoveredAfterFailure: z.boolean(),
  failureCategory: FailureCategorySchema.optional(),
  failureDetail: z.string().optional(),
  steps: z.array(StepResultSchema),
  pages: z.object({
    stats: PageExtractionSchema.optional(),
    odds: PageExtractionSchema.optional()
  }),
  normalized: NormalizedDatasetSchema.optional(),
  validation: z.object({
    /** Extraction-layer schemas parsed. */
    extractOk: z.boolean(),
    /** Domain-layer assessment passed (see assessDataset). */
    domainOk: z.boolean(),
    issues: z.array(z.string())
  }),
  artifacts: z.object({
    dir: z.string(),
    screenshots: z.array(z.string()),
    eventsFile: z.string()
  }),
  tokens: TokensUsageSchema.nullable().optional(),
  /**
   * Step names whose cached selector failed and was repaired via an LLM observe
   * call (hybrid engine only). Present and non-empty only when a repair ran.
   */
  healedSteps: z.array(z.string()).optional(),
  /**
   * Step names where a hand-written deterministic guard fired after the semantic
   * act failed to clear a session blocker (stagehand engine only). Present and
   * non-empty only when a fallback actually fired.
   */
  deterministicFallbacks: z.array(z.string()).optional()
});
export type PipelineResult = z.infer<typeof PipelineResultSchema>;

export const RunEventSchema = z.object({
  ts: z.string(),
  runId: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  event: z.string().min(1),
  engine: EngineNameSchema.optional(),
  scenarioId: z.string().optional(),
  step: z.string().optional(),
  data: z.record(z.unknown()).optional()
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunManifestSchema = z.object({
  runId: z.string().min(1),
  kind: z.enum(["agent", "bench", "trial"]),
  createdAt: z.string(),
  engine: EngineNameSchema.optional(),
  scenarioId: z.string().optional(),
  seed: z.number().int().optional(),
  labUrl: z.string().optional(),
  description: z.string().optional()
});
export type RunManifest = z.infer<typeof RunManifestSchema>;
