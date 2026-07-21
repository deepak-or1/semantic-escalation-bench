import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBenchmark } from "@ssda/agent";
import {
  BenchmarkResultsSchema,
  createRunDir,
  scenarioById,
  type BenchmarkResults,
  type ScenarioSpec,
  type TrialResult
} from "@ssda/shared";
import { startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * The runner's pre-trial stop hook (PROTOCOL_2A §7). Two built-in scenarios ×
 * baseline × 1 trial = 2 planned trials; a beforeTrial that stops before the 2nd
 * trial must halt the run with exactly 1 completed trial, stamp results.stopped,
 * still write a schema-valid results.json (incomplete campaigns are preserved
 * evidence), and fire afterTrial exactly once with the recorded trial.
 */

const SCENARIO_IDS = ["clean-extraction", "class-drift"];

let lab: Lab;
let tempRunsDir: string;
let prevRunsDir: string | undefined;
let benchDir: string;
let results: BenchmarkResults;
const afterTrialRecords: TrialResult[] = [];

beforeAll(async () => {
  prevRunsDir = process.env.SSDA_RUNS_DIR;
  tempRunsDir = await tmpDir("ssda-runs-stop-");
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
    engines: ["baseline"],
    scenarios,
    trialsPerScenario: 1,
    headless: true,
    benchDir: dir,
    benchId: runId,
    hooks: {
      // completed === 1 means the 2nd trial is about to start → stop before it.
      beforeTrial: async (ctx) =>
        ctx.completed === 1 ? { stop: "test stop before the 2nd trial" } : undefined,
      afterTrial: async (record) => {
        afterTrialRecords.push(record);
      }
    }
  });
});

afterAll(async () => {
  await stopLab(lab);
  if (prevRunsDir === undefined) delete process.env.SSDA_RUNS_DIR;
  else process.env.SSDA_RUNS_DIR = prevRunsDir;
});

describe("runBenchmark pre-trial stop hook", () => {
  it("halts after exactly one completed trial", () => {
    expect(results.trials).toHaveLength(1);
  });

  it("stamps stopped with completedTrials 1 of plannedTrials 2", () => {
    expect(results.stopped).toBeDefined();
    expect(results.stopped!.completedTrials).toBe(1);
    expect(results.stopped!.plannedTrials).toBe(2);
    expect(results.stopped!.reason).toContain("test stop before the 2nd trial");
  });

  it("still writes a results.json that validates under the schema (preserved evidence)", async () => {
    const raw: unknown = JSON.parse(await readFile(path.join(benchDir, "results.json"), "utf8"));
    const parsed = BenchmarkResultsSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.trials).toHaveLength(1);
      expect(parsed.data.stopped?.completedTrials).toBe(1);
      expect(parsed.data.stopped?.plannedTrials).toBe(2);
    }
  });

  it("calls afterTrial exactly once, with the single recorded trial", () => {
    expect(afterTrialRecords).toHaveLength(1);
    expect(afterTrialRecords[0]).toEqual(results.trials[0]);
  });
});
