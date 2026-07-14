import { readFileSync } from "node:fs";
import {
  ENGINES,
  FAILURE_CATEGORIES,
  type BenchmarkResults,
  type EngineName,
  type EngineSummary,
  type OutcomeClass,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import type { DashboardData, ScreenshotRef } from "./data";
import type { ValueSelection } from "./watchlist";
import {
  barPathRight,
  esc,
  jsonForScript,
  niceTicks,
  pct,
  secs,
  signedPct,
  truncate
} from "./format";

/**
 * Renders the whole dashboard as one self-contained HTML document: inline CSS,
 * inline SVG charts, an inline interactivity script, and a JSON data island.
 * No external resources of any kind, so the file works offline and can be
 * written straight to disk as a report.
 *
 * embedAssets=true  → screenshots inlined as base64 data URIs (for the report).
 * embedAssets=false → screenshots referenced as "/runs/…" URLs (for the server).
 */

// ── Design tokens (dark-committed, single mode) ──────────────────────────────
const TOK = {
  page: "#0d0d0d",
  surface: "#1a1a19",
  ink: "#ffffff",
  ink2: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",
  border: "rgba(255,255,255,0.10)",
  // Series colours follow the entity, never reassigned. CVD-validated triple in
  // dark (worst pair ΔE 33.5 excl. the pre-existing blue/green, contrast ≥ 4.7).
  stagehand: "#3987e5",
  baseline: "#199e70",
  hybrid: "#f0a04b",
  // Status scale — always paired with an icon + label, never colour alone.
  pass: "#0ca30c",
  fail: "#d03b3b",
  warning: "#fab219"
} as const;

const SERIES: Record<EngineName, { key: EngineName; label: string; color: string }> = {
  stagehand: { key: "stagehand", label: "Stagehand", color: TOK.stagehand },
  baseline: { key: "baseline", label: "Baseline", color: TOK.baseline },
  hybrid: { key: "hybrid", label: "Hybrid", color: TOK.hybrid }
};

const DISCLAIMER = "Read-only analytics demo · synthetic data · no wagering";

// A grey tile shown when a screenshot is over the embed cap or unreadable.
const PLACEHOLDER =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150">' +
      '<rect width="100%" height="100%" fill="#1a1a19" stroke="#383835"/>' +
      '<text x="50%" y="50%" fill="#898781" font-family="system-ui" font-size="11" ' +
      'text-anchor="middle" dominant-baseline="middle">screenshot omitted</text></svg>'
  ).toString("base64");

// ── Small helpers ────────────────────────────────────────────────────────────

