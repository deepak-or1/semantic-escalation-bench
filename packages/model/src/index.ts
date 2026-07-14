/**
 * @ssda/model — a small, transparent Poisson / expected-value engine over
 * normalized extraction data. Public surface only; internal helpers live in
 * their own modules and are imported directly by colocated tests.
 */
export type { ModelParams } from "./params";
export { DEFAULT_MODEL_PARAMS } from "./params";

export { poissonPmf, poissonCdf } from "./poisson";

export type { TeamStrength, StrengthDerivation } from "./strengths";
export { deriveStrengths } from "./strengths";

export type { MatchForecast } from "./forecast";
export { forecastMatch } from "./forecast";

export type { MarketSide, ValueSelection } from "./value";

export type { Watchlist } from "./watchlist";
export { datasetConfidence, buildWatchlist } from "./watchlist";
