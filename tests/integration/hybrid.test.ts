import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_TIMEOUTS,
  hybridEngine,
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
import { startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * The hybrid engine against a real (in-process) lab, run KEYLESS. Proves the
 * three load-bearing claims of its design end to end with a real browser:
 *  - clean-extraction succeeds with ZERO LLM calls (deterministic tier alone);
 *  - column-shuffle succeeds because columns are mapped by HEADER NAME, where a
 *    positional reader would silently misread;
 *  - class-drift fails HONESTLY — the login ids vanish and, keyless, there is no
 *    repair, so it reports the contract's "repair unavailable" boundary.
 */

let lab: Lab;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Force keyless regardless of the host machine so repairs are genuinely
  // unavailable and llmCalls must be 0.
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "STAGEHAND_MODEL"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SSDA_RUNS_DIR = await mkdtemp(path.join(os.tmpdir(), "ssda-hybrid-runs-"));
  lab = await startLab();
});

afterAll(async () => {
  await stopLab(lab);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function runScenario(
  scenarioId: string,
  extra: Partial<PipelineOptions> = {}
): Promise<PipelineResult> {
  const scenario = scenarioById(scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);
  await lab.client.configure({ seed: scenario.seed, chaos: scenario.chaos });

  const runDir = await tmpDir(`ssda-hybrid-${scenarioId}-`);
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
    env: "local",
    ...extra
  };
  return hybridEngine.run(options);
}

describe("hybrid engine vs in-process lab (keyless)", () => {
  it("clean-extraction: succeeds with perfect accuracy and ZERO llm calls", async () => {
    const result = await runScenario("clean-extraction");
    expect(result.success).toBe(true);
    expect(result.tokens?.llmCalls).toBe(0);

    const { truth, overrides } = await lab.client.groundTruth();
    expect(result.normalized).toBeDefined();
    expect(scoreStats(result.normalized!.teams, truth, overrides).score).toBe(1);
    expect(scoreOdds(result.normalized!.markets, truth, overrides).score).toBe(1);
  });

  it("column-shuffle: succeeds via header-name mapping, still ZERO llm calls", async () => {
    const result = await runScenario("column-shuffle");
    expect(result.success).toBe(true);
    expect(result.tokens?.llmCalls).toBe(0);

    const { truth, overrides } = await lab.client.groundTruth();
    expect(scoreStats(result.normalized!.teams, truth, overrides).score).toBe(1);
  });

  it("class-drift: fails honestly as not_found with the repair-unavailable detail", async () => {
    const result = await runScenario("class-drift");
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("not_found");
    expect(result.failureDetail ?? "").toContain("semantic repair unavailable (no model key)");
  });

  it("--no-repair: freezes repair with a distinct 'repair disabled' detail, still 0 llm calls", async () => {
    // disableRepair short-circuits the repair path on the same condition a
    // key-present run would (`canRepair` false), so this keyless run exercises
    // the identical branch and proves the distinct frozen-config detail string.
    const result = await runScenario("class-drift", { disableRepair: true });
    expect(result.success).toBe(false);
    expect(result.tokens?.llmCalls).toBe(0);
    expect(result.failureCategory).toBe("not_found");
    expect(result.failureDetail ?? "").toContain("repair disabled (--no-repair)");
  });
});
