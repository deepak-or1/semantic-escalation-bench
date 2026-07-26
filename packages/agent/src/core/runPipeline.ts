import {
  assessDataset,
  type EngineName,
  type PageExtraction,
  type PipelineResult,
  type StepResult,
  type StepTraceEntry,
  type TokensUsage
} from "@ssda/shared";
import { persistNormalized, persistRaw } from "./artifacts";
import { categorizeError } from "./errors";
import { buildDataset, checkOddsSchema, checkStatsSchema, normalizeOdds, normalizeStats } from "./normalize";
import { AttemptFailure, type AttemptOutcome, type PipelineOptions } from "./types";

export type AttemptFn = (attempt: number) => Promise<AttemptOutcome>;

/**
 * The engine→runner courier shape. `deterministicRepairSteps` (PROTOCOL_2A §2)
 * rides on the returned PipelineResult exactly as `healedSteps`/
 * `deterministicFallbacks` do, but its schema home is `TrialRecord` (the runner
 * reads it off here and copies it there); the transient PipelineResult carries it
 * out-of-schema — never serialised, never parsed before the runner reads it.
 */
type PipelineResultOut = PipelineResult & { deterministicRepairSteps?: string[] };

function stepDuration(steps: StepResult[], name: string): number {
  return steps.find((s) => s.name === name)?.durationMs ?? 0;
}

/**
 * Accumulates token usage across EVERY attempt of a pipeline (Wave E 8f) — a
 * retry that healed on attempt 1 and succeeded on attempt 2 spent inference on
 * both, and the reported total must reflect all of it. Semantics: `llmCalls`
 * counts Stagehand inference operations (observe/act-with-LLM/extract); the
 * token counts are provider-reported via `stagehand.metrics`. `estimatedCostUsd`
 * is deliberately never summed here — it stays null in results and is derived at
 * analysis time from a pinned price table (protocol rule).
 */
class TokenAccumulator {
  private any = false;
  private llmCalls = 0;
  private inputTokens = 0;
  private hasInput = false;
  private outputTokens = 0;
  private hasOutput = false;

  add(tokens: TokensUsage | null | undefined): void {
    if (!tokens) return;
    this.any = true;
    this.llmCalls += tokens.llmCalls;
    if (tokens.inputTokens !== undefined) {
      this.inputTokens += tokens.inputTokens;
      this.hasInput = true;
    }
    if (tokens.outputTokens !== undefined) {
      this.outputTokens += tokens.outputTokens;
      this.hasOutput = true;
    }
  }

  total(): TokensUsage | null {
    if (!this.any) return null;
    return {
      llmCalls: this.llmCalls,
      ...(this.hasInput ? { inputTokens: this.inputTokens } : {}),
      ...(this.hasOutput ? { outputTokens: this.outputTokens } : {})
    };
  }
}

/**
 * Engine-agnostic pipeline shell: retries whole attempts, then runs the
 * shared post-processing (schema check → normalize → domain assessment →
 * persistence) so both engines are graded by identical rules.
 */
