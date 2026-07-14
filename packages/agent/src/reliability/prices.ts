/**
 * Pinned model price table (Wave F F3). The protocol computes dollar costs at
 * analysis time from THIS frozen table — never at run time — so a later price
 * change can never rewrite a committed run's cost. An unknown model yields a
 * null cost (disclosed as "—"), never a guessed number.
 */

/** Pinned 2026-07-14 from Anthropic's published API pricing. */
export const PRICES_PINNED_AT = "2026-07-14";

/**
 * Pinned 2026-07-14 from Anthropic's published API pricing. The campaign's
 * frozen model is anthropic/claude-haiku-4-5; other models are deliberately
 * absent — an unknown model yields cost null, never a guess.
 */
export const PINNED_PRICES: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }> = {
  "anthropic/claude-haiku-4-5": { inputUsdPerMTok: 1.0, outputUsdPerMTok: 5.0 }
};

/**
 * Dollar cost of one trial's inference. Rules (applied in order):
 *  - model absent/unknown → null;
 *  - tokens null/undefined → null (unknown usage);
 *  - `tokens.llmCalls === 0` → 0 (zero inference is a real, priced $0 —
 *    deterministic trials must not read as "unpriced");
 *  - `tokens.llmCalls > 0` → BOTH `inputTokens` and `outputTokens` must be
 *    present numbers, else null (never a half-cost);
 *  - otherwise (input × inRate + output × outRate) / 1e6.
 */
export function trialCostUsd(
  tokens: { llmCalls: number; inputTokens?: number; outputTokens?: number } | null | undefined,
  model: string | undefined | null
): number | null {
  if (!model) return null;
  const price = PINNED_PRICES[model];
  if (!price) return null;
  if (!tokens) return null;
  if (tokens.llmCalls === 0) return 0;
  const hasInput = typeof tokens.inputTokens === "number";
  const hasOutput = typeof tokens.outputTokens === "number";
  if (!hasInput || !hasOutput) return null;
  return (tokens.inputTokens! * price.inputUsdPerMTok + tokens.outputTokens! * price.outputUsdPerMTok) / 1e6;
}
