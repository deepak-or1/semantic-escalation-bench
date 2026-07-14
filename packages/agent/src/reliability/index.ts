// Reliability benchmark runner: drives the scenario catalog across the
// extraction engines, scores each trial, and emits a schema-checked
// BenchmarkResults document plus a Markdown report.
export {
  runBenchmark,
  judge,
  type BenchmarkRunConfig,
  type SeedCacheManifest
} from "./runner";
export { summarizeEngine, buildComparison } from "./metrics";
export { renderResultsMarkdown } from "./markdown";
export {
  aggregateCampaign,
  configurationLabel,
  renderCampaignMarkdown,
  type CampaignReport,
  type CampaignCell
} from "./campaign";
export { PINNED_PRICES, PRICES_PINNED_AT, trialCostUsd } from "./prices";
export {
  buildHealsManifest,
  loadAndVerifySeedCacheManifest,
  type SeedCacheManifestFile
} from "./seedManifest";
export { prepSessionState } from "./prepSession";