/** ISO timestamp → a compact, deterministic "YYYY-MM-DD HH:MM UTC". */
function when(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Returns a screenshot `src`. When embedding, reads the file and inlines it as
 * base64 under a per-image (~1.5MB) and total (~8MB) budget; past either cap it
 * falls back to the placeholder tile so the document size stays bounded.
 */
function makeImgSrc(embed: boolean): (ref: ScreenshotRef) => string {
  const PER_CAP = 1.5 * 1024 * 1024;
  const TOTAL_CAP = 8 * 1024 * 1024;
  let total = 0;
  return (ref) => {
    if (!embed) return ref.url ?? PLACEHOLDER;
    if (ref.sizeBytes > PER_CAP || total + ref.sizeBytes > TOTAL_CAP) return PLACEHOLDER;
    try {
      const buf = readFileSync(ref.absPath);
      total += buf.length;
      return "data:image/png;base64," + buf.toString("base64");
    } catch {
      return PLACEHOLDER;
    }
  };
}

/** Which engines actually produced trials (skipped engines are excluded). */
function activeEngines(results: BenchmarkResults): EngineName[] {
  return ENGINES.filter((e) => {
    const s = results.engines.find((x) => x.engine === e);
    return !!s && !s.skippedReason && s.trials > 0;
  });
}

/**
 * Every engine the run requested (summarised), in canonical order — including a
 * skipped one. This is the column/tile set: any number of engines, no phantoms
 * for engines that were never part of the run.
 */
function requestedEngines(results: BenchmarkResults): EngineName[] {
  const present = new Set(results.engines.map((e) => e.engine));
  return ENGINES.filter((e) => present.has(e));
}

function summaryOf(results: BenchmarkResults, engine: EngineName): EngineSummary | undefined {
  return results.engines.find((s) => s.engine === engine);
}

function trialsFor(
  results: BenchmarkResults,
  scenarioId: string,
  engine: EngineName
): TrialResult[] {
  return results.trials.filter((t) => t.scenarioId === scenarioId && t.engine === engine);
}

// ── Status chip (icon + label, never colour alone) ───────────────────────────
type Status = "pass" | "fail" | "skipped" | "warning";

function statusChip(status: Status, extra = ""): string {
  const map: Record<Status, { glyph: string; label: string; cls: string }> = {
    pass: { glyph: "✓", label: "pass", cls: "st-pass" },
    fail: { glyph: "✕", label: "fail", cls: "st-fail" },
    skipped: { glyph: "—", label: "skipped", cls: "st-skip" },
    warning: { glyph: "⚠", label: "warning", cls: "st-warn" }
  };
  const s = map[status];
  return (
    `<span class="chip ${s.cls}"><span class="ic" aria-hidden="true">${s.glyph}</span>` +
    `${s.label}${extra ? ` <span class="chip-extra">${extra}</span>` : ""}</span>`
  );
}

// ── Outcome-class chip (behaviour class, icon + label, never colour alone) ────
const OUTCOME_CLASS_ORDER: OutcomeClass[] = [
  "pass",
  "recovered",
  "safe-failure",
  "silent-corruption",
  "hard-failure"
];

const CLASS_CHIP: Record<OutcomeClass, { glyph: string; label: string; cls: string }> = {
  pass: { glyph: "✓", label: "pass", cls: "st-pass" },
  recovered: { glyph: "↻", label: "recovered", cls: "st-rec" },
  "safe-failure": { glyph: "⚠", label: "safe failure", cls: "st-warn" },
  "silent-corruption": { glyph: "⚑", label: "silent corruption", cls: "st-corrupt" },
  "hard-failure": { glyph: "✕", label: "hard failure", cls: "st-fail" }
};

function outcomeClassChip(cls: OutcomeClass, extra = ""): string {
  const c = CLASS_CHIP[cls];
  return (
    `<span class="chip ${c.cls}"><span class="ic" aria-hidden="true">${c.glyph}</span>` +
    `${c.label}${extra ? ` <span class="chip-extra">${extra}</span>` : ""}</span>`
  );
}

/**
 * Silent-corruption framed against three denominators (all from the behaviour
 * class partition): / total trials, / failures, / accepted outputs — where
 * accepted = pass + recovered + silent-corruption. The third is the headline:
 * of the data the pipeline vouched for, how much was wrong.
 */
function silentCorruptionLine(summary: EngineSummary): string {
  const count = (k: OutcomeClass): number => summary.outcomeClasses[k] ?? 0;
  const silent = count("silent-corruption");
  const accepted = count("pass") + count("recovered") + silent;
  const failures = summary.trials - accepted;
  const text =
    `silent corruption: ${silent} (${silent}/${summary.trials} trials, ` +
    `${silent}/${failures} failures, ${silent}/${accepted} accepted outputs)`;
  return (
    `<p class="tile-scr">` +
    `<span class="ic ${silent > 0 ? "sc-hot" : "sc-cold"}" aria-hidden="true">⚑</span>` +
    `${esc(text)}</p>`
  );
}

// ── Grouped horizontal bar chart (inline SVG) ────────────────────────────────
interface BarRow {
  key: string;
  label: string;
  values: Array<{ seriesKey: EngineName; value: number | null }>;
}

function groupedHBarChart(opts: {
  rows: BarRow[];
  series: Array<{ key: EngineName; label: string; color: string }>;
  axisMax: number;
  ticks: number[];
  fmtValue: (v: number) => string;
  fmtTick: (v: number) => string;
  ariaLabel: string;
}): string {
  const { rows, series, axisMax, ticks, fmtValue, fmtTick, ariaLabel } = opts;
  const W = 920;
  const padL = 152;
  const padR = 66;
  const padT = 10;
  const padB = 34;
  const plotW = W - padL - padR;
  const barThick = 14;
  const barGap = 2; // 2px surface gap between adjacent bars in a group
  const groupPad = 14;
  const n = Math.max(series.length, 1);
  const rowBand = n * barThick + (n - 1) * barGap + groupPad;
  const plotBottom = padT + rows.length * rowBand;
  const H = plotBottom + padB;
  const x = (v: number) => padL + (axisMax > 0 ? (v / axisMax) * plotW : 0);

  const parts: string[] = [];
  parts.push(
    `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" ` +
      `role="img" aria-label="${esc(ariaLabel)}" preserveAspectRatio="xMinYMin meet">`
  );

  // Gridlines + vertical baseline (drawn first so marks sit on top).
  for (const t of ticks) {
    const gx = x(t);
    const stroke = t === 0 ? TOK.axis : TOK.grid;
    parts.push(
      `<line x1="${gx.toFixed(1)}" y1="${padT}" x2="${gx.toFixed(1)}" y2="${plotBottom}" ` +
        `stroke="${stroke}" stroke-width="1" />`
    );
  }

  // Bars, direct labels, gutter labels.
  rows.forEach((row, i) => {
    const rowTop = padT + i * rowBand;
    parts.push(
      `<text class="ax-lbl" x="${padL - 8}" y="${(rowTop + rowBand / 2).toFixed(1)}" ` +
        `text-anchor="end" dominant-baseline="middle">${esc(truncate(row.label, 20))}</text>`
    );
    series.forEach((s, j) => {
      const cell = row.values.find((v) => v.seriesKey === s.key);
      const value = cell ? cell.value : null;
      const barY = rowTop + groupPad / 2 + j * (barThick + barGap);
      const midY = barY + barThick / 2;
      const label = value === null ? "n/a" : fmtValue(value);
      if (value !== null && value > 0) {
        const w = x(value) - padL;
        parts.push(
          `<path d="${barPathRight(padL, barY, w, barThick, 4)}" fill="${s.color}" />`
        );
      }
      const tipX = value !== null && value > 0 ? x(value) + 6 : padL + 6;
      const labelCls = value === null ? "val-na" : "val";
      parts.push(
        `<text class="${labelCls}" x="${tipX.toFixed(1)}" y="${midY.toFixed(1)}" ` +
          `dominant-baseline="middle">${esc(label)}</text>`
      );
      // Full-width transparent hit target (>= bar row height) for hover/focus.
      parts.push(
        `<rect class="hit" data-tt="1" x="${padL}" y="${(barY - barGap / 2).toFixed(1)}" ` +
          `width="${plotW}" height="${barThick + barGap}" tabindex="0" role="img" ` +
          `data-color="${s.color}" data-series="${esc(s.label)}" data-cat="${esc(row.label)}" ` +
          `data-value="${esc(label)}" aria-label="${esc(`${row.label}, ${s.label}: ${label}`)}" />`
      );
    });
  });

  // X-axis tick labels.
  for (const t of ticks) {
    parts.push(
      `<text class="ax-tick" x="${x(t).toFixed(1)}" y="${plotBottom + 16}" ` +
        `text-anchor="middle">${esc(fmtTick(t))}</text>`
    );
  }

  parts.push("</svg>");
  return parts.join("");
}

function legend(series: Array<{ label: string; color: string }>): string {
  const items = series
    .map(
      (s) =>
        `<span class="lg"><span class="lg-key" style="background:${s.color}"></span>` +
        `${esc(s.label)}</span>`
    )
    .join("");
  return `<div class="legend">${items}</div>`;
}

function panel(opts: { title: string; subtitle?: string; body: string; id?: string }): string {
  return (
    `<section class="panel"${opts.id ? ` id="${opts.id}"` : ""}>` +
    `<h2 class="panel-title">${esc(opts.title)}</h2>` +
    (opts.subtitle ? `<p class="panel-sub">${esc(opts.subtitle)}</p>` : "") +
    opts.body +
    `</section>`
  );
}

function emptyState(message: string, command: string): string {
  return (
    `<div class="empty"><p>${esc(message)}</p>` +
    `<p class="empty-cmd">Run <code>${esc(command)}</code> to produce it.</p></div>`
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function headerSection(): string {
  return (
    `<header class="head">` +
    `<div><h1>Stateful Sports Data Agent</h1>` +
    `<p class="sub">Browser-native sports analytics + reliability evaluation — ` +
    `Stagehand on Browserbase vs a selector baseline</p></div>` +
    `<span class="badge">${esc(DISCLAIMER)}</span>` +
    `</header>`
  );
}

function tileMetric(label: string, value: string): string {
  return `<div class="metric"><span class="m-lbl">${esc(label)}</span><span class="m-val num">${esc(value)}</span></div>`;
}

function tilesSection(results: BenchmarkResults): string {
  const modelProvider = results.environment.modelProvider;
  const cards = requestedEngines(results).map((engine) => {
    const s = summaryOf(results, engine);
    const color = SERIES[engine].color;
    const head = `<div class="tile-head"><span class="tile-name">${esc(SERIES[engine].label)}</span></div>`;
    if (!s || s.skippedReason) {
      const reason = s?.skippedReason ?? "not run";
      return (
        `<div class="tile" style="--accent:${color}">${head}` +
        `<p class="tile-skip">not run — needs a model key (see <code>.env.example</code>)</p>` +
        `<p class="tile-skip-why">${esc(reason)}</p></div>`
      );
    }
    const recovery =
      s.recovery.recoveryRate === null
        ? "n/a"
        : `${pct(s.recovery.recoveryRate)} (${s.recovery.recovered}/${s.recovery.firstAttemptFailures})`;
    const metrics = [
      tileMetric("task success", s.taskSuccessRate === null ? "n/a" : pct(s.taskSuccessRate)),
      tileMetric(
        "extraction success",
        s.extractionSuccessRate === null ? "n/a" : pct(s.extractionSuccessRate)
      ),
      tileMetric("mean accuracy", s.meanAccuracy === null ? "n/a" : pct(s.meanAccuracy)),
      tileMetric("mean duration", s.meanDurationMs === null ? "n/a" : secs(s.meanDurationMs, 2)),
      tileMetric("recovery rate", recovery)
    ];
    // Hybrid's story is LLM step-repairs: show the count, and flag when the
    // repair path was unavailable because no model key was configured.
    if (engine === "hybrid") {
      metrics.push(tileMetric("llm repairs", String(s.healedTrials ?? 0)));
    }
    const note =
      engine === "hybrid" && modelProvider === null
        ? `<p class="tile-skip-why">repairs unavailable (no model key)</p>`
        : "";
    // Behaviour-class chips (non-zero classes) + the silent-corruption framing.
    const classChips = OUTCOME_CLASS_ORDER.filter(
      (k) => k !== "silent-corruption" && (s.outcomeClasses[k] ?? 0) > 0
    )
      .map((k) => outcomeClassChip(k, String(s.outcomeClasses[k])))
      .join("");
    const classRow = classChips ? `<div class="tile-classes">${classChips}</div>` : "";
    return (
      `<div class="tile" style="--accent:${color}">${head}` +
      `<div class="tile-metrics">${metrics.join("")}</div>${note}` +
      `${classRow}${silentCorruptionLine(s)}` +
      `<p class="tile-foot">${s.trials} trial${s.trials === 1 ? "" : "s"}</p></div>`
    );
  }).join("");
  return panel({
    title: "Engine scorecard",
    subtitle: "Aggregate reliability per engine across every scenario.",
    body: `<div class="tiles">${cards}</div>`
  });
}

function scenarioTags(scenario: ScenarioSpec): string {
  const tags: string[] = [];
  tags.push(`<span class="tag tag-session">${esc(scenario.session)}</span>`);
  if (scenario.expected !== "success") {
    tags.push(`<span class="tag tag-exp">${esc(scenario.expected)}</span>`);
  }
  for (const c of scenario.chaos) tags.push(`<span class="tag tag-chaos">${esc(c)}</span>`);
  if (scenario.chaos.length === 0 && scenario.expected === "success") {
    tags.push(`<span class="tag tag-clean">no chaos</span>`);
  }
  return `<div class="tags">${tags.join("")}</div>`;
}

/** The status of one engine on one scenario, from the record-form comparison. */
function comparisonCell(
  results: BenchmarkResults,
  scenarioId: string,
  engine: EngineName
): Status {
  const c = results.comparison.find((x) => x.scenarioId === scenarioId);
  return (c?.results[engine] ?? "skipped") as Status;
}

/** One engines × scenarios outcome table (failed cells link to detail). */
function matrixTable(
  results: BenchmarkResults,
  scenarios: ScenarioSpec[],
  engines: EngineName[]
): string {
  const rows = scenarios
    .map((scenario) => {
      const nameCell =
        `<td class="mx-scn"><div class="mx-name">${esc(scenario.name)}</div>` +
        `<div class="mx-id">${esc(scenario.id)}</div>` +
        scenarioTags(scenario) +
        `</td>`;
      const cells = engines
        .map((engine) => {
          const status = comparisonCell(results, scenario.id, engine);
          if (status === "fail") {
            const trial = trialsFor(results, scenario.id, engine)[0];
            const cat = trial?.failureCategory ?? "failure";
            return (
              `<td class="mx-cell">` +
              `<a class="mx-link" href="#fail-${esc(scenario.id)}-${esc(engine)}">` +
              statusChip("fail", cat) +
              `</a></td>`
            );
          }
          return `<td class="mx-cell">${statusChip(status)}</td>`;
        })
        .join("");
      return `<tr>${nameCell}${cells}</tr>`;
    })
    .join("");
  const headCols = engines.map((e) => `<th class="mx-eng">${esc(SERIES[e].label)}</th>`).join("");
  return (
    `<div class="table-wrap"><table class="matrix"><thead><tr>` +
    `<th class="mx-scn-h">Scenario</th>${headCols}</tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
}

const GROUP_SECTIONS = [
  { key: "core", title: "Core" },
  { key: "compound", title: "Compound — obstacles co-occur" },
  { key: "survival", title: "Survival — frozen engines vs accumulating site drift" }
] as const;

function matrixSection(results: BenchmarkResults): string {
  const engines = requestedEngines(results);
  const body = GROUP_SECTIONS.map((g) => {
    const scenarios = results.scenarios.filter((s) => s.group === g.key);
    if (scenarios.length === 0) return "";
    return `<h3 class="sub-h">${esc(g.title)}</h3>` + matrixTable(results, scenarios, engines);
  }).join("");
  return panel({
    title: "Scenario outcomes",
    subtitle:
      "How each engine handled every seeded failure mode, by track. Failed cells link to detail.",
    body
  });
}

/**
 * The survival curve: engines × site versions, plus the last version each engine
 * clears before the first non-pass. Chips carry an icon + label (never colour
 * alone); the "survived through" column is the headline of the whole track.
 */
function survivalSection(results: BenchmarkResults): string {
  const survival = results.scenarios.filter((s) => s.group === "survival");
  if (survival.length === 0) return "";
  const engines = requestedEngines(results);
  const versions = survival.map((s) => ({
    id: s.id,
    label: s.id.replace(/^site-/, ""),
    name: s.name
  }));

  const headCols = versions
    .map((v) => `<th class="mx-eng" title="${esc(v.name)}">${esc(v.label)}</th>`)
    .join("");
  const rows = engines
    .map((engine) => {
      const cells = versions
        .map((v) => `<td class="mx-cell">${statusChip(comparisonCell(results, v.id, engine))}</td>`)
        .join("");
      const engineCell =
        `<td class="mx-scn"><span class="mx-eng-name" style="--accent:${SERIES[engine].color}">` +
        `${esc(SERIES[engine].label)}</span></td>`;
      return `<tr>${engineCell}${cells}<td class="mx-cell mx-through">${esc(
        survivedThrough(results, engine, versions)
      )}</td></tr>`;
    })
    .join("");

  return panel({
    title: "Survival curve",
    subtitle:
      "One site drifting across versions, graded against engines frozen as written. Where an engine stops is where its selectors met the change.",
    body:
      `<div class="table-wrap"><table class="matrix"><thead><tr>` +
      `<th class="mx-scn-h">Engine</th>${headCols}<th class="mx-eng">Survived through</th>` +
      `</tr></thead><tbody>${rows}</tbody></table></div>`
  });
}

/** The last consecutive site version an engine passed, or "none" / "not run". */
function survivedThrough(
  results: BenchmarkResults,
  engine: EngineName,
  versions: Array<{ id: string; label: string }>
): string {
  const statuses = versions.map((v) => comparisonCell(results, v.id, engine));
  if (statuses.every((s) => s === "skipped")) return "not run";
  let last = "none";
  for (let i = 0; i < versions.length; i++) {
    if (statuses[i] !== "pass") break;
    last = versions[i]!.label;
  }
  return last;
}

function chartsSection(results: BenchmarkResults): string {
  const active = activeEngines(results);
  const series = active.map((e) => SERIES[e]);
  const showLegend = series.length >= 2;
  const oneEngineNote =
    series.length === 1 ? ` Only ${series[0]!.label} produced trials this run.` : "";

  if (active.length === 0) {
    return panel({
      title: "Charts",
      subtitle: "Per-scenario reliability.",
      body: emptyState("No engine produced trials.", "pnpm bench")
    });
  }

  // (a) Mean duration per scenario (seconds).
  const durRows: BarRow[] = results.scenarios.map((sc) => ({
    key: sc.id,
    label: sc.id,
    values: active.map((e) => {
      const ts = trialsFor(results, sc.id, e);
      const m = mean(ts.map((t) => t.durationMs));
      return { seriesKey: e, value: m === null ? null : m / 1000 };
    })
  }));
  const durMax = Math.max(
    0.001,
    ...durRows.flatMap((r) => r.values.map((v) => v.value ?? 0))
  );
  const durTicks = niceTicks(durMax, 4);
  const durChart =
    (showLegend ? legend(series) : "") +
    groupedHBarChart({
      rows: durRows,
      series,
      axisMax: durTicks.max,
      ticks: durTicks.ticks,
      fmtValue: (v) => `${v.toFixed(2)}s`,
      fmtTick: (v) => `${v}s`,
      ariaLabel: "Mean duration per scenario, in seconds"
    });

  // (b) Extraction accuracy per scenario (0–100%).
  const accRows: BarRow[] = results.scenarios.map((sc) => ({
    key: sc.id,
    label: sc.id,
    values: active.map((e) => {
      const ts = trialsFor(results, sc.id, e);
      const scores = ts
        .map((t) => t.accuracy?.overall)
        .filter((n): n is number => typeof n === "number");
      const m = mean(scores);
      return { seriesKey: e, value: m === null ? null : m * 100 };
    })
  }));
  const accChart =
    (showLegend ? legend(series) : "") +
    groupedHBarChart({
      rows: accRows,
      series,
      axisMax: 100,
      ticks: [0, 25, 50, 75, 100],
      fmtValue: (v) => `${v.toFixed(0)}%`,
      fmtTick: (v) => `${v}%`,
      ariaLabel: "Extraction accuracy per scenario, in percent"
    });

  // (c) Failures by category, per engine.
  const cats = FAILURE_CATEGORIES.filter((c) =>
    active.some((e) => (summaryOf(results, e)?.failuresByCategory[c] ?? 0) > 0)
  );
  let failChart: string;
  if (cats.length === 0) {
    failChart = `<div class="empty"><p>No failures recorded — every trial met its expected outcome.</p></div>`;
  } else {
    const failRows: BarRow[] = cats.map((c) => ({
      key: c,
      label: c,
      values: active.map((e) => ({
        seriesKey: e,
        value: summaryOf(results, e)?.failuresByCategory[c] ?? 0
      }))
    }));
    const failMax = Math.max(
      1,
      ...failRows.flatMap((r) => r.values.map((v) => v.value ?? 0))
    );
    const failTicks = niceTicks(failMax, Math.min(4, failMax));
    failChart =
      (showLegend ? legend(series) : "") +
      groupedHBarChart({
        rows: failRows,
        series,
        axisMax: failTicks.max,
        ticks: failTicks.ticks,
        fmtValue: (v) => `${v}`,
        fmtTick: (v) => `${v}`,
        ariaLabel: "Failure count by category, per engine"
      });
  }

  const sub = (base: string): string => base + oneEngineNote;
  return (
    panel({
      title: "Mean duration per scenario",
      subtitle: sub("Wall-clock time for the full extract pipeline, in seconds."),
      body: `<div class="chart-body">${durChart}</div>`
    }) +
    panel({
      title: "Extraction accuracy per scenario",
      subtitle: sub("Field-level accuracy vs the lab's seeded ground truth (0–100%)."),
      body: `<div class="chart-body">${accChart}</div>`
    }) +
    panel({
      title: "Failures by category",
      subtitle: sub("Where each engine broke, grouped by failure category."),
      body: `<div class="chart-body">${failChart}</div>`
    })
  );
}

function failuresSection(data: DashboardData, imgSrc: (r: ScreenshotRef) => string): string {
  const bench = data.bench;
  if (!bench) return "";
  if (bench.failures.length === 0) {
    return panel({
      title: "Failure details",
      subtitle: "Every failed trial, with category, detail, and artifacts.",
      body: `<div class="empty"><p>No failures — every trial met its expected outcome.</p></div>`
    });
  }
  const items = bench.failures
    .map((f) => {
      const t = f.trial;
      const cat = t.failureCategory ?? "failure";
      const shots = f.screenshots
        .map(
          (s) =>
            `<a class="shot" href="${esc(imgSrc(s))}" target="_blank" rel="noopener">` +
            `<img src="${esc(imgSrc(s))}" alt="${esc(`${t.scenarioId} ${s.label} screenshot`)}" loading="lazy" />` +
            `<span class="shot-cap">${esc(s.name)}</span></a>`
        )
        .join("");
      const links: string[] = [];
      if (f.eventsUrl) {
        links.push(`<a class="lnk" href="${esc(f.eventsUrl)}" target="_blank" rel="noopener">events.jsonl</a>`);
      }
      return (
        `<article class="fail-item" id="fail-${esc(t.scenarioId)}-${esc(t.engine)}">` +
        `<div class="fail-head">` +
        `<span class="fail-scn">${esc(f.scenario?.name ?? t.scenarioId)}</span>` +
        `<span class="fail-eng" style="--accent:${SERIES[t.engine].color}">${esc(SERIES[t.engine].label)}</span>` +
        statusChip("fail", cat) +
        outcomeClassChip(t.outcomeClass) +
        `</div>` +
        (t.failureDetail
          ? `<pre class="mono fail-detail">${esc(t.failureDetail)}</pre>`
          : "") +
        `<p class="fail-reason">${esc(t.outcomeReason)}</p>` +
        (links.length ? `<div class="fail-links">${links.join("")}</div>` : "") +
        (shots ? `<div class="gallery">${shots}</div>` : "") +
        `</article>`
      );
    })
    .join("");
  return panel({
    title: "Failure details",
    subtitle: "Every failed trial, with category, detail, and artifacts.",
    body: `<div class="fail-list">${items}</div>`
  });
}

function stepPill(step: { name: string; status: string }): string {
  const glyph: Record<string, string> = { passed: "✓", failed: "✕", recovered: "↻", skipped: "—" };
  const cls: Record<string, string> = {
    passed: "sp-pass",
    failed: "sp-fail",
    recovered: "sp-rec",
    skipped: "sp-skip"
  };
  return (
    `<span class="step ${cls[step.status] ?? "sp-skip"}">` +
    `<span class="ic" aria-hidden="true">${glyph[step.status] ?? "•"}</span>${esc(step.name)}</span>`
  );
}

function confidenceChip(label: string): string {
  const cls =
    label === "high" ? "cf-high" : label === "medium" ? "cf-med" : "cf-low";
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

function watchlistTable(selections: ValueSelection[]): string {
  const rows = selections
    .map((s, i) => {
      const edgeCls = s.edge >= 0 ? "edge-good" : "edge-bad";
      const edgeGlyph = s.edge >= 0 ? "▲" : "▼";
      return (
        `<tr>` +
        `<td class="num">${i + 1}</td>` +
        `<td>${esc(s.fixture)}</td>` +
        `<td>${esc(s.label)}</td>` +
        `<td class="num">${s.decimalOdds.toFixed(2)}</td>` +
        `<td class="num">${pct(s.modelProbability)}</td>` +
        `<td class="num">${pct(s.impliedNoVig)}</td>` +
        `<td class="num ${edgeCls}"><span class="ic" aria-hidden="true">${edgeGlyph}</span> ${esc(signedPct(s.edge))}</td>` +
        `<td class="num">${s.expectedValuePerUnit.toFixed(3)}</td>` +
        `<td>${confidenceChip(s.confidence)}</td>` +
        `</tr>`
      );
    })
    .join("");
  return (
    `<div class="table-wrap"><table class="watch"><thead><tr>` +
    `<th class="num">#</th><th>Fixture</th><th>Selection</th>` +
    `<th class="num">Odds</th><th class="num">Model %</th><th class="num">Implied %</th>` +
    `<th class="num">Edge</th><th class="num">EV/unit</th><th>Conf.</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>`
  );
}

function agentSection(data: DashboardData, imgSrc: (r: ScreenshotRef) => string): string {
  const agent = data.agent;
  if (!agent) {
    return panel({
      title: "Latest agent run",
      subtitle: "A single extraction pipeline plus the value watchlist it produced.",
      body: emptyState("No agent run recorded yet.", "pnpm agent:local")
    });
  }
  const { manifest, result, watchlist } = agent;
  const engine = (result?.engine ?? manifest.engine ?? "baseline") as EngineName;
  const meta: string[] = [];
  meta.push(`<div class="meta"><span class="meta-k">engine</span><span class="meta-v" style="--accent:${SERIES[engine].color}">${esc(SERIES[engine].label)}</span></div>`);
  meta.push(`<div class="meta"><span class="meta-k">when</span><span class="meta-v">${esc(when(manifest.createdAt))}</span></div>`);
  if (result) {
    meta.push(`<div class="meta"><span class="meta-k">duration</span><span class="meta-v num">${esc(secs(result.durationMs, 2))}</span></div>`);
    meta.push(`<div class="meta"><span class="meta-k">outcome</span><span class="meta-v">${statusChip(result.success ? "pass" : "fail")}</span></div>`);
  }
  if (result?.tokens) {
    const tk = result.tokens;
    const parts = [`${tk.llmCalls} calls`];
    if (tk.inputTokens !== undefined) parts.push(`${tk.inputTokens} in`);
    if (tk.outputTokens !== undefined) parts.push(`${tk.outputTokens} out`);
    if (tk.estimatedCostUsd !== undefined) parts.push(`$${tk.estimatedCostUsd.toFixed(4)}`);
    meta.push(`<div class="meta"><span class="meta-k">llm usage</span><span class="meta-v num">${esc(parts.join(" · "))}</span></div>`);
  }
  const metaRow = `<div class="meta-row">${meta.join("")}</div>`;
  const steps = result
    ? `<div class="steps">${result.steps.map(stepPill).join("")}</div>`
    : "";

  // Watchlist.
  let watchBody: string;
  if (!watchlist) {
    watchBody = `<div class="empty"><p>No watchlist for this run (the pipeline did not produce a clean dataset).</p></div>`;
  } else {
    const picks = watchlist.selections;
    const confReasons = watchlist.datasetConfidence.reasons;
    const confLine =
      `<div class="conf-line">Dataset confidence: ${confidenceChip(watchlist.datasetConfidence.label)}` +
      (confReasons.length
        ? ` <span class="conf-reasons">${esc(confReasons.join("; "))}</span>`
        : "") +
      `</div>`;
    const table =
      picks.length > 0
        ? watchlistTable(picks)
        : `<div class="empty"><p>No selection cleared the 2% edge threshold — bookmaker margin swallowed the modelled edges.</p></div>`;
    const limitations = watchlist.limitations.length
      ? `<ul class="limits">` +
        watchlist.limitations.map((l) => `<li>${esc(l)}</li>`).join("") +
        `</ul>`
      : "";
    watchBody =
      `<h3 class="sub-h">Value watchlist</h3>` +
      confLine +
      table +
      (limitations ? `<h3 class="sub-h">Model limitations</h3>${limitations}` : "");
  }

  // Screenshots.
  const gallery = agent.screenshots.length
    ? `<h3 class="sub-h">Screenshots</h3><div class="gallery">` +
      agent.screenshots
        .map(
          (s) =>
            `<a class="shot" href="${esc(imgSrc(s))}" target="_blank" rel="noopener">` +
            `<img src="${esc(imgSrc(s))}" alt="${esc(`${s.label} screenshot`)}" loading="lazy" />` +
            `<span class="shot-cap">${esc(s.label || s.name)}</span></a>`
        )
        .join("") +
      `</div>`
    : "";

  return panel({
    title: "Latest agent run",
    subtitle: "A single extraction pipeline plus the value watchlist it produced.",
    body: metaRow + steps + watchBody + gallery
  });
}

function footerSection(data: DashboardData): string {
  const env = data.bench?.results.environment;
  const items: string[] = [];
  items.push(`node ${esc(env?.node ?? process.version)}`);
  items.push(`stagehand ${esc(env?.stagehandVersion ?? "n/a")}`);
  items.push(`model ${esc(env?.stagehandModel ?? "n/a")}`);
  items.push(`provider ${esc(env?.modelProvider ?? "none")}`);
  items.push(`browserbase ${env?.browserbase ? "on" : "off"}`);
  return (
    `<footer class="foot">` +
    `<div class="foot-env">${items.map((i) => `<span>${i}</span>`).join("")}</div>` +
    `<div class="foot-gen">generated ${esc(when(data.generatedAt))}</div>` +
    `<div class="foot-disc">${esc(DISCLAIMER)}. Not betting advice.</div>` +
    `</footer>`
  );
}

// ── Data island (machine-readable twin, parsed by the interactivity script) ──
function buildIsland(data: DashboardData): unknown {
  const bench = data.bench;
  return {
    generatedAt: data.generatedAt,
    bench: bench
      ? {
          benchId: bench.results.benchId,
          createdAt: bench.results.createdAt,
          modelProvider: bench.results.environment.modelProvider,
          activeEngines: activeEngines(bench.results),
          engines: bench.results.engines.map((e) => ({
            engine: e.engine,
            trials: e.trials,
            taskSuccessRate: e.taskSuccessRate,
            meanAccuracy: e.meanAccuracy,
            meanDurationMs: e.meanDurationMs,
            healedTrials: e.healedTrials ?? null,
            outcomeClasses: e.outcomeClasses,
            silentCorruptionRate: e.silentCorruptionRate
          })),
          failureCount: bench.failures.length
        }
      : null,
    agent: data.agent
      ? {
          runId: data.agent.manifest.runId,
          engine: data.agent.manifest.engine ?? data.agent.result?.engine ?? null,
          selections: data.agent.watchlist?.selections.length ?? 0
        }
      : null
  };
}

// The interactivity layer: one HTML tooltip driven by data-* attributes on the
// SVG hit rects. Labels are inserted with textContent (untrusted data).
const SCRIPT = `(function(){
  try { window.__dashData = JSON.parse(document.getElementById("dash-data").textContent); } catch (e) {}
  var tt = document.getElementById("tt");
  if (!tt) return;
  function show(el, x, y){
    tt.textContent = "";
    var val = document.createElement("div");
    val.className = "tt-val";
    val.textContent = el.getAttribute("data-value");
    var row = document.createElement("div");
    row.className = "tt-cat";
    var key = document.createElement("span");
    key.className = "tt-key";
    key.style.background = el.getAttribute("data-color");
    var name = document.createElement("span");
    name.textContent = el.getAttribute("data-series") + " · " + el.getAttribute("data-cat");
    row.appendChild(key); row.appendChild(name);
    tt.appendChild(val); tt.appendChild(row);
    tt.hidden = false;
    var r = tt.getBoundingClientRect(), pad = 12;
    var left = x + pad, top = y + pad;
    if (left + r.width > window.innerWidth) left = x - r.width - pad;
    if (top + r.height > window.innerHeight) top = y - r.height - pad;
    tt.style.left = Math.max(4, left) + "px";
    tt.style.top = Math.max(4, top) + "px";
  }
  function hide(){ tt.hidden = true; }
  document.addEventListener("pointermove", function(e){
    var el = e.target && e.target.closest ? e.target.closest("[data-tt]") : null;
    if (el) show(el, e.clientX, e.clientY);
    else if (!tt.hidden) hide();
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-tt]"), function(el){
    el.addEventListener("focus", function(){
      var r = el.getBoundingClientRect();
      show(el, r.left + Math.min(r.width, 160), r.top + r.height / 2);
    });
    el.addEventListener("blur", hide);
  });
})();`;

function styles(): string {
  return `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: ${TOK.page}; color: ${TOK.ink};
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .num { font-variant-numeric: tabular-nums; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.92em;
    background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px; }
  a { color: ${TOK.stagehand}; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 40px 28px 64px; }

  .head { display: flex; align-items: flex-start; justify-content: space-between;
    gap: 20px; flex-wrap: wrap; margin-bottom: 32px; }
  .head h1 { font-size: 26px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { color: ${TOK.ink2}; margin: 0; max-width: 640px; }
  .badge { color: ${TOK.ink2}; font-size: 12px; border: 1px solid ${TOK.border};
    border-radius: 999px; padding: 6px 12px; white-space: nowrap; background: ${TOK.surface}; }

  .panel { background: ${TOK.surface}; border: 1px solid ${TOK.border};
    border-radius: 12px; padding: 22px 24px; margin-bottom: 20px; }
  .panel-title { font-size: 16px; font-weight: 600; margin: 0 0 3px; }
  .panel-sub { color: ${TOK.muted}; font-size: 12.5px; margin: 0 0 18px; }
  .sub-h { font-size: 13px; font-weight: 600; color: ${TOK.ink2}; margin: 22px 0 10px;
    text-transform: uppercase; letter-spacing: 0.04em; }

  /* Stat tiles */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  .tile { border: 1px solid ${TOK.border}; border-left: 3px solid var(--accent);
    border-radius: 10px; padding: 16px 18px; background: rgba(255,255,255,0.015); }
  .tile-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .tile-name { font-weight: 600; font-size: 15px; }
  .tile-metrics { display: flex; flex-direction: column; gap: 8px; }
  .metric { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .m-lbl { color: ${TOK.muted}; font-size: 12.5px; }
  .m-val { font-size: 15px; font-weight: 600; }
  .tile-foot { color: ${TOK.muted}; font-size: 11.5px; margin: 12px 0 0; }
  .tile-skip { color: ${TOK.ink2}; font-size: 13px; margin: 0 0 6px; }
  .tile-skip-why { color: ${TOK.muted}; font-size: 11.5px; margin: 0; }
  .tile-classes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .tile-scr { display: flex; align-items: baseline; gap: 6px; color: ${TOK.ink2};
    font-size: 11.5px; margin: 8px 0 0; font-variant-numeric: tabular-nums; }
  .tile-scr .ic { font-size: 11px; line-height: 1; }
  .sc-hot { color: ${TOK.fail}; }
  .sc-cold { color: ${TOK.muted}; }

  /* Chips + tags */
  .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
    font-weight: 550; padding: 2px 8px; border-radius: 6px; white-space: nowrap;
    background: rgba(255,255,255,0.04); border: 1px solid ${TOK.border}; }
  .chip .ic { font-size: 11px; line-height: 1; }
  .chip-extra { color: ${TOK.muted}; font-weight: 400; }
  .st-pass { color: ${TOK.pass}; }
  .st-fail { color: ${TOK.fail}; }
  .st-skip { color: ${TOK.muted}; }
  .st-warn { color: ${TOK.warning}; }
  .st-rec { color: ${TOK.warning}; }
  .st-corrupt { color: ${TOK.fail}; }
  .cf-high { color: ${TOK.pass}; }
  .cf-med { color: ${TOK.warning}; }
  .cf-low { color: ${TOK.fail}; }
  .tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
  .tag { font-size: 10.5px; padding: 1px 7px; border-radius: 5px; color: ${TOK.muted};
    background: rgba(255,255,255,0.04); border: 1px solid ${TOK.border}; }
  .tag-chaos { color: ${TOK.warning}; }
  .tag-exp { color: ${TOK.ink2}; }
  .tag-session { color: ${TOK.stagehand}; }

  /* Tables */
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  thead th { text-align: left; color: ${TOK.muted}; font-weight: 500; font-size: 11.5px;
    text-transform: uppercase; letter-spacing: 0.04em; padding: 0 12px 10px;
    border-bottom: 1px solid ${TOK.axis}; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody td { padding: 11px 12px; border-bottom: 1px solid ${TOK.grid}; vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }

  .matrix .mx-scn-h { width: 46%; }
  .mx-eng { text-align: center; }
  .mx-scn { }
  .mx-name { font-weight: 550; }
  .mx-id { color: ${TOK.muted}; font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
  .mx-cell { text-align: center; }
  .mx-link { text-decoration: none; }
  .mx-link:hover { text-decoration: none; opacity: 0.85; }
  .mx-eng-name { font-weight: 550; border-left: 3px solid var(--accent); padding-left: 7px; }
  .mx-through { font-weight: 650; font-variant-numeric: tabular-nums; color: ${TOK.ink2}; }

  /* Charts */
  .chart-body { }
  .chart { display: block; }
  .chart .ax-lbl { fill: ${TOK.muted}; font-size: 11px; }
  .chart .ax-tick { fill: ${TOK.muted}; font-size: 10px; font-variant-numeric: tabular-nums; }
  .chart .val { fill: ${TOK.ink2}; font-size: 11px; font-variant-numeric: tabular-nums; }
  .chart .val-na { fill: ${TOK.muted}; font-size: 11px; font-style: italic; }
  .chart .hit { fill: transparent; outline: none; cursor: default; }
  .chart .hit:hover, .chart .hit:focus { fill: rgba(255,255,255,0.06); }
  .legend { display: flex; gap: 16px; margin-bottom: 10px; }
  .lg { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: ${TOK.ink2}; }
  .lg-key { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }

  /* Failures */
  .fail-list { display: flex; flex-direction: column; gap: 16px; }
  .fail-item { border: 1px solid ${TOK.border}; border-radius: 10px; padding: 16px 18px;
    background: rgba(255,255,255,0.015); scroll-margin-top: 16px; }
  .fail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .fail-scn { font-weight: 600; font-size: 14px; }
  .fail-eng { font-size: 12px; color: ${TOK.ink2}; border-left: 3px solid var(--accent);
    padding-left: 7px; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .fail-detail { font-size: 12px; color: ${TOK.ink2}; background: ${TOK.page};
    border: 1px solid ${TOK.border}; border-radius: 8px; padding: 11px 13px;
    white-space: pre-wrap; word-break: break-word; margin: 0 0 10px; overflow-x: auto; }
  .fail-reason { color: ${TOK.muted}; font-size: 12.5px; margin: 0 0 10px; }
  .fail-links { display: flex; gap: 14px; font-size: 12.5px; margin-bottom: 10px; }
  .lnk { color: ${TOK.stagehand}; }

  /* Galleries */
  .gallery { display: flex; flex-wrap: wrap; gap: 12px; }
  .shot { display: block; border: 1px solid ${TOK.border}; border-radius: 8px;
    overflow: hidden; background: ${TOK.page}; width: 200px; }
  .shot img { display: block; width: 100%; height: auto; }
  .shot-cap { display: block; color: ${TOK.muted}; font-size: 11px; padding: 6px 8px;
    border-top: 1px solid ${TOK.border}; }
  .shot:hover { border-color: rgba(255,255,255,0.25); text-decoration: none; }

  /* Agent meta */
  .meta-row { display: flex; flex-wrap: wrap; gap: 26px; margin-bottom: 16px; }
  .meta { display: flex; flex-direction: column; gap: 3px; }
  .meta-k { color: ${TOK.muted}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .meta-v { font-size: 14px; font-weight: 550; }
  .meta-v[style*="accent"] { border-left: 3px solid var(--accent); padding-left: 7px; }
  .steps { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .step { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px;
    padding: 3px 9px; border-radius: 6px; background: rgba(255,255,255,0.04);
    border: 1px solid ${TOK.border}; color: ${TOK.ink2}; }
  .step .ic { font-size: 10px; }
  .sp-pass .ic { color: ${TOK.pass}; }
  .sp-fail .ic { color: ${TOK.fail}; }
  .sp-rec .ic { color: ${TOK.warning}; }
  .sp-skip .ic { color: ${TOK.muted}; }

  /* Watchlist */
  .conf-line { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 13px; }
  .conf-reasons { color: ${TOK.muted}; font-size: 12px; }
  .edge-good { color: ${TOK.pass}; }
  .edge-bad { color: ${TOK.fail}; }
  .limits { color: ${TOK.muted}; font-size: 12px; margin: 0; padding-left: 18px; }
  .limits li { margin-bottom: 4px; }

  /* Empty states */
  .empty { border: 1px dashed ${TOK.axis}; border-radius: 10px; padding: 22px;
    text-align: center; color: ${TOK.ink2}; }
  .empty p { margin: 0 0 6px; }
  .empty-cmd { color: ${TOK.muted}; font-size: 12.5px; }

  /* Footer */
  .foot { border-top: 1px solid ${TOK.border}; margin-top: 36px; padding-top: 20px;
    color: ${TOK.muted}; font-size: 12px; }
  .foot-env { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 8px; }
  .foot-env span { font-variant-numeric: tabular-nums; }
  .foot-gen { margin-bottom: 6px; }
  .foot-disc { color: ${TOK.ink2}; }

  /* Tooltip */
  .tt { position: fixed; z-index: 50; pointer-events: none; background: #000;
    border: 1px solid ${TOK.border}; border-radius: 8px; padding: 8px 11px;
    font-size: 12px; box-shadow: 0 6px 20px rgba(0,0,0,0.5); max-width: 260px; }
  .tt-val { font-weight: 650; font-size: 14px; color: ${TOK.ink}; font-variant-numeric: tabular-nums; }
  .tt-cat { display: flex; align-items: center; gap: 6px; color: ${TOK.ink2}; margin-top: 3px; }
  .tt-key { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
  `;
}

export function renderDashboardHtml(
  data: DashboardData,
  opts: { embedAssets: boolean }
): string {
  const imgSrc = makeImgSrc(opts.embedAssets);
  const bench = data.bench;

  const benchBody = bench
    ? tilesSection(bench.results) +
      matrixSection(bench.results) +
      survivalSection(bench.results) +
      chartsSection(bench.results) +
      failuresSection(data, imgSrc)
    : panel({
        title: "Reliability benchmark",
        subtitle: "Per-engine, per-scenario reliability results.",
        body: emptyState("No benchmark results in runs/latest yet.", "pnpm bench")
      });

  const island = jsonForScript(buildIsland(data));

  return (
    "<!doctype html>" +
    '<html lang="en"><head>' +
    '<meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    "<title>Stateful Sports Data Agent — Dashboard</title>" +
    `<style>${styles()}</style>` +
    "</head><body>" +
    '<div class="wrap">' +
    headerSection() +
    benchBody +
    agentSection(data, imgSrc) +
    footerSection(data) +
    "</div>" +
    '<div id="tt" class="tt" hidden></div>' +
    `<script type="application/json" id="dash-data">${island}</script>` +
    `<script>${SCRIPT}</script>` +
    "</body></html>"
  );
}
