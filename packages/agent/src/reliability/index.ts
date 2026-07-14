// Reliability benchmark runner: drives the scenario catalog across the
// extraction engines, scores each trial, and emits a schema-checked
// BenchmarkResults document plus a Markdown report.
export { runBenchmark, type BenchmarkRunConfig } from "./runner";
export { summarizeEngine, buildComparison } from "./metrics";
export { renderResultsMarkdown } from "./markdown";
export { prepSessionState } from "./prepSession";
