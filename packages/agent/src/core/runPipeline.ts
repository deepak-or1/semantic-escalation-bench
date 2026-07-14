import {
  assessDataset,
  type EngineName,
  type PageExtraction,
  type PipelineResult,
  type StepResult
} from "@ssda/shared";
import { persistNormalized, persistRaw } from "./artifacts";
import { categorizeError } from "./errors";
import { buildDataset, checkOddsSchema, checkStatsSchema, normalizeOdds, normalizeStats } from "./normalize";
import { AttemptFailure, type AttemptOutcome, type PipelineOptions } from "./types";

export type AttemptFn = (attempt: number) => Promise<AttemptOutcome>;

function stepDuration(steps: StepResult[], name: string): number {
  return steps.find((s) => s.name === name)?.durationMs ?? 0;
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
  let lastFailure: { category: PipelineResult["failureCategory"]; detail: string; steps: StepResult[]; screenshots: string[]; tokens: AttemptOutcome["tokens"] } | undefined;
  let attempts = 0;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    attempts = attempt;
    log.info("attempt:start", { attempt, scenarioId: options.scenarioId });
    try {
      outcome = await attemptFn(attempt);
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
              tokens: error.tokens
            }
          : (() => {
              const cat = categorizeError(error, "unknown");
              return {
                category: cat.category,
                detail: cat.detail,
                steps: [] as StepResult[],
                screenshots: [] as string[],
                tokens: null
              };
            })();
      lastFailure = failure;
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
      tokens: null
    };
    await options.logger.flush();
    return {
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
      tokens: failure.tokens ?? null
    };
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

  return {
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
    tokens: outcome.tokens ?? null,
    // Carry the final attempt's healed step names (hybrid only; empty otherwise).
    ...(outcome.healedSteps && outcome.healedSteps.length > 0
      ? { healedSteps: outcome.healedSteps }
      : {})
  };
}
