import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapActions,
  DEFAULT_PIPELINE_TIMEOUTS,
  hybridEngine,
  judge,
  overallAccuracy,
  scoreOdds,
  scoreStats,
  type PipelineOptions
} from "@ssda/agent";
import {
  createRunLogger,
  labCredentials,
  scenarioById,
  writeJson,
  type PipelineResult
} from "@ssda/shared";
import { startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * Replay-of-repair proof, run KEYLESS. A keyed hybrid run against the class-drift
 * scenario would `observe()` the vanished login ids and heal its cache to
 * structural selectors, persisting them to healed-cache.json. This test builds
 * that healed cache BY HAND (the harness's job — the engine stays scenario-blind
 * and never touches /__lab), then seeds a fresh KEYLESS trial from it and proves
 * the repair replays with ZERO model calls: perfect extraction, no runtime heal.
 *
 * The three login act-path selectors are the only ones class-drift kills (ids are
 * stripped; the stats/odds tables keep class-agnostic headers the deterministic
 * reader maps unaided, and this scenario has no consent wall, modal, hidden tab
 * or pager, so those cached entries never fire). The healed values below are the
 * structural selectors that survive class drift — verified against the lab markup
 * for seed 1108: the login inputs keep their `name=` attributes and the submit
 * button is the only one inside `form[action="/login"]`.
 */

let lab: Lab;
let fixtureFile: string;
const savedEnv: Record<string, string | undefined> = {};
const SCENARIO_ID = "class-drift";

beforeAll(async () => {
  // Force keyless regardless of the host machine, so repairs are genuinely
  // unavailable and any success MUST come from the seeded cache alone.
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "STAGEHAND_MODEL"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.SSDA_RUNS_DIR = await mkdtemp(path.join(os.tmpdir(), "ssda-hybrid-seed-runs-"));
  lab = await startLab();

  // Build the healed-cache fixture: the bootstrap with only the class-drift
  // casualties (the login trio) swapped for the structural selectors a keyed
  // observe() would have discovered. method/arguments/description are preserved,
  // so the %username% / %password% variables still substitute at act() time.
  const base = bootstrapActions();
  const healed = {
    ...base,
    username: { ...base.username, selector: 'input[name="username"]' },
    password: { ...base.password, selector: 'input[name="password"]' },
    "login-submit": {
      ...base["login-submit"],
      selector: 'form[action="/login"] button[type="submit"]'
    }
  };
  const fixtureDir = await tmpDir("ssda-hybrid-seed-fixture-");
  fixtureFile = path.join(fixtureDir, "healed-cache.json");
  await writeJson(fixtureFile, healed);
});

afterAll(async () => {
  await stopLab(lab);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function runSeeded(seedCacheFile: string): Promise<PipelineResult> {
  const scenario = scenarioById(SCENARIO_ID);
  if (!scenario) throw new Error(`unknown scenario ${SCENARIO_ID}`);
  await lab.client.configure({ seed: scenario.seed, chaos: scenario.chaos });

  const runDir = await tmpDir(`ssda-hybrid-seed-${SCENARIO_ID}-`);
  const logger = createRunLogger({
    runId: SCENARIO_ID,
    file: path.join(runDir, "events.jsonl"),
    console: false
  });
  const options: PipelineOptions = {
    labUrl: lab.url,
    pages: ["stats", "odds"],
    credentials: labCredentials(),
    session: { mode: "fresh" },
    runId: SCENARIO_ID,
    runDir,
    logger,
    scenarioId: SCENARIO_ID,
    seed: scenario.seed,
    headless: true,
    maxAttempts: 2,
    navTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.navTimeoutMs,
    stepTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.stepTimeoutMs,
    env: "local",
    seedCacheFile
  };
  return hybridEngine.run(options);
}

describe("hybrid warm-cache seeding vs in-process lab (keyless)", () => {
  it("class-drift: a seeded healed cache passes keyless with perfect accuracy and ZERO llm calls", async () => {
    const result = await runSeeded(fixtureFile);

    // Pipeline succeeded and the judge accepts it (perfect-extraction bar).
    expect(result.success).toBe(true);
    const { truth, overrides } = await lab.client.groundTruth();
    expect(result.normalized).toBeDefined();
    const stats = scoreStats(result.normalized!.teams, truth, overrides);
    const odds = scoreOdds(result.normalized!.markets, truth, overrides);
    const overall = overallAccuracy(stats, odds);
    expect(stats.score).toBe(1);
    expect(odds.score).toBe(1);
    expect(overall).toBe(1);

    const verdict = judge(scenarioById(SCENARIO_ID)!, result, overall);
    expect(verdict.outcome).toBe("pass");

    // The load-bearing proof: the win came from replaying the seeded cache, not
    // from a model. No LLM calls, and nothing healed at RUNTIME (a pure replay).
    expect(result.tokens?.llmCalls).toBe(0);
    expect(result.healedSteps ?? []).toEqual([]);
  });

  it("class-drift WITHOUT the seed still fails honestly (the seed is the only new input)", async () => {
    // Sanity floor: the same keyless trial from the bootstrap cache fails at the
    // vanished login id — so the pass above is attributable to the seed alone,
    // not to some environmental change.
    const scenario = scenarioById(SCENARIO_ID)!;
    await lab.client.configure({ seed: scenario.seed, chaos: scenario.chaos });
    const runDir = await tmpDir(`ssda-hybrid-noseed-${SCENARIO_ID}-`);
    const logger = createRunLogger({
      runId: SCENARIO_ID,
      file: path.join(runDir, "events.jsonl"),
      console: false
    });
    const result = await hybridEngine.run({
      labUrl: lab.url,
      pages: ["stats", "odds"],
      credentials: labCredentials(),
      session: { mode: "fresh" },
      runId: SCENARIO_ID,
      runDir,
      logger,
      scenarioId: SCENARIO_ID,
      seed: scenario.seed,
      headless: true,
      maxAttempts: 2,
      navTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.navTimeoutMs,
      stepTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.stepTimeoutMs,
      env: "local"
    });
    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("not_found");
    expect(result.tokens?.llmCalls).toBe(0);
  });
});
