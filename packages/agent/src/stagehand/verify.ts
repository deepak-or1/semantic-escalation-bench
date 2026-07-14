import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRunLogger,
  labCredentials,
  LabClient,
  newRunId,
  scenarioById,
  type ExpectedOutcome,
  type PipelineResult
} from "@ssda/shared";
import { loadAgentEnvConfig, requireStagehandReady, scoreOdds, scoreStats } from "../core";
import { stagehandEngine } from "./engine";

/**
 * Manual live harness for the Stagehand engine. Boots the lab in a child
 * process, then — only if a model provider key is configured — runs a handful
 * of scenarios end-to-end and prints success/failure/accuracy per scenario.
 * With no provider key it prints the friendly setup error and exits 2.
 *
 * Run: ~/Library/pnpm/pnpm exec tsx packages/agent/src/stagehand/verify.ts
 */

const LAB_PORT = 4531;
const LAB_URL = `http://localhost:${LAB_PORT}`;
const SCENARIO_IDS = [
  "clean-extraction",
  "class-drift",
  "hidden-tab",
  "odds-format-american",
  "schema-violation"
] as const;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PNPM = path.join(os.homedir(), "Library", "pnpm", "pnpm");

function matchesExpectation(expected: ExpectedOutcome, result: PipelineResult): boolean {
  if (expected === "validation-failure") return result.success === false;
  // "success" and "success-with-warnings" both require a passing pipeline.
  return result.success === true;
}

async function main(): Promise<number> {
  const lab = spawn(PNPM, ["exec", "tsx", "apps/lab/src/server.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, LAB_PORT: String(LAB_PORT) },
    stdio: ["ignore", "ignore", "inherit"]
  });

  try {
    const client = new LabClient(LAB_URL);
    await client.waitUntilReady(20_000);

    const config = loadAgentEnvConfig();
    if (!config.stagehandModel) {
      try {
        requireStagehandReady(config, "local");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
      return 2;
    }

    let unexpected = 0;
    for (const id of SCENARIO_IDS) {
      const spec = scenarioById(id);
      if (!spec) {
        console.error(`unknown scenario: ${id}`);
        unexpected += 1;
        continue;
      }

      await client.configure({ seed: spec.seed, chaos: spec.chaos });
      const runDir = await mkdtemp(path.join(os.tmpdir(), `ssda-verify-${id}-`));
      const runId = newRunId("trial");
      const logger = createRunLogger({ runId, file: path.join(runDir, "events.jsonl") });

      const result = await stagehandEngine.run({
        labUrl: LAB_URL,
        pages: ["stats", "odds"],
        credentials: labCredentials(),
        session: { mode: "fresh" },
        runId,
        runDir,
        logger,
        scenarioId: id,
        seed: spec.seed,
        headless: true,
        maxAttempts: 2,
        navTimeoutMs: 20_000,
        stepTimeoutMs: 45_000,
        env: "local"
      });

      const truth = await client.groundTruth();
      const stats = result.normalized
        ? scoreStats(result.normalized.teams, truth.truth, truth.overrides)
        : undefined;
      const odds = result.normalized
        ? scoreOdds(result.normalized.markets, truth.truth, truth.overrides)
        : undefined;

      const ok = matchesExpectation(spec.expected, result);
      if (!ok) unexpected += 1;
      const fmt = (value?: number): string => (typeof value === "number" ? value.toFixed(2) : "-");
      console.log(
        `${ok ? "OK" : "XX"} ${id}: expected=${spec.expected} success=${result.success} ` +
          `failureCategory=${result.failureCategory ?? "-"} ` +
          `statsAcc=${fmt(stats?.score)} oddsAcc=${fmt(odds?.score)}`
      );
    }

    if (unexpected > 0) {
      console.error(`${unexpected} scenario(s) produced an unexpected outcome`);
      return 1;
    }
    return 0;
  } finally {
    lab.kill("SIGTERM");
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
