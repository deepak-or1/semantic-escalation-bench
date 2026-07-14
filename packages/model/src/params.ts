/**
 * Tunable knobs for the Poisson / expected-value engine. Kept deliberately
 * small and transparent — every number here is defensible from the generator's
 * own documented rates.
 */
export interface ModelParams {
  /** Per team per game — used only as a fallback; the observed average is preferred. */
  leagueAvgGoals: number;
  /** Multiplier on the home side's lambda. */
  homeAdvantage: number;
  /** Multiplier on the away side's lambda. */
  awayFactor: number;
  /** Score-matrix truncation (both sides 0..maxGoals). */
  maxGoals: number;
  /** 0..1 recent-form influence. */
  formWeight: number;
}

export const DEFAULT_MODEL_PARAMS: ModelParams = {
  leagueAvgGoals: 1.32,
  homeAdvantage: 1.14,
  awayFactor: 0.9,
  maxGoals: 10,
  formWeight: 0.25
};

export function resolveParams(params?: Partial<ModelParams>): ModelParams {
  return { ...DEFAULT_MODEL_PARAMS, ...params };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
