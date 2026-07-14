import type {
  BenchmarkResults,
  EngineName,
  EngineSummary,
  ScenarioComparison,
  ScenarioSpec
} from "@ssda/shared";

/**
 * Render a BenchmarkResults document as a human-readable Markdown report:
 * an engine summary table, per-scenario comparison matrices sectioned by group
 * (core / compound / survival), the survival curve, a failures list, and
 * (when relevant) a hint about any engine that was skipped. Every engine that
 * was requested gets its own column, so this scales to any engine set.
 */
export function renderResultsMarkdown(results: BenchmarkResults): string {
  const lines: string[] = [];
  const engines = results.engines.map((e) => e.engine);
  const byGroup = groupScenarios(results.scenarios);

  lines.push("# Reliability Benchmark");
  lines.push("");
  lines.push(envLine(results));
  lines.push("");

  lines.push("## Engine summary");
  lines.push("");
  lines.push(...engineTable(results.engines));
  const heal = healLine(results.engines);
  if (heal) {
    lines.push("");
    lines.push(heal);
  }
  lines.push("");

  lines.push("## Outcome classes");
  lines.push("");
  lines.push(
    "_Behaviour classification, orthogonal to pass/fail. A schema-violation " +
      "refusal is judged PASS yet classed safe-failure. Silent-corruption " +
      "(success claimed on wrong/unverifiable data) is the headline safety metric._"
  );
  lines.push("");
  lines.push(...outcomeClassTable(results.engines));
  lines.push("");
  for (const line of silentCorruptionLines(results.engines)) lines.push(line);
  lines.push("");

  lines.push("## Scenario comparison");
  lines.push("");
  lines.push(...comparisonTable(results.comparison, byGroup.core, engines));
  lines.push("");

  if (byGroup.compound.length > 0) {
    lines.push("### Compound scenarios — obstacles co-occur");
    lines.push("");
    lines.push(...comparisonTable(results.comparison, byGroup.compound, engines));
    lines.push("");
  }

  if (byGroup.survival.length > 0) {
    lines.push("## Survival — frozen engines vs accumulating site drift");
    lines.push("");
    lines.push(...comparisonTable(results.comparison, byGroup.survival, engines));
    lines.push("");
    lines.push(...survivalMatrix(results.comparison, byGroup.survival, engines));
    lines.push("");
  }

  lines.push("## Failures");
  lines.push("");
  lines.push(...failuresList(results));
  lines.push("");

  const skipped = results.engines.filter((e) => e.skippedReason);
  if (skipped.length > 0) {
    for (const engine of skipped) {
      lines.push(`> ${engine.engine} skipped: ${engine.skippedReason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

interface GroupedScenarios {
  core: ScenarioSpec[];
  compound: ScenarioSpec[];
  survival: ScenarioSpec[];
}

function groupScenarios(scenarios: ScenarioSpec[]): GroupedScenarios {
  return {
    core: scenarios.filter((s) => s.group === "core"),
    compound: scenarios.filter((s) => s.group === "compound"),
    survival: scenarios.filter((s) => s.group === "survival")
  };
}

function envLine(results: BenchmarkResults): string {
  const env = results.environment;
  const parts = [
    `Created ${results.createdAt}`,
    `node ${env.node}`,
    `stagehand ${env.stagehandVersion ?? "n/a"}`,
    `model ${env.stagehandModel ?? "n/a"}`,
    `provider ${env.modelProvider ?? "none"}`,
    `browserbase ${env.browserbase ? "ready" : "not configured"}`,
    `${results.trialsPerScenario} trial(s)/scenario`
  ];
  return parts.join(" · ");
}

function engineTable(engines: EngineSummary[]): string[] {
  const header =
    "| Engine | Trials | Task success | Extraction | Validation | Mean accuracy | Mean duration | Retries | Recovery |";
  const divider =
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const rows = engines.map((e) => {
    const recovery =
      e.recovery.recoveryRate === null
        ? "—"
        : `${pct(e.recovery.recoveryRate)} (${e.recovery.recovered}/${e.recovery.firstAttemptFailures})`;
    return `| ${e.engine} | ${e.trials} | ${pct(e.taskSuccessRate)} | ${pct(
      e.extractionSuccessRate
    )} | ${pct(e.validationSuccessRate)} | ${pct(e.meanAccuracy)} | ${dur(
      e.meanDurationMs
    )} | ${e.totalRetries} | ${recovery} |`;
  });
  return [header, divider, ...rows];
}

/** Fixed column order for the outcome-class table. */
const OUTCOME_CLASS_ORDER = [
  "pass",
  "recovered",
  "safe-failure",
  "silent-corruption",
  "hard-failure"
] as const;

function classCount(summary: EngineSummary, key: string): number {
  return summary.outcomeClasses[key] ?? 0;
}

/** Per-engine behaviour-class counts + the count/trials silent-corruption rate. */
function outcomeClassTable(engines: EngineSummary[]): string[] {
  const header =
    "| Engine | Pass | Recovered | Safe-failure | Silent-corruption | Hard-failure | Silent-corruption rate |";
  const divider = "| --- | ---: | ---: | ---: | ---: | ---: | ---: |";
  const rows = engines.map((e) => {
    const counts = OUTCOME_CLASS_ORDER.map((k) => classCount(e, k)).join(" | ");
    const rate = e.silentCorruptionRate === null ? "—" : pct(e.silentCorruptionRate);
    return `| ${e.engine} | ${counts} | ${rate} |`;
  });
  return [header, divider, ...rows];
}

/**
 * Silent-corruption framed against three denominators, all derived from the
 * behaviour-class partition (accepted = pass + recovered + silent-corruption;
 * failures = trials − accepted): / total trials, / failures, / accepted outputs.
 * The third is the headline: of the data the pipeline vouched for, how much was
 * wrong. Skipped engines (no trials) are omitted.
 */
function silentCorruptionLines(engines: EngineSummary[]): string[] {
  return engines
    .filter((e) => e.trials > 0)
    .map((e) => {
      const silent = classCount(e, "silent-corruption");
      const accepted =
        classCount(e, "pass") + classCount(e, "recovered") + silent;
      const failures = e.trials - accepted;
      return (
        `- **${e.engine}** silent corruption: ${silent} ` +
        `(${silent}/${e.trials} trials, ${silent}/${failures} failures, ` +
        `${silent}/${accepted} accepted outputs)`
      );
    });
}

/** One line summarising LLM step-repairs, only when some engine healed. */
function healLine(engines: EngineSummary[]): string | null {
  const healed = engines.filter((e) => (e.healedTrials ?? 0) > 0);
  if (healed.length === 0) return null;
  const parts = healed.map(
    (e) => `${e.engine} healed ${e.healedTrials} of ${e.trials} trial(s)`
  );
  return `_LLM repairs: ${parts.join("; ")}._`;
}

function comparisonTable(
  comparison: ScenarioComparison[],
  scenarios: ScenarioSpec[],
  engines: EngineName[]
): string[] {
  if (scenarios.length === 0) return ["_No scenarios in this group._"];
  const ids = new Set(scenarios.map((s) => s.id));
  const rows = comparison.filter((c) => ids.has(c.scenarioId));

  const header = `| Scenario | ${engines.map(titleCase).join(" | ")} | Note |`;
  const divider = `| --- | ${engines.map(() => ":---:").join(" | ")} | --- |`;
  const body = rows.map((c) => {
    const cells = engines.map((e) => word(c.results[e] ?? "skipped")).join(" | ");
    return `| ${c.scenarioId} | ${cells} | ${cell(c.note ?? "")} |`;
  });
  return [header, divider, ...body];
}

/**
 * The survival curve: each engine's pass/fail across the ordered site versions,
 * plus the last version it survived through (the first non-pass ends the run).
 */
function survivalMatrix(
  comparison: ScenarioComparison[],
  survival: ScenarioSpec[],
  engines: EngineName[]
): string[] {
  const byId = new Map(comparison.map((c) => [c.scenarioId, c]));
  const versions = survival.map((s) => ({
    id: s.id,
    label: s.id.replace(/^site-/, "")
  }));

  const header = `| Engine | ${versions.map((v) => v.label).join(" | ")} | Survived through |`;
  const divider = `| --- | ${versions.map(() => ":---:").join(" | ")} | :---: |`;
  const rows = engines.map((engine) => {
    const cells = versions.map((v) => word(byId.get(v.id)?.results[engine] ?? "skipped"));
    return `| ${engine} | ${cells.join(" | ")} | ${survivedThrough(engine, versions, byId)} |`;
  });
  return [header, divider, ...rows];
}

function survivedThrough(
  engine: EngineName,
  versions: Array<{ id: string; label: string }>,
  byId: Map<string, ScenarioComparison>
): string {
  const statuses = versions.map((v) => byId.get(v.id)?.results[engine] ?? "skipped");
  if (statuses.every((s) => s === "skipped")) return "not run";
  let last = "none";
  for (let i = 0; i < versions.length; i++) {
    if (statuses[i] !== "pass") break;
    last = versions[i]!.label;
  }
  return last;
}

function failuresList(results: BenchmarkResults): string[] {
  const failed = results.trials.filter((t) => t.outcome === "fail");
  if (failed.length === 0) return ["_No failing trials._"];
  return failed.map((t) => {
    const category = t.failureCategory ?? "—";
    const detail = t.failureDetail ?? t.outcomeReason;
    return `- **${t.scenarioId}** (${t.engine}) [${t.outcomeClass}] — [${category}] ${detail.replace(/\n/g, " ")}`;
  });
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function dur(value: number | null): string {
  return value === null ? "—" : `${(value / 1000).toFixed(1)}s`;
}

function word(value: "pass" | "fail" | "skipped"): string {
  return value.toUpperCase();
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Make a string safe to drop into a Markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
