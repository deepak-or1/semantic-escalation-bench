import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_TIMEOUTS,
  hybridEngine,
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
 * Policy B2 (--repair-mode deterministic) against a real in-process lab, run
 * KEYLESS. B2 needs NO model key by construction, so these assertions hold with
 * no provider configured. Proves PROTOCOL_2A §2's load-bearing claims end to end:
 *  - class-drift succeeds via the deterministic login re-location ladder, with
 *    ZERO llm calls, deterministicRepairSteps recorded, and healedSteps NEVER set;
 *  - the deterministic card reader fires on a card layout (extract-stats), still
 *    ZERO llm calls, and reports the §2 card-reader failure string on the odds
 *    cards (no match label maps);
 *  - --repair-mode llm keyless is behaviourally UNCHANGED (same keyless failure
 *    string, no deterministic repair) — the C dispatch is untouched;
 *  - --repair-mode off reproduces --no-repair exactly (same disabled string);
 *  - B2 NEVER persists a healed-cache.json artifact.
 */

/** deterministicRepairSteps rides on the PipelineResult out-of-schema (see runner). */
type Result = PipelineResult & { deterministicRepairSteps?: string[] };

let lab: Lab;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "STAGEHAND_MODEL"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SSDA_RUNS_DIR = await mkdtemp(path.join(os.tmpdir(), "ssda-b2-runs-"));
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
): Promise<{ result: Result; runDir: string }> {
  const scenario = scenarioById(scenarioId);
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`);
  await lab.client.configure({ seed: scenario.seed, chaos: scenario.chaos });

  const runDir = await tmpDir(`ssda-b2-${scenarioId}-`);
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
  const result = (await hybridEngine.run(options)) as Result;
  return { result, runDir };
}

describe("hybrid --repair-mode deterministic (policy B2, keyless)", () => {
  it("class-drift: succeeds via the deterministic login ladder with ZERO llm calls", async () => {
    const { result, runDir } = await runScenario("class-drift", { repairMode: "deterministic" });
    expect(result.success).toBe(true);
    // llmCalls MUST be 0 BY CONSTRUCTION (no observe/extract reachable in B2).
    expect(result.tokens?.llmCalls).toBe(0);
    // The deterministic ladder re-located the login controls; B2 records this in
    // deterministicRepairSteps and NEVER writes healedSteps.
    expect(result.deterministicRepairSteps).toEqual(["login"]);
    expect(result.healedSteps ?? []).toEqual([]);

    const { truth, overrides } = await lab.client.groundTruth();
    expect(result.normalized).toBeDefined();
    expect(scoreStats(result.normalized!.teams, truth, overrides).score).toBe(1);

    // B2 heals only its in-memory cache — never a healed-cache.json artifact.
    expect(await fileExists(path.join(runDir, "artifacts", "healed-cache.json"))).toBe(false);
  });

  it("layout-variant: stats teams come from card headings; odds cards (no heading) are defeated", async () => {
    // Revision-5 identity rule: a block's team/match name comes from its heading
    // (h1–h6) or first non-pair text. The lab's TEAM cards have an <h3> heading, so
    // stats now grade perfectly; the ODDS cards have no heading, so their identity
    // is the first non-pair text (the kickoff), which is not a fixture — the odds
    // rows carry no team names and the engine fails cleanly in VALIDATION.
    const { result } = await runScenario("layout-variant", { repairMode: "deterministic" });
    expect(result.tokens?.llmCalls).toBe(0);
    // Both card readers find a mappable structure and fire; healedSteps stays empty.
    expect(result.deterministicRepairSteps).toEqual(["extract-stats", "extract-odds"]);
    expect(result.healedSteps ?? []).toEqual([]);

    // Stats identity from the h3 heading → team names correct → perfect stats score.
    const { truth, overrides } = await lab.client.groundTruth();
    expect(result.normalized).toBeDefined();
    expect(scoreStats(result.normalized!.teams, truth, overrides).score).toBe(1);

    // Odds identity is the kickoff, not the fixture → missing team names → validation
    // failure (a safe-failure the engine catches, NOT silent corruption).
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("validation");
    expect(result.failureDetail ?? "").toContain("missing team name");
  });
});

describe("hybrid repair-mode dispatch parity (keyless)", () => {
  it("--repair-mode llm is UNCHANGED: same keyless failure string, no deterministic repair", async () => {
    const { result } = await runScenario("class-drift", { repairMode: "llm" });
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("not_found");
    expect(result.failureDetail ?? "").toContain("semantic repair unavailable (no model key)");
    expect(result.tokens?.llmCalls).toBe(0);
    expect(result.deterministicRepairSteps ?? []).toEqual([]);
  });

  it("--repair-mode off reproduces --no-repair exactly (same disabled string)", async () => {
    const { result } = await runScenario("class-drift", { repairMode: "off" });
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("not_found");
    expect(result.failureDetail ?? "").toContain("repair disabled (--no-repair)");
    expect(result.tokens?.llmCalls).toBe(0);
    expect(result.deterministicRepairSteps ?? []).toEqual([]);
  });
});
