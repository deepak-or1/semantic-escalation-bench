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

/** Whether a content-readiness poll saw its page's content in time. */
export const ReadinessOutcomeSchema = z.enum(["ready", "not-ready"]);
export type ReadinessOutcome = z.infer<typeof ReadinessOutcomeSchema>;

/**
 * One recorded observation of WHY escalation did or did not fire at a step
 * (record version 2, docs/RECORD_FORMAT.md). Best-effort and HONEST: an engine
 * fills only the fields it genuinely knows and OMITS the rest — never a guess.
 *
 * A trigger that ACTIVATED, a repair that was ATTEMPTED, a repair that
 * SUCCEEDED, and a step that then COMPLETED are four different facts, and each
 * gets its own field — collapsing them (as the earlier `repairEligible` /
 * `repairFired` pair did) makes a trace that cannot distinguish "no repair was
 * possible" from "a repair ran and failed". The hybrid engine records the full
 * trigger evaluation; the stagehand engine records its deterministic-guard
 * firings and its model-call sites; the baseline engine records nothing (it has
 * no escalation machinery).
 *
 * The trace is RECONCILED against the record's other evidence by the verifier
 * (Σ `modelCallsAtStep` vs `tokens.llmCalls`, successful llm repairs vs
 * `healedSteps`, successful deterministic repairs vs `deterministicRepairSteps`
 * / `deterministicFallbacks`), so it is a checkable claim, not free text.
 *
 * Recording is pure bookkeeping: it never adds a wait, reorders a step, or
 * touches the page.
 */
export const StepTraceEntrySchema = z.object({
  /** The pipeline step this observation belongs to (matches StepResult.name). */
  step: z.string().min(1),
  /** Did the deterministic cached selector act successfully? (hybrid only) */
  cachedSelectorMatched: z.boolean().optional(),
  /** Outcome of a content-readiness poll, where one runs. */
  readinessOutcome: ReadinessOutcomeSchema.optional(),
  /**
   * Did the escalation TRIGGER activate at this observation — the cached
   * selector missed, or the extraction structure was unreadable? Independent of
   * whether anything could then be done about it.
   */
  escalationTriggered: z.boolean().optional(),
  /**
   * Did a repair actually RUN? False when the trigger fired but no repair was
   * available (repair-mode `off`, or the llm path with no key).
   */
  repairAttempted: z.boolean().optional(),
  /** Did the attempted repair SUCCEED (the replayed action/read worked)? */
  repairSucceeded: z.boolean().optional(),
  /** Which repair tier ran: the LLM path, the deterministic ladder, or none. */
  repairKind: z.enum(["llm", "deterministic"]).nullable().optional(),
  /**
   * Model-driven calls spent at this observation. Engines that count their own
   * calls exactly (hybrid: observe/extract; stagehand: every act/observe/extract
   * wrapper) record it — including `0` — so the verifier can reconcile the sum
   * against `tokens.llmCalls`.
   */
  modelCallsAtStep: z.number().int().nonnegative().optional(),
  /**
   * Did the enclosing STEP go on to complete after a successful repair here?
   * Recorded only where a repair succeeded — otherwise there is nothing to say.
   */
  downstreamRecovered: z.boolean().optional(),
  /** Free-text detail an engine can honestly attach (e.g. an LLM call site). */
  note: z.string().optional()
});
export type StepTraceEntry = z.infer<typeof StepTraceEntrySchema>;

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
  deterministicFallbacks: z.array(z.string()).optional(),
  /**
   * Per-step escalation trace (record version 2). Present and non-empty only for
   * engines that record one (hybrid, stagehand); the baseline never does.
   */
  stepTrace: z.array(StepTraceEntrySchema).optional(),
  /**
   * The browser build that executed this pipeline. The baseline engine reports
   * Playwright's `browser.version()`; the Stagehand-backed engines read the CDP
   * `/json/version` endpoint once at engine init (metadata only, never on a page
   * path). Unset when no source could supply one. NOTE the two sources report
   * different FORMS — Playwright returns a bare build number, CDP returns the
   * `Browser` string (e.g. `HeadlessChrome/140.0.7339.16`) — and neither is
   * rewritten to match the other, so a run mixing engines is honestly not
   * unanimous.
   */
  chromeVersion: z.string().optional()
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
