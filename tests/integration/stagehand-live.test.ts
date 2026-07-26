import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_TIMEOUTS,
  overallAccuracy,
  scoreOdds,
  scoreStats,
  stagehandEngine,
  type PipelineOptions
} from "@ssda/agent";
import { createRunLogger, labCredentials, scenarioById } from "@ssda/shared";
import { startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * Live Stagehand smoke test. Skipped unless a model provider key is set — this
 * is the suite that lights up once the user adds ANTHROPIC_API_KEY /
 * OPENAI_API_KEY. Kept to a single clean scenario to bound token cost.
 */

// A key alone is NOT enough to spend money: the operator must also opt in
// explicitly with RUN_LIVE_KEYED_TESTS=1. The global setup file scrubs ambient
// credentials, and this second condition means an ordering regression there can
// never on its own start a paid run.
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
const liveRequested = process.env.RUN_LIVE_KEYED_TESTS === "1";

describe.skipIf(!hasKey || !liveRequested)("stagehand engine (live, requires a model key)", () => {
  let lab: Lab;

  beforeAll(async () => {
    lab = await startLab();
  });

  afterAll(async () => {
    await stopLab(lab);
  });

  it("clean-extraction: succeeds with high accuracy and reports tokens", async () => {
    const scenario = scenarioById("clean-extraction");
    if (!scenario) throw new Error("unknown scenario clean-extraction");
    await lab.client.configure({ seed: scenario.seed, chaos: scenario.chaos });

    const runDir = await tmpDir("ssda-stagehand-clean-");
    const logger = createRunLogger({
      runId: "clean-extraction",
      file: path.join(runDir, "events.jsonl"),
      console: false
    });
    const options: PipelineOptions = {
      labUrl: lab.url,
      pages: ["stats", "odds"],
      credentials: labCredentials(),
      session: { mode: "fresh" },
      runId: "clean-extraction",
      runDir,
      logger,
      scenarioId: "clean-extraction",
      seed: scenario.seed,
      headless: true,
      maxAttempts: 2,
      navTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.navTimeoutMs,
      stepTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.stepTimeoutMs,
      env: "local"
    };
    const result = await stagehandEngine.run(options);

    expect(result.success).toBe(true);
    expect(result.normalized).toBeDefined();

    const { truth, overrides } = await lab.client.groundTruth();
    const stats = scoreStats(result.normalized!.teams, truth, overrides);
    const odds = scoreOdds(result.normalized!.markets, truth, overrides);
    const overall = overallAccuracy(stats, odds);
    expect(overall).toBeDefined();
    expect(overall!).toBeGreaterThanOrEqual(0.9);

    expect(result.tokens).not.toBeNull();
  });
});