export async function runPipeline(
  engine: EngineName,
  options: PipelineOptions,
  attemptFn: AttemptFn
): Promise<PipelineResult> {
  const log = options.logger.child({ engine });
  const startedAt = new Date().toISOString();
  const started = Date.now();

  let outcome: AttemptOutcome | undefined;
  let lastFailure:
    | {
        category: PipelineResult["failureCategory"];
        detail: string;
        steps: StepResult[];
        screenshots: string[];
        tokens: AttemptOutcome["tokens"];
        healedSteps?: string[];
        deterministicRepairSteps?: string[];
        deterministicFallbacks?: string[];
        stepTrace?: StepTraceEntry[];
        chromeVersion?: string;
      }
    | undefined;
  let attempts = 0;
  // Sum inference cost over ALL attempts, not just the last/successful one.
  const tokenAcc = new TokenAccumulator();

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    attempts = attempt;
    log.info("attempt:start", { attempt, scenarioId: options.scenarioId });
    try {
      outcome = await attemptFn(attempt);
      tokenAcc.add(outcome.tokens);
      log.info("attempt:success", { attempt });
      break;
    } catch (error) {
      const failure =
        error instanceof AttemptFailure
          ? {
              category: error.category,
              detail: error.message,
              steps: error.steps,
              screenshots: error.screenshots,
              tokens: error.tokens,
              // Trial-scoped heal / deterministic-repair / deterministic-fallback
              // snapshots the engine carried on the failure, so a trial that fires
              // a guard, heals, or deterministically repairs a step and then fails
              // entirely still records it (below).
              healedSteps: error.healedSteps,
              deterministicRepairSteps: error.deterministicRepairSteps,
              deterministicFallbacks: error.deterministicFallbacks,
              // Record-version-2 escalation trace gathered before the attempt died.
              stepTrace: error.stepTrace,
              // …and the browser build it ran against, so a trial that never
              // completed an attempt still records which browser executed it.
              chromeVersion: error.chromeVersion
            }
          : (() => {
              const cat = categorizeError(error, "unknown");
              return {
                category: cat.category,
                detail: cat.detail,
                steps: [] as StepResult[],
                screenshots: [] as string[],
                tokens: null,
                healedSteps: undefined as string[] | undefined,
                deterministicRepairSteps: undefined as string[] | undefined,
                deterministicFallbacks: undefined as string[] | undefined,
                stepTrace: undefined as StepTraceEntry[] | undefined,
                chromeVersion: undefined as string | undefined
              };
            })();
      lastFailure = failure;
      tokenAcc.add(failure.tokens);
      log.warn("attempt:failed", {
        attempt,
        category: failure.category,
        detail: failure.detail.slice(0, 500)
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - started;
  const eventsFile = options.logger.file;

  if (!outcome) {
    const failure = lastFailure ?? {
      category: "internal" as const,
      detail: "no attempts executed",
      steps: [],
      screenshots: [],
      tokens: null,
      chromeVersion: undefined as string | undefined
    };
    await options.logger.flush();
    const failed: PipelineResultOut = {
      engine,
      runId: options.runId,
      ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
      labUrl: options.labUrl,
      startedAt,
      finishedAt,
      durationMs,
      success: false,
      attempts,
      retries: attempts - 1,
      recoveredAfterFailure: false,
      failureCategory: failure.category ?? "internal",
      failureDetail: failure.detail,
      steps: failure.steps,
      pages: {},
      validation: { extractOk: false, domainOk: false, issues: [failure.detail] },
      artifacts: {
        dir: options.runDir,
        screenshots: failure.screenshots,
        eventsFile
      },
      // Total inference across all attempts (estimatedCostUsd stays null).
      tokens: tokenAcc.total(),
      // A wholly-failed trial still discloses any heals / deterministic-repair /
      // deterministic-fallback firings accumulated across all attempts (nonempty only).
      ...(failure.healedSteps && failure.healedSteps.length > 0
        ? { healedSteps: failure.healedSteps }
        : {}),
      ...(failure.deterministicRepairSteps && failure.deterministicRepairSteps.length > 0
        ? { deterministicRepairSteps: failure.deterministicRepairSteps }
        : {}),
      ...(failure.deterministicFallbacks && failure.deterministicFallbacks.length > 0
        ? { deterministicFallbacks: failure.deterministicFallbacks }
        : {}),
      // ...and the escalation trace it gathered (record version 2).
      ...(failure.stepTrace && failure.stepTrace.length > 0
        ? { stepTrace: failure.stepTrace }
        : {}),
      // The build that executed this trial, even though no attempt completed.
      ...(failure.chromeVersion ? { chromeVersion: failure.chromeVersion } : {})
    };
    return failed;
  }

  // ── Shared post-processing ────────────────────────────────────────────
  const issues: string[] = [];
  const pages: { stats?: PageExtraction; odds?: PageExtraction } = {};
  let extractOk = true;

  const wantStats = options.pages.includes("stats");
  const wantOdds = options.pages.includes("odds");

  const statsCheck = wantStats ? checkStatsSchema(outcome.statsRaw) : undefined;
  const oddsCheck = wantOdds ? checkOddsSchema(outcome.oddsRaw) : undefined;

  if (wantStats) {
    await persistRaw(options.runDir, attempts, "stats", outcome.statsRaw);
    pages.stats = {
      page: "stats",
      ok: outcome.statsRaw !== undefined,
      raw: outcome.statsRaw,
      schemaOk: statsCheck?.ok ?? false,
      issues: statsCheck?.issues ?? [],
      durationMs: stepDuration(outcome.steps, "extract-stats")
    };
    if (!statsCheck?.ok) {
      extractOk = false;
      issues.push(...(statsCheck?.issues ?? ["stats: nothing extracted"]));
    }
  }
  if (wantOdds) {
    await persistRaw(options.runDir, attempts, "odds", outcome.oddsRaw);
    pages.odds = {
      page: "odds",
      ok: outcome.oddsRaw !== undefined,
      raw: outcome.oddsRaw,
      schemaOk: oddsCheck?.ok ?? false,
      issues: oddsCheck?.issues ?? [],
      durationMs: stepDuration(outcome.steps, "extract-odds")
    };
    if (!oddsCheck?.ok) {
      extractOk = false;
      issues.push(...(oddsCheck?.issues ?? ["odds: nothing extracted"]));
    }
  }

  const dataset = buildDataset({
    engine,
    source: options.labUrl,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(statsCheck?.parsed ? { stats: normalizeStats(statsCheck.parsed) } : {}),
    ...(oddsCheck?.parsed ? { odds: normalizeOdds(oddsCheck.parsed) } : {})
  });
  await persistNormalized(options.runDir, dataset);

  const assessment = assessDataset(dataset);
  issues.push(...assessment.failures);
  const domainOk = extractOk && assessment.ok;
  const success = extractOk && domainOk;

  log.info("pipeline:assessed", {
    extractOk,
    domainOk,
    failures: assessment.failures.length,
    warnings: assessment.warnings.length
  });
  await options.logger.flush();

  const result: PipelineResultOut = {
    engine,
    runId: options.runId,
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    labUrl: options.labUrl,
    startedAt,
    finishedAt,
    durationMs,
    success,
    attempts,
    retries: attempts - 1,
    recoveredAfterFailure: success && attempts > 1,
    ...(success
      ? {}
      : {
          failureCategory: !extractOk ? ("extraction" as const) : ("validation" as const),
          failureDetail: issues.slice(0, 5).join(" | ") || "validation failed"
        }),
    steps: outcome.steps,
    pages,
    normalized: dataset,
    validation: { extractOk, domainOk, issues },
    artifacts: {
      dir: options.runDir,
      screenshots: outcome.screenshots,
      eventsFile
    },
    // Total inference across all attempts (estimatedCostUsd stays null).
    tokens: tokenAcc.total(),
    // Carry the healed step names accumulated across ALL attempts (hybrid only;
    // empty otherwise) — the outcome's list is trial-scoped, so it already
    // includes heals from earlier failed attempts.
    ...(outcome.healedSteps && outcome.healedSteps.length > 0
      ? { healedSteps: outcome.healedSteps }
      : {}),
    // Carry the B2 deterministic-repair step names accumulated across ALL attempts
    // (hybrid deterministic mode only) — trial-scoped, mirroring healedSteps.
    ...(outcome.deterministicRepairSteps && outcome.deterministicRepairSteps.length > 0
      ? { deterministicRepairSteps: outcome.deterministicRepairSteps }
      : {}),
    // Carry the deterministic-fallback firings accumulated across ALL attempts
    // (stagehand only) — likewise trial-scoped, so earlier attempts' firings are
    // included.
    ...(outcome.deterministicFallbacks && outcome.deterministicFallbacks.length > 0
      ? { deterministicFallbacks: outcome.deterministicFallbacks }
      : {}),
    // Record-version-2 evidence: the per-step escalation trace (engines that
    // record one) and the browser build (engines that can read it for free).
    ...(outcome.stepTrace && outcome.stepTrace.length > 0
      ? { stepTrace: outcome.stepTrace }
      : {}),
    ...(outcome.chromeVersion ? { chromeVersion: outcome.chromeVersion } : {})
  };
  return result;
}
