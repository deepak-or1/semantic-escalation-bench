import type {
  EngineName,
  EngineSummary,
  ExpectedOutcome,
  FailureCategory,
  OutcomeClass,
  ScenarioComparison,
  ScenarioSpec,
  TokensUsage,
  TrialResult
} from "@ssda/shared";

/** Accuracy at/above this counts as "every graded cell correct within tolerance". */
const PERFECT_ACCURACY = 1 - 1e-9;

/**
 * Classify a trial by its BEHAVIOUR, independent of the judged pass/fail (see
 * OutcomeClassSchema). A schema-violation refusal (pipelineSuccess false,
 * failureCategory "validation") is classed `safe-failure` here even though the
 * runner judges it PASS — the two dimensions are deliberately orthogonal.
 *
 * Wave E refinements:
 *  - 8b (oracle-aware): a successful pipeline on a `validation-failure` scenario
 *    is `silent-corruption` regardless of accuracy — the oracle demanded refusal
 *    and the engine accepted output instead.
 *  - 8d (recovered ⇔ semantic repair): `recovered` requires a heal
 *    (healedSteps nonempty). A perfect success that only needed a whole-attempt
 *    RETRY (no heal) is class `pass`; the retry is reported via retryRecoveries.
 */
export function classifyOutcome(input: {
  pipelineSuccess: boolean;
  /** Overall extraction accuracy, or undefined when no sample was scored. */
  overall: number | undefined;
  /** The scenario's expected outcome (its oracle). */
  expected: ExpectedOutcome;
  healedSteps?: string[];
  failureCategory?: FailureCategory;
}): OutcomeClass {
  const perfect = input.overall !== undefined && input.overall >= PERFECT_ACCURACY;
  if (input.pipelineSuccess) {
    // Accepted output where the oracle demanded refusal is silent corruption.
    if (input.expected === "validation-failure") return "silent-corruption";
    // Success with wrong/unverifiable data is the headline safety failure.
    if (!perfect) return "silent-corruption";
    // A win attributable to a semantic repair is "recovered"; a retry-only or
    // first-try win is "pass".
    const repaired = (input.healedSteps?.length ?? 0) > 0;
    return repaired ? "recovered" : "pass";
  }
  // A reported failure the engine caught in its own data layer is "safe".
  return input.failureCategory === "validation" || input.failureCategory === "extraction"
    ? "safe-failure"
    : "hard-failure";
}

/**
 * Aggregate per-engine reliability metrics from a flat list of trial results.
 * When `trials` is empty (e.g. an engine that was skipped for lack of a model
 * key) every rate is null and `skippedReason` is carried through.
 */
export function summarizeEngine(
  engine: EngineName,
  trials: TrialResult[],
  skippedReason?: string
): EngineSummary {
  if (trials.length === 0) {
    return {
      engine,
      trials: 0,
      ...(skippedReason ? { skippedReason } : {}),
      taskSuccessRate: null,
      extractionSuccessRate: null,
      validationSuccessRate: null,
      meanAccuracy: null,
      meanDurationMs: null,
      totalRetries: 0,
      recovery: { firstAttemptFailures: 0, recovered: 0, recoveryRate: null },
      retryRecoveries: 0,
      failuresByCategory: {},
      outcomeClasses: {},
      silentCorruptionRate: null,
      tokens: null
    };
  }

  const total = trials.length;
  const passes = trials.filter((t) => t.outcome === "pass").length;
  const extractions = trials.filter((t) => t.extractionSuccess).length;
  const validations = trials.filter((t) => t.validationSuccess).length;

  const accuracies = trials
    .map((t) => t.accuracy?.overall)
    .filter((v): v is number => typeof v === "number");
  const meanAccuracy =
    accuracies.length === 0
      ? null
      : accuracies.reduce((a, b) => a + b, 0) / accuracies.length;

  const meanDurationMs =
    trials.reduce((sum, t) => sum + t.durationMs, 0) / total;
  const totalRetries = trials.reduce((sum, t) => sum + t.retries, 0);

  const firstAttemptFailures = trials.filter((t) => t.retries > 0).length;
  const recovered = trials.filter((t) => t.recoveredAfterFailure).length;

  const failuresByCategory: Record<string, number> = {};
  const outcomeClasses: Record<string, number> = {};
  for (const t of trials) {
    if (t.failureCategory) {
      failuresByCategory[t.failureCategory] =
        (failuresByCategory[t.failureCategory] ?? 0) + 1;
    }
    outcomeClasses[t.outcomeClass] = (outcomeClasses[t.outcomeClass] ?? 0) + 1;
  }
  const silentCorruptionRate = (outcomeClasses["silent-corruption"] ?? 0) / total;

  // Trials in which the engine LLM-repaired at least one step (hybrid only).
  // Omitted entirely when nothing healed, so it never clutters other engines.
  const healedTrials = trials.filter(
    (t) => (t.healedSteps?.length ?? 0) > 0
  ).length;

  return {
    engine,
    trials: total,
    ...(skippedReason ? { skippedReason } : {}),
    taskSuccessRate: passes / total,
    extractionSuccessRate: extractions / total,
    validationSuccessRate: validations / total,
    meanAccuracy,
    meanDurationMs,
    totalRetries,
    recovery: {
      firstAttemptFailures,
      recovered,
      recoveryRate:
        firstAttemptFailures === 0 ? null : recovered / firstAttemptFailures
    },
    // Retry-only recoveries (8d): reported separately from the heal-based
    // `recovered` outcome class. Equal to recovery.recovered by construction.
    retryRecoveries: recovered,
    failuresByCategory,
    outcomeClasses,
    silentCorruptionRate,
    tokens: sumTokens(trials),
    ...(healedTrials > 0 ? { healedTrials } : {})
  };
}

