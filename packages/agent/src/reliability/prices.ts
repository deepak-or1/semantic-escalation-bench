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
 * Dollar cost of one trial's inference, or null when it cannot be computed:
 * null when the model is unknown/absent, or when tokens is null/undefined or
 * carries neither an input nor an output count. Otherwise
 * (input × inRate + output × outRate) / 1e6, treating a missing side as 0.
 */
export function trialCostUsd(
  tokens: { inputTokens?: number; outputTokens?: number } | null | undefined,
  model: string | undefined | null
): number | null {
  if (!model) return null;
  const price = PINNED_PRICES[model];
  if (!price) return null;
  if (!tokens) return null;
  const hasInput = typeof tokens.inputTokens === "number";
  const hasOutput = typeof tokens.outputTokens === "number";
  if (!hasInput && !hasOutput) return null;
  const input = hasInput ? tokens.inputTokens! : 0;
  const output = hasOutput ? tokens.outputTokens! : 0;
  return (input * price.inputUsdPerMTok + output * price.outputUsdPerMTok) / 1e6;
}
