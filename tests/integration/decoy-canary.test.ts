import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_TIMEOUTS,
  hybridEngine,
  judge,
  loadAgentEnvConfig,
  overallAccuracy,
  scoreOdds,
  scoreStats,
  type PipelineOptions
} from "@ssda/agent";
import {
  createRunLogger,
  labCredentials,
  type PipelineResult,
  type ScenarioSpec
} from "@ssda/shared";
import { startLab, stopLab, tmpDir, type Lab } from "./helpers";

/**
 * Stage-1 fake-key decoy canary (PROTOCOL_2A §3 F2, §5 item 8). A BUILT-IN decoy
 * fixture — never a held-out scenario, never evidence, part of the frozen suite —
 * proves trigger-blindness DIRECTLY: an F2 next-page decoy rebinds the canonical
 * `#next-page` id onto an inert button, the hybrid engine's cached click lands on
 * it and reports success at the act layer, so C's key-gated repair never triggers.
 *
 * The run uses `--repair-mode llm` with a SYNTACTICALLY VALID FAKE key, so repair
 * is fully ENABLED (hasKey true) — yet the required observations hold: the cached
 * click reports success, the workflow fails DOWNSTREAM (pagination silently
 * defeated → incomplete data → judged failure), `llmCalls === 0`, `healedSteps`
 * is empty, and NO provider/auth error occurs. The fake key is the proof: had any
 * observe/extract been attempted, it would have hit a 401 — its absence shows no
 * model call was even attempted. Runs keylessly (the fake key is set here and
 * overrides any real env key for the duration of this test).
 */

type Result = PipelineResult & { deterministicRepairSteps?: string[] };

// A syntactically valid but entirely FAKE Anthropic key — never a real secret.
const FAKE_ANTHROPIC_KEY =
  "sk-ant-api03-CANARYCANARYCANARYCANARYCANARYCANARYCANARYCANARYCANARYCANARY-decoyAA";

const SEED = 2201;
const CHAOS = ["pagination", "hiddenTab"] as const;
// decoyLevel 1 rebinds the FIRST control [next-page]; copy/placement are arbitrary
// fixed values (the held-out params, pinned here for a deterministic fixture).
const PARAMS = {
  decoyLevel: 1,
  decoyCopy: { "next-page": "Load more results" },
  decoyPlacement: "after" as const
};

let lab: Lab;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // Override ANY real provider key with the fake so this test is keyless-by-proof.
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "STAGEHAND_MODEL"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.STAGEHAND_MODEL;
  process.env.SSDA_RUNS_DIR = await mkdtemp(path.join(os.tmpdir(), "ssda-canary-runs-"));
  lab = await startLab();
});

afterAll(async () => {
  await stopLab(lab);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const AUTH_ERROR = /401|authentication|invalid x-api-key|unauthorized|x-api-key/i;

describe("fake-key decoy canary (PROTOCOL_2A §3 F2)", () => {
  it("act-layer success, downstream failure, llmCalls 0, no heals, no auth error", async () => {
    // The fake key makes hasKey TRUE (repair is enabled, not skipped).
    const cfg = loadAgentEnvConfig();
    expect(cfg.modelProvider).toBe("anthropic");
    expect(cfg.stagehandModel).toBeTruthy();

    await lab.client.configure({ seed: SEED, chaos: [...CHAOS], params: PARAMS });
    const { truth, overrides } = await lab.client.groundTruth();

    const runDir = await tmpDir("ssda-canary-");
    const logger = createRunLogger({
      runId: "decoy-canary",
      file: path.join(runDir, "events.jsonl"),
      console: false
    });
    const options: PipelineOptions = {
      labUrl: lab.url,
      pages: ["stats", "odds"],
      credentials: labCredentials(),
      session: { mode: "fresh" },
      runId: "decoy-canary",
      runDir,
      logger,
      scenarioId: "decoy-canary",
      seed: SEED,
      headless: true,
      maxAttempts: 2,
      navTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.navTimeoutMs,
      stepTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.stepTimeoutMs,
      env: "local",
      repairMode: "llm"
    };
    const result = (await hybridEngine.run(options)) as Result;

    // (1) The cached next-page click reported success at the ACT layer: the click
    // did not throw, so the extract-stats step (which drives the pager) PASSED and
    // no step failed. The decoy absorbed the click.
    const extractStats = result.steps.find((s) => s.name === "extract-stats");
    expect(extractStats?.status).toBe("passed");
    expect(result.steps.every((s) => s.status === "passed")).toBe(true);

    // (2) llmCalls === 0 and healedSteps empty: C's repair NEVER triggered, even
    // though repair was enabled — the decoy click "succeeded", so no repair fired.
    expect(result.tokens?.llmCalls).toBe(0);
    expect(result.healedSteps ?? []).toEqual([]);
    expect(result.deterministicRepairSteps ?? []).toEqual([]);

    // (3) NO provider/auth error anywhere: the fake key proves no model call was
    // even attempted (any attempt would have 401'd).
    const errorSurface = [
      result.failureDetail ?? "",
      ...result.steps.map((s) => s.error ?? "")
    ].join("\n");
    expect(errorSurface).not.toMatch(AUTH_ERROR);

    // (4) The pipeline FAILED DOWNSTREAM: the decoy silently defeated pagination,
    // so the standings are incomplete and the WORKFLOW is a judged failure — even
    // though every act-layer step reported success.
    expect(result.normalized).toBeDefined();
    expect(result.normalized!.teams.length).toBeLessThan(truth.teams.length);

    const stats = scoreStats(result.normalized!.teams, truth, overrides);
    const odds = scoreOdds(result.normalized!.markets, truth, overrides);
    const overall = overallAccuracy(stats, odds);
    const scenario: ScenarioSpec = {
      id: "decoy-canary",
      name: "F2 fake-key decoy canary",
      description: "next-page decoy; repair enabled with a fake key",
      chaos: [...CHAOS],
      seed: SEED,
      session: "fresh",
      expected: "success",
      group: "core",
      params: PARAMS
    };
    const verdict = judge(scenario, result, overall, { stats, odds });
    expect(verdict.outcome).toBe("fail");
  });
});
