import type { BenchmarkResults, EngineName, TrialResult } from "@ssda/shared";
import { trialCostUsd } from "./prices";

/**
 * Cross-run campaign aggregation (Wave E 8i, extended Wave F F3). Pure functions
 * over already-loaded BenchmarkResults documents (no filesystem, no lab): the CLI
 * wrapper scripts/aggregate-campaign.ts reads the results.json files and calls
 * these.
 *
 * Cells are grouped by scenarioId × CONFIGURATION — the frozen engine policy a
 * run exercised (see configurationLabel), not merely the engine name. Two runs
 * of the same engine under different policies (e.g. hybrid --no-repair vs. hybrid
 * seeded) never blend into one cell.
 *
 * Statistics discipline (PROTOCOL §7a): with small N we report raw counts,
 * median, and min–max range — never per-scenario percentiles. Variance is a
 * range, not stdev theater. Dollar costs are computed at analysis time from the
 * pinned price table (packages/agent/src/reliability/prices.ts); an unknown model
 * yields null, never a guess.
 */

export interface Spread {
  /** Number of samples that fed the summary. */
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface CampaignCell {
  scenarioId: string;
  /** The engine that produced this cell's trials (constant within a configuration). */
  engine: EngineName;
  /** The frozen engine policy (see configurationLabel) this cell aggregates. */
  configuration: string;
  /** Total trials for this (scenario, configuration) pair across every run. */
  trials: number;
  outcomes: { pass: number; fail: number };
  /** Behaviour-class counts (see OutcomeClassSchema keys). */
  outcomeClasses: Record<string, number>;
  /** Overall extraction accuracy across trials that produced a sample. */
  accuracy: Spread;
  /** Wall-clock duration (ms) across trials. */
  durationMs: Spread;
  /** Stagehand inference operations across trials (sum + spread). */
  llmCalls: { sum: number } & Spread;
  /** Provider-reported input/output tokens (sum + spread), when any were reported. */
  inputTokens: { sum: number } & Spread;
  outputTokens: { sum: number } & Spread;
  /**
   * Analysis-time dollar cost across trials with a COMPUTABLE cost, with explicit
   * coverage so a partial sum is never mistaken for a complete one: `priced` is
   * the number of trials whose cost was computable, `total` is every trial in the
   * cell, and the spread covers only the priced trials. `sum` is null iff
   * `priced === 0`; otherwise it is the sum over the priced trials (a lower bound
   * whenever `priced < total`).
   */
  costUsd: { sum: number | null; priced: number; total: number } & Spread;
  /**
   * Deterministic-fallback disclosure (stagehand only): `trials` is the number of
   * trials with ≥1 firing, `firings` is the total number of firings across the
   * cell (one entry per firing, so a step may count once per attempt).
   */
  deterministicFallbacks: { trials: number; firings: number };
  /** Fraction of trials in which ≥1 step was LLM-repaired. */
  healRate: number;
  /** Trials that reached success only after a whole-attempt retry. */
  retryRecoveries: number;
}

/**
 * Per-configuration rollup with the protocol-promised silent-corruption
 * denominators, fallback counts, and cost-per-successful-workflow — exposed
 * structurally so the numbers are machine-readable and the markdown is rendered
 * FROM it (never re-derived in the renderer).
 */
export interface ConfigTotal {
  configuration: string;
  /** The engine this configuration belongs to (constant per configuration). */
  engine: EngineName;
  trials: number;
  judgedPasses: number;
  judgedFailures: number;
  /** silent-corruption trials — THE headline safety count. */
  silentCorruption: number;
  /** Accepted outputs = outcomeClasses pass + recovered + silent-corruption. */
  accepted: number;
  /** Deterministic-fallback coverage: trials with ≥1 firing; total firings. */
  deterministicFallbacks: { trials: number; firings: number };
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Coverage-aware cost: sum over priced trials (null iff priced 0), priced/total. */
  cost: { sum: number | null; priced: number; total: number };
  /** cost.sum / judgedPasses, or null when passes are 0 or cost is null. */
  costPerSuccess: number | null;
}

export interface CampaignReport {
  createdAt: string;
  /** Source bench directories (or ids), for provenance. */
  sources: string[];
  /** Number of runs aggregated. */
  runs: number;
  /**
   * True iff EVERY aggregated run has runPurpose "smoke". A smoke aggregation is
   * kept structurally separate from evidence: configuration labels are prefixed
   * `smoke:` and the report is titled so it can never be mistaken for campaign
   * evidence. Mixing smoke with any non-smoke run is a throw, not a flag.
   */
  smoke: boolean;
  cells: CampaignCell[];
  /** Per-configuration rollups (D1/D2/D3, fallbacks, cost-per-success). */
  configTotals: ConfigTotal[];
  /**
   * Non-fatal provenance differences across the aggregated runs (e.g. runs span
   * multiple gitCommit or seedCacheHash values) plus cost-coverage lower-bound
   * notices. Never a throw — seeded persistence runs legitimately differ in
   * seedCacheHash.
   */
  warnings: string[];
}

/** A trial paired with the model of the run it came from (for per-run cost). */
interface CellTrial {
  trial: TrialResult;
  model: string | undefined;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function spread(values: number[]): Spread {
  return {
    n: values.length,
    median: median(values),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/**
 * The frozen engine policy a run exercised — the campaign's grouping dimension.
 * Derived from the engine plus the run's environment provenance so two runs of
 * the same engine under different flags never merge:
 *  - baseline  → "A-baseline"
 *  - stagehand → "D-full-semantic"
 *  - hybrid    → "B2-deterministic-repair" (repairMode=deterministic, checked
 *                first), "B-structural" (--no-repair), "hybrid-keyless" (no model key),
 *                "C-hybrid-repair-cold" (keyed, no seed cache), or — when keyed
 *                AND seeded — split by run purpose so paired persistence runs
 *                never blend into the warm economics sweep (they can share a
 *                seedCacheHash): "C-hybrid-repair-persistence",
 *                "C-hybrid-repair-warm", or "C-hybrid-repair-seeded" (defensive
 *                fallback for any other seeded purpose, e.g. legacy results).
 */
export function configurationLabel(
  engine: EngineName,
  env: BenchmarkResults["environment"]
): string {
  if (engine === "baseline") return "A-baseline";
  if (engine === "stagehand") return "D-full-semantic";
  // hybrid: repairMode=deterministic (B2) is checked FIRST so it never collapses
  // into B-structural; Phase-1 files lack repairMode (undefined) and fall through
  // to the unchanged labels below (PROTOCOL_2A §1).
  if (env.repairMode === "deterministic") return "B2-deterministic-repair";
  // precedence: disableRepair → keyless → seed-cache mode → purpose.
  if (env.disableRepair) return "B-structural";
  if (env.modelProvider == null) return "hybrid-keyless";
  if (env.seedCacheMode === "none") return "C-hybrid-repair-cold";
  if (env.runPurpose === "persistence") return "C-hybrid-repair-persistence";
  if (env.runPurpose === "warm") return "C-hybrid-repair-warm";
  return "C-hybrid-repair-seeded";
}

function cellFor(
  scenarioId: string,
  configuration: string,
  engine: EngineName,
  cellTrials: CellTrial[]
): CampaignCell {
  const trials = cellTrials.map((ct) => ct.trial);
  const pass = trials.filter((t) => t.outcome === "pass").length;
  const outcomeClasses: Record<string, number> = {};
  for (const t of trials) {
    outcomeClasses[t.outcomeClass] = (outcomeClasses[t.outcomeClass] ?? 0) + 1;
  }

  const accuracyValues = trials
    .map((t) => t.accuracy?.overall)
    .filter((v): v is number => typeof v === "number");
  const durations = trials.map((t) => t.durationMs);

  const llmCallValues = trials
    .map((t) => t.tokens?.llmCalls)
    .filter((v): v is number => typeof v === "number");
  const inputValues = trials
    .map((t) => t.tokens?.inputTokens)
    .filter((v): v is number => typeof v === "number");
  const outputValues = trials
    .map((t) => t.tokens?.outputTokens)
    .filter((v): v is number => typeof v === "number");

  // Per-trial cost uses the model of the RUN the trial came from, not a global.
  // Baseline trials are structurally incapable of inference (no Stagehand
  // instance is ever constructed), so their cost is a real, priced $0 — never
  // null. Every other engine prices from its run's model via trialCostUsd.
  const perTrialCost = cellTrials.map((ct) =>
    engine === "baseline" ? 0 : trialCostUsd(ct.trial.tokens, ct.model)
  );
  const pricedCosts = perTrialCost.filter((v): v is number => v !== null);

  const fbTrials = trials.filter((t) => (t.deterministicFallbacks?.length ?? 0) > 0).length;
  const fbFirings = sum(trials.map((t) => t.deterministicFallbacks?.length ?? 0));

  const healed = trials.filter((t) => (t.healedSteps?.length ?? 0) > 0).length;
  const retryRecoveries = trials.filter((t) => t.recoveredAfterFailure).length;

  return {
    scenarioId,
    engine,
    configuration,
    trials: trials.length,
    outcomes: { pass, fail: trials.length - pass },
    outcomeClasses,
    accuracy: spread(accuracyValues),
    durationMs: spread(durations),
    llmCalls: { sum: sum(llmCallValues), ...spread(llmCallValues) },
    inputTokens: { sum: sum(inputValues), ...spread(inputValues) },
    outputTokens: { sum: sum(outputValues), ...spread(outputValues) },
    costUsd: {
      sum: pricedCosts.length ? sum(pricedCosts) : null,
      priced: pricedCosts.length,
      total: cellTrials.length,
      ...spread(pricedCosts)
    },
    deterministicFallbacks: { trials: fbTrials, firings: fbFirings },
    healRate: trials.length === 0 ? 0 : healed / trials.length,
    retryRecoveries
  };
}

/**
 * Roll cells up per configuration (first-appearance order) with the protocol's
 * silent-corruption denominators, deterministic-fallback counts, cost coverage,
 * and cost-per-successful-workflow. Pure over the already-built cells.
 */
function computeConfigTotals(cells: CampaignCell[]): ConfigTotal[] {
  const order: string[] = [];
  const byConfig = new Map<string, ConfigTotal>();
  for (const c of cells) {
    let t = byConfig.get(c.configuration);
    if (!t) {
      t = {
        configuration: c.configuration,
        engine: c.engine,
        trials: 0,
        judgedPasses: 0,
        judgedFailures: 0,
        silentCorruption: 0,
        accepted: 0,
        deterministicFallbacks: { trials: 0, firings: 0 },
        llmCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: { sum: null, priced: 0, total: 0 },
        costPerSuccess: null
      };
      byConfig.set(c.configuration, t);
      order.push(c.configuration);
    }
    t.trials += c.trials;
    t.judgedPasses += c.outcomes.pass;
    t.judgedFailures += c.outcomes.fail;
    const sc = c.outcomeClasses["silent-corruption"] ?? 0;
    t.silentCorruption += sc;
    // Accepted outputs = pass + recovered + silent-corruption (the three classes
    // where the engine claimed a result), the D3 denominator.
    t.accepted += (c.outcomeClasses["pass"] ?? 0) + (c.outcomeClasses["recovered"] ?? 0) + sc;
    t.deterministicFallbacks.trials += c.deterministicFallbacks.trials;
    t.deterministicFallbacks.firings += c.deterministicFallbacks.firings;
    t.llmCalls += c.llmCalls.sum;
    t.inputTokens += c.inputTokens.sum;
    t.outputTokens += c.outputTokens.sum;
    t.cost.priced += c.costUsd.priced;
    t.cost.total += c.costUsd.total;
    if (c.costUsd.sum !== null) t.cost.sum = (t.cost.sum ?? 0) + c.costUsd.sum;
  }
  for (const t of byConfig.values()) {
    t.costPerSuccess =
      t.cost.sum !== null && t.judgedPasses > 0 ? t.cost.sum / t.judgedPasses : null;
  }
  return order.map((cfg) => byConfig.get(cfg)!);
}

/**
 * Aggregate several benchmark runs into a per-(scenario × configuration) campaign
 * report.
 *
 * Smoke separation is UNCONDITIONAL and independent of `allowMixed`: mixing any
 * run with `runPurpose === "smoke"` and any non-smoke run THROWS (smoke results
 * can never enter campaign evidence). An all-smoke aggregation is allowed (the
 * protocol's smoke cost check needs it): `report.smoke` is true, every
 * configuration label is prefixed `smoke:`, and the markdown is titled so it can
 * never be mistaken for evidence.
 *
 * Otherwise THROWS (listing the distinct values) when input runs disagree on
 * `environment.promptsHash` or on non-null `environment.stagehandModel`, unless
 * `opts.allowMixed` — mixing prompts or models makes a single comparison
 * meaningless. Differences in `gitCommit` or `seedCacheHash` are reported as
 * `warnings` (never a throw; seeded persistence runs legitimately differ), as is
 * any configuration whose cost coverage is incomplete (priced < total).
 *
 * Cells are ordered by first appearance of the scenario, then of the
 * configuration within that scenario.
 */
export function aggregateCampaign(
  runs: BenchmarkResults[],
  meta: { sources?: string[]; createdAt?: string } = {},
  opts: { allowMixed?: boolean } = {}
): CampaignReport {
  // ── Smoke separation (UNCONDITIONAL; allowMixed does NOT override) ────────
  const purposes = runs.map((r) => r.environment.runPurpose);
  const hasSmoke = purposes.some((p) => p === "smoke");
  const hasNonSmoke = purposes.some((p) => p !== "smoke");
  if (hasSmoke && hasNonSmoke) {
    throw new Error(
      "Cannot aggregate: runs mix runPurpose 'smoke' with non-smoke runs. Smoke " +
        "results can never enter campaign evidence (allowMixed does NOT override this)."
    );
  }
  const smoke = hasSmoke; // by the guard above, all-smoke whenever true

  // ── Protocol / suite gate (PROTOCOL_2A §5 item 6; UNCONDITIONAL) ───────────
  // Aggregating runs whose environment.protocolId or suiteHash differ is a HARD
  // ERROR (never a warning, never overridable by allowMixed): a single campaign
  // number over two different protocols or two different held-out suites is
  // meaningless. Pre-stage-1 evidence files carry NEITHER field; they all share
  // the `undefined` value and so form ONE legacy group that still aggregates.
  const runLabelFor = (i: number): string =>
    meta.sources?.[i] ?? runs[i]?.benchId ?? `run #${i + 1}`;
  const namedMismatch = (field: "protocolId" | "suiteHash"): string => {
    const byValue = new Map<string, string[]>();
    runs.forEach((r, i) => {
      const value = r.environment[field] ?? "<none>";
      const bucket = byValue.get(value) ?? [];
      bucket.push(runLabelFor(i));
      byValue.set(value, bucket);
    });
    return [...byValue.entries()]
      .map(([value, labels]) => `${value} [${labels.join(", ")}]`)
      .join("; ");
  };
  if (new Set(runs.map((r) => r.environment.protocolId)).size > 1) {
    throw new Error(
      `Cannot aggregate: runs disagree on environment.protocolId (${namedMismatch("protocolId")}). ` +
        `Runs of different protocols can never share a campaign report.`
    );
  }
  if (new Set(runs.map((r) => r.environment.suiteHash)).size > 1) {
    throw new Error(
      `Cannot aggregate: runs disagree on environment.suiteHash (${namedMismatch("suiteHash")}). ` +
        `Runs of different held-out suites can never share a campaign report.`
    );
  }

  // ── Consistency gate ──────────────────────────────────────────────────────
  const promptsHashes = [...new Set(runs.map((r) => r.environment.promptsHash))];
  const stagehandModels = [
    ...new Set(
      runs.map((r) => r.environment.stagehandModel).filter((m): m is string => m != null)
    )
  ];
  if (!opts.allowMixed) {
    if (promptsHashes.length > 1) {
      throw new Error(
        `Cannot aggregate: runs disagree on environment.promptsHash (${promptsHashes.join(
          ", "
        )}). Pass { allowMixed: true } (or --allow-mixed) to override.`
      );
    }
    if (stagehandModels.length > 1) {
      throw new Error(
        `Cannot aggregate: runs disagree on environment.stagehandModel (${stagehandModels.join(
          ", "
        )}). Pass { allowMixed: true } (or --allow-mixed) to override.`
      );
    }
  }

  const warnings: string[] = [];
  const gitCommits = [...new Set(runs.map((r) => r.environment.gitCommit ?? "null"))];
  if (gitCommits.length > 1) {
    warnings.push(`Runs span multiple gitCommit values: ${gitCommits.join(", ")}.`);
  }
  const seedCacheHashes = [...new Set(runs.map((r) => r.environment.seedCacheHash ?? "null"))];
  if (seedCacheHashes.length > 1) {
    warnings.push(`Runs span multiple seedCacheHash values: ${seedCacheHashes.join(", ")}.`);
  }

  // ── Group by scenarioId × configuration (scenario-major ordering) ─────────
  const scenarioOrder: string[] = [];
  const configOrder = new Map<string, string[]>();
  const byKey = new Map<
    string,
    { scenarioId: string; configuration: string; engine: EngineName; trials: CellTrial[] }
  >();

  for (const run of runs) {
    const env = run.environment;
    const model = env.stagehandModel;
    for (const trial of run.trials) {
      const baseConfig = configurationLabel(trial.engine, env);
      // Smoke labels are prefixed so an all-smoke aggregation can never key into
      // the same cell as a real-evidence configuration.
      const configuration = smoke ? `smoke:${baseConfig}` : baseConfig;
      if (!scenarioOrder.includes(trial.scenarioId)) scenarioOrder.push(trial.scenarioId);
      const configs = configOrder.get(trial.scenarioId) ?? [];
      if (!configs.includes(configuration)) configs.push(configuration);
      configOrder.set(trial.scenarioId, configs);

      const key = `${trial.scenarioId}\u0000${configuration}`;
      const bucket = byKey.get(key);
      if (bucket) bucket.trials.push({ trial, model });
      else
        byKey.set(key, {
          scenarioId: trial.scenarioId,
          configuration,
          engine: trial.engine,
          trials: [{ trial, model }]
        });
    }
  }

  const cells: CampaignCell[] = [];
  for (const scenarioId of scenarioOrder) {
    for (const configuration of configOrder.get(scenarioId) ?? []) {
      const bucket = byKey.get(`${scenarioId}\u0000${configuration}`);
      if (!bucket || bucket.trials.length === 0) continue;
      cells.push(cellFor(scenarioId, configuration, bucket.engine, bucket.trials));
    }
  }

  const configTotals = computeConfigTotals(cells);
  // Cost-coverage honesty: any configuration with an unpriced trial makes its
  // cost total a lower bound; disclose it (never a throw).
  for (const t of configTotals) {
    if (t.cost.priced < t.cost.total) {
      const missing = t.cost.total - t.cost.priced;
      warnings.push(
        `${t.configuration}: ${missing} of ${t.cost.total} trials have no computable cost — cost totals are lower bounds.`
      );
    }
  }

  return {
    createdAt: meta.createdAt ?? new Date().toISOString(),
    sources: meta.sources ?? [],
    runs: runs.length,
    smoke,
    cells,
    configTotals,
    warnings
  };
}

function fixed(value: number | null, digits: number): string {
  return value === null ? "—" : value.toFixed(digits);
}

function range(s: Spread, digits: number): string {
  if (s.min === null || s.max === null) return "—";
  return s.min === s.max ? fixed(s.min, digits) : `${fixed(s.min, digits)}–${fixed(s.max, digits)}`;
}

/** "x/N (p%)", or "—" when the denominator is 0. */
function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${numerator}/${denominator} (${((numerator / denominator) * 100).toFixed(0)}%)`;
}

/** Render a campaign report as Markdown: one row per (scenario × configuration) cell. */
export function renderCampaignMarkdown(report: CampaignReport): string {
  const lines: string[] = [];
  lines.push(
    report.smoke ? "# Campaign aggregation — SMOKE (never evidence)" : "# Campaign aggregation"
  );
  lines.push("");
  lines.push(
    `Aggregated ${report.runs} run(s) · ${report.cells.length} scenario×configuration cell(s) · ` +
      `generated ${report.createdAt}`
  );
  if (report.sources.length > 0) {
    lines.push("");
    lines.push(`Sources: ${report.sources.join(", ")}`);
  }
  lines.push("");
  lines.push(
    "| Scenario | Config | Engine | Trials | Pass | Fail | Acc median | Acc range | " +
      "Dur median (s) | Dur range (s) | llmCalls sum | llmCalls median | Det FB (trials) | " +
      "Cost sum ($, priced) | Cost range ($) | Heal rate | Retry rec |"
  );
  lines.push(
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const c of report.cells) {
    const durMedS = c.durationMs.median === null ? null : c.durationMs.median / 1000;
    const durMin = c.durationMs.min === null ? null : c.durationMs.min / 1000;
    const durMax = c.durationMs.max === null ? null : c.durationMs.max / 1000;
    lines.push(
      `| ${c.scenarioId} | ${c.configuration} | ${c.engine} | ${c.trials} | ${c.outcomes.pass} | ${c.outcomes.fail} | ` +
        `${fixed(c.accuracy.median, 3)} | ${range(c.accuracy, 3)} | ` +
        `${fixed(durMedS, 2)} | ${range({ n: 0, median: null, min: durMin, max: durMax }, 2)} | ` +
        `${c.llmCalls.sum} | ${fixed(c.llmCalls.median, 1)} | ` +
        `${c.deterministicFallbacks.firings} (${c.deterministicFallbacks.trials}) | ` +
        `${fixed(c.costUsd.sum, 4)} (${c.costUsd.priced}/${c.costUsd.total}) | ${range(c.costUsd, 4)} | ` +
        `${(c.healRate * 100).toFixed(0)}% | ${c.retryRecoveries} |`
    );
  }
  lines.push("");

  if (report.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  // ── Per-configuration totals (rendered FROM report.configTotals) ──────────
  lines.push("## Per-configuration totals");
  lines.push("");
  for (const t of report.configTotals) {
    lines.push(`### ${t.configuration} (${t.engine})`);
    lines.push("");
    lines.push(
      `- Trials: ${t.trials} · judged passes: ${t.judgedPasses} · judged failures: ${t.judgedFailures}`
    );
    lines.push(
      `- Silent corruption — D1 (of trials): ${ratio(t.silentCorruption, t.trials)} · ` +
        `D2 (of judged failures): ${ratio(t.silentCorruption, t.judgedFailures)} · ` +
        `D3 (of accepted outputs): ${ratio(t.silentCorruption, t.accepted)}`
    );
    lines.push(
      `- Deterministic fallbacks: ${t.deterministicFallbacks.firings} firing(s) across ` +
        `${t.deterministicFallbacks.trials} trial(s)`
    );
    lines.push(
      `- llmCalls: ${t.llmCalls} · input tokens: ${t.inputTokens} · output tokens: ${t.outputTokens}`
    );
    const costSum = t.cost.sum === null ? "—" : `$${t.cost.sum.toFixed(4)}`;
    const incomplete = t.cost.priced < t.cost.total ? " — INCOMPLETE, lower bound" : "";
    lines.push(`- Cost: ${costSum} (priced ${t.cost.priced}/${t.cost.total})${incomplete}`);
    const cps = t.costPerSuccess === null ? "—" : `$${t.costPerSuccess.toFixed(4)}`;
    lines.push(`- Cost per successful workflow: ${cps}`);
    lines.push("");
  }

  return lines.join("\n");
}
