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
  deterministicRepairs: number;
  llmCalls: number;
  retries: number;
}

/**
 * `healedSteps` is the only trial field that records a semantic (LLM observe)
 * repair — see its TrialResultSchema doc comment. `deterministicFallbacks`
 * (stagehand's hand-written guards) and `deterministicRepairSteps` (B2's
 * scripted ladder) are scripted recoveries that involve no model call, so they
 * are counted separately as deterministic repairs.
 */
function hasSemanticIntervention(trial: TrialResult): boolean {
  return (trial.healedSteps?.length ?? 0) > 0;
}

function hasDeterministicRepair(trial: TrialResult): boolean {
  return (
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
        deterministicRepairs: 0,
        llmCalls: 0,
        retries: 0
      };
      rows.set(trial.engine, row);
    }
    row.trials += 1;
    if (trial.outcome === "pass") row.passes += 1;
    if (hasSemanticIntervention(trial)) row.semanticInterventions += 1;
    if (hasDeterministicRepair(trial)) row.deterministicRepairs += 1;
    // `tokens` is absent on engines that never call a model, and null when a
    // trial recorded no usage at all; both mean zero calls.
    row.llmCalls += trial.tokens?.llmCalls ?? 0;
    row.retries += trial.retries;
  }
  return [...rows.values()];
}
