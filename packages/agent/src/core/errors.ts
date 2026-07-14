import type { FailureCategory } from "@ssda/shared";

/** A step-scoped, categorised error. Engines throw these so failures land in
 * the right benchmark bucket instead of a generic "internal". */
export class PipelineStepError extends Error {
  constructor(
    message: string,
    readonly category: FailureCategory,
    readonly step: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "PipelineStepError";
  }
}

/** Best-effort categorisation for errors that escaped without a category. */
export function categorizeError(
  error: unknown,
  fallbackStep: string
): { category: FailureCategory; step: string; detail: string } {
  if (error instanceof PipelineStepError) {
    return { category: error.category, step: error.step, detail: error.message };
  }
  const detail = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(detail)) {
    return { category: "timeout", step: fallbackStep, detail };
  }
  if (/net::|ECONNREFUSED|ERR_CONNECTION|ENOTFOUND|socket hang up/i.test(detail)) {
    return { category: "navigation", step: fallbackStep, detail };
  }
  return { category: "internal", step: fallbackStep, detail };
}