/** Sum token usage across trials, or null when no trial reported any. */
function sumTokens(trials: TrialResult[]): TokensUsage | null {
  const withTokens = trials
    .map((t) => t.tokens)
    .filter((tok): tok is TokensUsage => tok != null);
  if (withTokens.length === 0) return null;

  let llmCalls = 0;
  let inputTokens = 0;
  let hasInput = false;
  let outputTokens = 0;
  let hasOutput = false;
  let estimatedCostUsd = 0;
  let hasCost = false;

  for (const tok of withTokens) {
    llmCalls += tok.llmCalls;
    if (tok.inputTokens !== undefined) {
      inputTokens += tok.inputTokens;
      hasInput = true;
    }
    if (tok.outputTokens !== undefined) {
      outputTokens += tok.outputTokens;
      hasOutput = true;
    }
    if (tok.estimatedCostUsd !== undefined) {
      estimatedCostUsd += tok.estimatedCostUsd;
      hasCost = true;
    }
  }

  return {
    llmCalls,
    ...(hasInput ? { inputTokens } : {}),
    ...(hasOutput ? { outputTokens } : {}),
    ...(hasCost ? { estimatedCostUsd } : {})
  };
}

/**
 * Build the per-scenario comparison matrix. One cell per REQUESTED engine: it is
 * "skipped" (the engine never ran), or a majority-vote pass/fail over that
 * engine's trials for the scenario (`passes * 2 > n`). The note carries the
 * first failing trial's reason for each failing engine, prefixed by engine name
 * and joined (in engine order) when more than one fails.
 */
export function buildComparison(
  scenarios: ScenarioSpec[],
  trials: TrialResult[],
  engines: EngineName[],
  skippedEngines: EngineName[]
): ScenarioComparison[] {
  const cellFor = (
    scenarioId: string,
    engine: EngineName
  ): "pass" | "fail" | "skipped" => {
    if (skippedEngines.includes(engine)) return "skipped";
    const own = trials.filter(
      (t) => t.scenarioId === scenarioId && t.engine === engine
    );
    if (own.length === 0) return "skipped";
    const passes = own.filter((t) => t.outcome === "pass").length;
    return passes * 2 > own.length ? "pass" : "fail";
  };

  return scenarios.map((scenario) => {
    const results: ScenarioComparison["results"] = {};
    for (const engine of engines) {
      results[engine] = cellFor(scenario.id, engine);
    }

    const noteParts: string[] = [];
    for (const engine of engines) {
      if (results[engine] !== "fail") continue;
      const firstFail = trials.find(
        (t) =>
          t.scenarioId === scenario.id &&
          t.engine === engine &&
          t.outcome === "fail"
      );
      if (firstFail) noteParts.push(`${engine}: ${firstFail.outcomeReason}`);
    }

    return {
      scenarioId: scenario.id,
      results,
      ...(noteParts.length > 0 ? { note: noteParts.join(" | ") } : {})
    };
  });
}
