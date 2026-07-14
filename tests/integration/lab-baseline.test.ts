import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_TIMEOUTS,
  baselineEngine,
  scoreOdds,
  scoreStats,
  type PipelineOptions
} from "@ssda/agent";
import {
  createRunLogger,
  labCredentials,
  scenarioById,
  type PipelineResult
} from "@ssda/shared";
import { fileExists, startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * The Playwright baseline against a real (in-process) lab. Covers one success
 * scenario end to end (extraction + artifacts + accuracy) and two failure
 * scenarios where correct behaviour is a clean, categorised failure.
 */

let lab: Lab;

beforeAll(async () => {
  lab = await startLab();
});

afterAll(async () => {
  await stopLab(lab);
});

/** Configure the lab for a scenario, then drive the baseline over stats+odds. */
async function runScenario(
  scenarioId: string
): Promise<{ result: PipelineResult; runDir: string }> {
  const scenario = scenarioById(scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);
  await lab.client.configure({ seed: scenario.seed, chaos: scenario.chaos });

  const runDir = await tmpDir(`ssda-baseline-${scenarioId}-`);
  const logger = createRunLogger({
    runId: scenarioId,
    file: path.join(runDir, "events.jsonl"),
    console: false
  });
  const options: PipelineOptions = {
    labUrl: lab.url,
    pages: ["stats", "odds"],
    credentials: labCredentials(),
    session: { mode: "fresh" },
    runId: scenarioId,
    runDir,
    logger,
    scenarioId,
    seed: scenario.seed,
    headless: true,
    maxAttempts: 2,
    navTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.navTimeoutMs,
    stepTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.stepTimeoutMs,
    env: "local"
  };
  const result = await baselineEngine.run(options);
  return { result, runDir };
}

describe("baseline engine vs in-process lab", () => {
  it("clean-extraction: succeeds with perfect accuracy and writes artifacts", async () => {
    const { result } = await runScenario("clean-extraction");
    expect(result.success).toBe(true);

    const { truth, overrides } = await lab.client.groundTruth();
    expect(result.normalized).toBeDefined();
    const stats = scoreStats(result.normalized!.teams, truth, overrides);
    const odds = scoreOdds(result.normalized!.markets, truth, overrides);
    expect(stats.score).toBe(1);
    expect(odds.score).toBe(1);

    const dir = result.artifacts.dir;
    expect(await fileExists(path.join(dir, "artifacts", "stats-a1.png"))).toBe(true);
    expect(await fileExists(path.join(dir, "raw", "stats-attempt-1.json"))).toBe(true);
    expect(await fileExists(path.join(dir, "normalized.json"))).toBe(true);
  });

  it("class-drift: fails cleanly as not_found or timeout", async () => {
    const { result } = await runScenario("class-drift");
    expect(result.success).toBe(false);
    expect(["not_found", "timeout"]).toContain(result.failureCategory);
  });

  it("schema-violation: fails cleanly as a validation error", async () => {
    const { result } = await runScenario("schema-violation");
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("validation");
  });
});
