import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  BenchmarkResultsSchema,
  PipelineResultSchema,
  RunEventSchema,
  listRunManifests,
  readJsonOr,
  readJsonl,
  runsRoot,
  type BenchmarkResults,
  type PipelineResult,
  type RunEvent,
  type RunManifest,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import { WatchlistSchema, type Watchlist } from "./watchlist";

/**
 * The dashboard's read-only view over runs/. Everything is parsed defensively
 * with the shared zod schemas; anything missing or malformed collapses to a
 * typed null so a partial runs/ directory still renders (with empty states).
 */

/** A screenshot on disk, addressable both by data-URI embed and by served URL. */
export interface ScreenshotRef {
  /** File basename, e.g. "stats-a1.png". */
  name: string;
  /** Absolute path on disk (used to inline as base64 when embedding). */
  absPath: string;
  /** Served path under the dashboard ("/runs/…"), or null if outside runsRoot. */
  url: string | null;
  /** Short kind derived from the filename: "stats" | "odds" | "failure" | "". */
  label: string;
  sizeBytes: number;
}

/** One failed benchmark trial with the extra context the detail panel shows. */
export interface FailureTrial {
  trial: TrialResult;
  scenario: ScenarioSpec | null;
  /** Served path to the trial's events.jsonl, or null. */
  eventsUrl: string | null;
  screenshots: ScreenshotRef[];
}

export interface DashboardBench {
  results: BenchmarkResults;
  /** True when loaded from the SSDA_DASHBOARD_FIXTURE dev override. */
  isFixture: boolean;
  /** Failed trials, in scenario order, with detail context. */
  failures: FailureTrial[];
}

export interface DashboardAgent {
  manifest: RunManifest;
  result: PipelineResult | null;
  watchlist: Watchlist | null;
  events: RunEvent[];
  screenshots: ScreenshotRef[];
}

export interface DashboardData {
  generatedAt: string;
  bench: DashboardBench | null;
  agent: DashboardAgent | null;
}

/** Map a filename to the short label the gallery uses to caption it. */
function labelFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.startsWith("stats")) return "stats";
  if (lower.startsWith("odds")) return "odds";
  if (lower.startsWith("failure")) return "failure";
  return "";
}

/**
 * Served URL for an absolute path, if it lives under runsRoot. Root-relative
 * ("/runs/…"), never an external reference, so the report stays self-contained.
 */
function toRunsUrl(absPath: string): string | null {
  const root = runsRoot();
  const rel = path.relative(root, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return "/runs/" + rel.split(path.sep).join("/");
}

/** List the .png screenshots in a directory as ScreenshotRefs (sorted). */
async function readScreenshots(dir: string): Promise<ScreenshotRef[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith(".png"));
  } catch {
    return [];
  }
  names.sort();
  const refs: ScreenshotRef[] = [];
  for (const name of names) {
    const absPath = path.join(dir, name);
    let sizeBytes = 0;
    try {
      sizeBytes = (await stat(absPath)).size;
    } catch {
      continue;
    }
    refs.push({ name, absPath, url: toRunsUrl(absPath), label: labelFor(name), sizeBytes });
  }
  return refs;
}

/** Directory the benchmark results are read from (latest run, or dev fixture). */
function benchDir(env: NodeJS.ProcessEnv): { dir: string; file: string; isFixture: boolean } {
  const fixture = env.SSDA_DASHBOARD_FIXTURE;
  if (fixture) {
    const dir = path.resolve(fixture);
    return { dir, file: path.join(dir, "sample-results.json"), isFixture: true };
  }
  const dir = path.join(runsRoot(env), "latest");
  return { dir, file: path.join(dir, "results.json"), isFixture: false };
}

async function loadBench(env: NodeJS.ProcessEnv): Promise<DashboardBench | null> {
  const { dir, file, isFixture } = benchDir(env);
  const parsed = BenchmarkResultsSchema.safeParse(await readJsonOr(file, null));
  if (!parsed.success) return null;
  const results = parsed.data;

  const scenarioById = new Map(results.scenarios.map((s) => [s.id, s]));
  const failures: FailureTrial[] = [];
  for (const trial of results.trials) {
    if (trial.outcome !== "fail") continue;
    // trialDirName is the basename of artifactsDir; on disk it lives under the
    // bench directory (latest/), not the original absolute path in the record.
    const trialDirName = path.basename(trial.artifactsDir);
    const trialDir = path.join(dir, "trials", trialDirName);
    const eventsAbs = path.join(trialDir, "events.jsonl");
    failures.push({
      trial,
      scenario: scenarioById.get(trial.scenarioId) ?? null,
      eventsUrl: toRunsUrl(eventsAbs),
      screenshots: await readScreenshots(path.join(trialDir, "artifacts"))
    });
  }
  // Keep failures in scenario declaration order for a stable, readable list.
  const order = new Map(results.scenarios.map((s, i) => [s.id, i]));
  failures.sort((a, b) => (order.get(a.trial.scenarioId) ?? 0) - (order.get(b.trial.scenarioId) ?? 0));

  return { results, isFixture, failures };
}

async function loadAgent(): Promise<DashboardAgent | null> {
  const manifests = await listRunManifests();
  const manifest = manifests.find((m) => m.kind === "agent");
  if (!manifest) return null;

  const runDir = path.join(runsRoot(), manifest.runId);
  const resultParsed = PipelineResultSchema.safeParse(
    await readJsonOr(path.join(runDir, "result.json"), null)
  );
  const watchlistParsed = WatchlistSchema.safeParse(
    await readJsonOr(path.join(runDir, "watchlist.json"), null)
  );
  const rawEvents = await readJsonl<unknown>(path.join(runDir, "events.jsonl"));
  const events = rawEvents
    .map((e) => RunEventSchema.safeParse(e))
    .filter((r): r is { success: true; data: RunEvent } => r.success)
    .map((r) => r.data);

  return {
    manifest,
    result: resultParsed.success ? resultParsed.data : null,
    watchlist: watchlistParsed.success ? watchlistParsed.data : null,
    events,
    screenshots: await readScreenshots(path.join(runDir, "artifacts"))
  };
}

/**
 * Load everything the dashboard renders. Set SSDA_DASHBOARD_FIXTURE=<dir> to
 * read a hand-written sample-results.json instead of runs/latest — dev-only,
 * for layout work; it never affects the served /runs assets.
 */
export async function loadDashboardData(
  env: NodeJS.ProcessEnv = process.env
): Promise<DashboardData> {
  const [bench, agent] = await Promise.all([loadBench(env), loadAgent()]);
  return { generatedAt: new Date().toISOString(), bench, agent };
}
