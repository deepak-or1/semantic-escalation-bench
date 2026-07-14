import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBenchmark } from "@ssda/agent";
import {
  BenchmarkResultsSchema,
  SCENARIOS,
  createRunDir,
  runsRoot,
  scenarioById,
  type BenchmarkResults,
  type ScenarioSpec
} from "@ssda/shared";
import { fileExists, startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * End-to-end reliability benchmark over three representative scenarios. With no
 * model key present the stagehand engine is reported as skipped and only the
 * baseline runs; we assert the written artifacts (results.json/.md,
 * failures.jsonl) and the runs/latest mirror all match the expected outcomes.
 */

const SCENARIO_IDS = ["clean-extraction", "class-drift", "schema-violation"];
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

let lab: Lab;
let tempRunsDir: string;
let prevRunsDir: string | undefined;
let benchDir: string;
let results: BenchmarkResults;

beforeAll(async () => {
  prevRunsDir = process.env.SSDA_RUNS_DIR;
  tempRunsDir = await tmpDir("ssda-runs-");
  process.env.SSDA_RUNS_DIR = tempRunsDir;

  lab = await startLab();

  const scenarios: ScenarioSpec[] = SCENARIO_IDS.map((id) => {
    const scenario = scenarioById(id);
    if (!scenario) throw new Error(`unknown scenario ${id}`);
    return scenario;
  });

  const { dir, runId } = await createRunDir({ kind: "bench", labUrl: lab.url });
  benchDir = dir;
  results = await runBenchmark({
    labUrl: lab.url,
    engines: ["stagehand", "baseline"],
    scenarios,
    trialsPerScenario: 1,
    headless: true,
    benchDir: dir,
    benchId: runId
  });
});

afterAll(async () => {
  await stopLab(lab);
  if (prevRunsDir === undefined) delete process.env.SSDA_RUNS_DIR;
  else process.env.SSDA_RUNS_DIR = prevRunsDir;
});

describe("runBenchmark over three scenarios (baseline only, no model key)", () => {
  it("returns results that parse under BenchmarkResultsSchema", () => {
    expect(BenchmarkResultsSchema.safeParse(results).success).toBe(true);
  });

  it("writes a results.json that parses under BenchmarkResultsSchema", async () => {
    const raw: unknown = JSON.parse(
      await readFile(path.join(benchDir, "results.json"), "utf8")
    );
    expect(BenchmarkResultsSchema.safeParse(raw).success).toBe(true);
  });

  it("reports stagehand as skipped with zero trials", () => {
    const stagehand = results.engines.find((e) => e.engine === "stagehand");
    expect(stagehand).toBeDefined();
    expect(stagehand!.trials).toBe(0);
    if (hasKey) {
      // A key is present, so stagehand actually ran — the skip assertion below
      // does not apply in this environment.
      return;
    }
    expect(stagehand!.skippedReason).toBeDefined();
    expect(stagehand!.skippedReason!.toLowerCase()).toContain("key");
  });

  it("baseline comparison matches the expected per-scenario outcomes", () => {
    const cell = (id: string): string | undefined =>
      results.comparison.find((c) => c.scenarioId === id)?.results.baseline;
    expect(cell("clean-extraction")).toBe("pass");
    expect(cell("class-drift")).toBe("fail");
    expect(cell("schema-violation")).toBe("pass");
  });

  it("classifies baseline behaviour orthogonally to the judged outcome", () => {
    const baseline = results.trials.filter((t) => t.engine === "baseline");
    const byId = (id: string) => baseline.find((t) => t.scenarioId === id)!;
    expect(byId("clean-extraction").outcomeClass).toBe("pass");
    expect(byId("class-drift").outcomeClass).toBe("hard-failure");
    // schema-violation is JUDGED pass (clean validation-failure) yet CLASSED a
    // safe-failure — the two dimensions are deliberately orthogonal.
    expect(byId("schema-violation").outcome).toBe("pass");
    expect(byId("schema-violation").outcomeClass).toBe("safe-failure");
  });

  it("summarises baseline outcome classes with a zero silent-corruption rate", () => {
    const baseline = results.engines.find((e) => e.engine === "baseline")!;
    expect(baseline.outcomeClasses.pass ?? 0).toBeGreaterThanOrEqual(1);
    expect(baseline.outcomeClasses["safe-failure"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(baseline.outcomeClasses["hard-failure"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(baseline.silentCorruptionRate).toBe(0);
  });

  it("records modelProvider on the environment (null when no key is set)", () => {
    if (hasKey) {
      expect(results.environment.modelProvider).not.toBeNull();
    } else {
      expect(results.environment.modelProvider).toBeNull();
    }
  });

  it("records reproducibility provenance on the environment (8j)", () => {
    const env = results.environment;
    expect(env.disableRepair).toBe(false);
    expect(env.seedCacheMode).toBe("none");
    expect(env.seedCacheHash).toBeNull();
    expect(typeof env.promptsHash).toBe("string");
    expect(env.promptsHash.length).toBeGreaterThan(0);
    expect(typeof env.lockfileHash).toBe("string");
    expect(env.lockfileHash.length).toBeGreaterThan(0);
    // gitCommit is a string or null; gitDirty is a boolean or null.
    expect(env.gitCommit === null || typeof env.gitCommit === "string").toBe(true);
    expect(env.gitDirty === null || typeof env.gitDirty === "boolean").toBe(true);
  });

  it("failures.jsonl records exactly the class-drift baseline trial", async () => {
    const text = await readFile(path.join(benchDir, "failures.jsonl"), "utf8");
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const entries = lines.map(
      (line) => JSON.parse(line) as { scenarioId: string; engine: string }
    );
    const classDrift = entries.find(
      (e) => e.scenarioId === "class-drift" && e.engine === "baseline"
    );
    expect(classDrift).toBeDefined();
    if (!hasKey) expect(lines).toHaveLength(1);
  });

  it("writes a results.md that mentions class-drift", async () => {
    expect(await fileExists(path.join(benchDir, "results.md"))).toBe(true);
    const md = await readFile(path.join(benchDir, "results.md"), "utf8");
    expect(md).toContain("class-drift");
  });

  it("mirrors the run to runs/latest under the temp runs root", async () => {
    const latest = path.join(runsRoot(), "latest");
    expect(latest.startsWith(tempRunsDir)).toBe(true);
    expect(await fileExists(latest)).toBe(true);
    expect(await fileExists(path.join(latest, "results.json"))).toBe(true);
  });
});

describe("scenario catalog", () => {
  it("has 24 scenarios grouped 17 core / 4 compound / 3 survival", () => {
    expect(SCENARIOS).toHaveLength(24);
    const counts = SCENARIOS.reduce<Record<string, number>>((acc, s) => {
      acc[s.group] = (acc[s.group] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ core: 17, compound: 4, survival: 3 });
  });
});
