// Reliability benchmark runner: drives the scenario catalog across the
// extraction engines, scores each trial, and emits a schema-checked
// BenchmarkResults document plus a Markdown report.
export {
  runBenchmark,
  judge,
  resolveSuiteProvenance,
  validateRunPurpose,
  type BenchmarkRunConfig,
  type SeedCacheManifest
} from "./runner";
// classifyOutcome is re-exported (in addition to the summary builders) so the
// generic suite verifier can recompute the behaviour class from the SAME frozen
// function the runner uses, never a reimplementation (PROTOCOL_2A §5 item 5).
export { summarizeEngine, buildComparison, classifyOutcome } from "./metrics";
export { renderResultsMarkdown } from "./markdown";
export {
  aggregateCampaign,
  configurationLabel,
  renderCampaignMarkdown,
  type CampaignReport,
  type CampaignCell,
  type ConfigTotal
} from "./campaign";
export { PINNED_PRICES, PRICES_PINNED_AT, trialCostUsd } from "./prices";
export {
  buildHealsManifest,
  loadAndVerifySeedCacheManifest,
  type SeedCacheManifestFile
} from "./seedManifest";
export { prepSessionState } from "./prepSession";
