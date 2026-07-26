import type { TrialResult } from "@ssda/shared";

/**
 * Per-engine reliability roll-up for the dashboard's summary panel. Pure and
 * dependency-free: it derives everything from the parsed trial list rather than
 * from the run's own engine summaries, so the panel reports exactly the trials
 * the dashboard actually loaded.
 */

/** One row of the summary table: a single engine, aggregated over its trials. */
export interface EngineSummaryRow {
  engine: string;
  trials: number;
  passes: number;
  semanticInterventions: number;
  llmCalls: number;
  retries: number;
}

/**
 * Whether the engine had to intervene semantically to get through this trial —
 * an LLM step-heal, a deterministic fallback, or a deterministic re-location.
 * Each of those is the engine leaving its scripted path to work out what the
 * page now looks like, so all three count the same way here.
 */
function hasSemanticIntervention(trial: TrialResult): boolean {
  return (
    (trial.healedSteps?.length ?? 0) > 0 ||
    (trial.deterministicFallbacks?.length ?? 0) > 0 ||
    (trial.deterministicRepairSteps?.length ?? 0) > 0
  );
}

/**
 * Summarize a flat trial list into one row per engine that produced trials, in
 * first-appearance order (a Map keeps insertion order, so the panel's row order
 * follows the run's own ordering rather than an arbitrary sort).
 */
export function summarizeEngines(trials: TrialResult[]): EngineSummaryRow[] {
  const rows = new Map<string, EngineSummaryRow>();
  for (const trial of trials) {
    let row = rows.get(trial.engine);
    if (!row) {
      row = {
        engine: trial.engine,
        trials: 0,
        passes: 0,
        semanticInterventions: 0,
        llmCalls: 0,
        retries: 0
      };
      rows.set(trial.engine, row);
    }
    row.trials += 1;
    if (trial.outcome === "pass") row.passes += 1;
    if (hasSemanticIntervention(trial)) row.semanticInterventions += 1;
    // `tokens` is absent on engines that never call a model, and null when a
    // trial recorded no usage at all; both mean zero calls.
    row.llmCalls += trial.tokens?.llmCalls ?? 0;
    row.retries += trial.retries;
  }
  return [...rows.values()];
}
