// Reliability benchmark runner: drives the scenario catalog across the
// extraction engines, scores each trial, and emits a schema-checked
// BenchmarkResults document plus a Markdown report.
export {
  runBenchmark,
  judge,
  MissingChromeVersionError,
  resolveSuiteProvenance,
  // Exported so the verifier RE-DERIVES environment.chromeVersion with the exact
  // rule the recorder used, rather than trusting the recorded summary.
  unanimousChromeVersion,
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
  CAMPAIGN_BUDGET_THRESHOLD_USD,
  CampaignStateSchema,
  CampaignEntryStateSchema,
  UnpriceableTrialError,
  buildSchedule,
  policyRunConfig,
  initCampaignState,
  nextEntry,
  trialCost,
  shouldStop,
  makeBudgetHooks,
  runCampaign,
  assertStateMatches,
  type CampaignPhase,
  type CampaignPolicy,
  type Sweep,
  type CampaignEntry,
  type PolicyRunConfig,
  type CampaignState,
  type CampaignEntryState,
  type EntryRunContext,
  type CampaignDeps,
  type CampaignOutcome
} from "./campaignDriver";
export {
  buildHealsManifest,
  loadAndVerifySeedCacheManifest,
  type SeedCacheManifestFile
} from "./seedManifest";
export { prepSessionState } from "./prepSession";
