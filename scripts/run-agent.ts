/**
 * Run one extraction pipeline against the lab and produce a value watchlist.
 *
 *   pnpm agent:local                                  # Stagehand, local browser
 *   pnpm agent:browserbase                            # Stagehand on Browserbase
 *   pnpm agent:local -- --engine baseline             # Playwright baseline
 *   pnpm agent:local -- --scenario class-drift        # a benchmark scenario's lab setup
 *   pnpm agent:local -- --engine hybrid --scenario class-drift --no-repair
 *   pnpm agent:local -- --seed 7 --chaos modal,copyDrift --headed
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  CHAOS_FLAGS,
  ChaosFlagSchema,
  createRunDir,
  createRunLogger,
  DEFAULT_SEED,
  LabClient,
  labBaseUrl,
  labCredentials,
  scenarioById,
  writeJson,
  type ChaosFlag,
  type PipelineResult
} from "@ssda/shared";
import {
  baselineEngine,
  DEFAULT_PIPELINE_TIMEOUTS,
  hybridEngine,
  overallAccuracy,
  scoreOdds,
  scoreStats,
  stagehandEngine,
  type Engine
} from "@ssda/agent";
import { buildWatchlist } from "@ssda/model";

interface CliArgs {
  engine: Engine;
  env: "local" | "browserbase";
  seed: number;
  chaos: ChaosFlag[];
  pages: Array<"stats" | "odds">;
  headed: boolean;
  scenarioId?: string;
  /** Freeze the hybrid engine's repair path (--no-repair). */
  noRepair: boolean;
}

function bail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  let engine: Engine = stagehandEngine;
  let env: CliArgs["env"] = "local";
  let seed = Number.parseInt(process.env.LAB_SEED ?? "", 10);
  if (!Number.isFinite(seed)) seed = DEFAULT_SEED;
  let chaos: ChaosFlag[] = [];
  let pages: CliArgs["pages"] = ["stats", "odds"];
  let headed = false;
  let scenarioId: string | undefined;
  let noRepair = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--engine") {
      const name = argv[++i];
      if (name === "baseline") engine = baselineEngine;
      else if (name === "stagehand") engine = stagehandEngine;
      else if (name === "hybrid") engine = hybridEngine;
      else bail(`Unknown engine "${name}" (stagehand | baseline | hybrid)`);
    } else if (arg === "--env") {
      const value = argv[++i];
      if (value !== "local" && value !== "browserbase") bail(`--env must be local|browserbase`);
      env = value;
    } else if (arg === "--seed") {
      seed = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(seed)) bail("--seed must be an integer");
    } else if (arg === "--chaos") {
      chaos = (argv[++i] ?? "").split(",").filter(Boolean).map((raw) => {
        const parsed = ChaosFlagSchema.safeParse(raw);
        if (!parsed.success) bail(`Unknown chaos flag "${raw}". Valid: ${CHAOS_FLAGS.join(", ")}`);
        return parsed.data;
      });
    } else if (arg === "--pages") {
      pages = (argv[++i] ?? "").split(",").filter(Boolean) as CliArgs["pages"];
      if (pages.some((p) => p !== "stats" && p !== "odds") || pages.length === 0) {
        bail("--pages must be a comma list of: stats, odds");
      }
    } else if (arg === "--headed") {
      headed = true;
    } else if (arg === "--no-repair") {
      noRepair = true;
    } else if (arg === "--scenario") {
      scenarioId = argv[++i];
      const scenario = scenarioId ? scenarioById(scenarioId) : undefined;
      if (!scenario) bail(`Unknown scenario "${scenarioId}". See packages/shared/src/scenarios.ts`);
      seed = scenario.seed;
      chaos = [...scenario.chaos];
    }
  }
  return { engine, env, seed, chaos, pages, headed, scenarioId, noRepair };
}

async function ensureLab(lab: LabClient): Promise<ChildProcess | null> {
  if (await lab.health()) return null;
  console.log(`Lab not running at ${lab.baseUrl} — starting it...`);
  const child = spawn(
    path.join(process.env.HOME ?? "~", "Library/pnpm/pnpm"),
    ["exec", "tsx", "apps/lab/src/server.ts"],
    { cwd: process.cwd(), stdio: "ignore", env: process.env }
  );
  await lab.waitUntilReady(20_000);
  return child;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lab = new LabClient(labBaseUrl());
  const labChild = await ensureLab(lab);

  try {
    await lab.configure({ seed: args.seed, chaos: args.chaos });
    console.log(
      `Lab configured: seed=${args.seed} chaos=[${args.chaos.join(", ")}]` +
        (args.scenarioId ? ` (scenario: ${args.scenarioId})` : "")
    );

    const { runId, dir } = await createRunDir({
      kind: "agent",
      engine: args.engine.name,
      seed: args.seed,
      labUrl: lab.baseUrl,
      ...(args.scenarioId ? { scenarioId: args.scenarioId } : {}),
      description: `manual ${args.engine.name} run (${args.env})`
    });
    const logger = createRunLogger({
      runId,
      file: path.join(dir, "events.jsonl"),
      engine: args.engine.name,
      console: true
    });

    const result: PipelineResult = await args.engine.run({
      labUrl: lab.baseUrl,
      pages: args.pages,
      credentials: labCredentials(),
      session: { mode: "fresh" },
      runId,
      runDir: dir,
      logger,
      seed: args.seed,
      headless: !args.headed,
      maxAttempts: 2,
      navTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.navTimeoutMs,
      stepTimeoutMs: DEFAULT_PIPELINE_TIMEOUTS.stepTimeoutMs,
      env: args.env,
      ...(args.noRepair ? { disableRepair: true } : {})
    });
    await writeJson(path.join(dir, "result.json"), result);

    console.log("");
    console.log(`Run ${runId}: ${result.success ? "SUCCESS" : "FAILED"} in ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  steps: ${result.steps.map((s) => `${s.name}:${s.status}`).join(" → ")}`);
    if (!result.success) {
      console.log(`  failure: [${result.failureCategory}] ${result.failureDetail}`);
    }
    if (result.tokens) {
      console.log(
        `  llm: ${result.tokens.llmCalls} calls, ${result.tokens.inputTokens ?? "?"} in / ${result.tokens.outputTokens ?? "?"} out tokens`
      );
    }

    // Score against the lab's seeded ground truth (demo insight, not cheating —
    // the engine itself never sees this endpoint).
    if (result.normalized) {
      const { truth, overrides } = await lab.groundTruth();
      const stats = scoreStats(result.normalized.teams, truth, overrides);
      const odds = scoreOdds(result.normalized.markets, truth, overrides);
      const overall = overallAccuracy(stats, odds);
      console.log(
        `  accuracy vs ground truth: stats ${formatPct(stats.score)}, odds ${formatPct(odds.score)}` +
          (overall !== undefined ? `, overall ${formatPct(overall)}` : "")
      );
    }

    if (result.success && result.normalized) {
      const watchlist = buildWatchlist(result.normalized);
      await writeJson(path.join(dir, "watchlist.json"), watchlist);
      console.log("");
      console.log(
        `Value watchlist (dataset confidence: ${watchlist.datasetConfidence.label}; edges > 2% shown):`
      );
      const top = watchlist.selections.slice(0, 8);
      if (top.length === 0) console.log("  no selections above the edge threshold");
      for (const sel of top) {
        console.log(
          `  ${sel.fixture.padEnd(38)} ${sel.label.padEnd(24)} @${sel.decimalOdds.toFixed(2)}  ` +
            `model ${formatPct(sel.modelProbability)} vs implied ${formatPct(sel.impliedNoVig)}  ` +
            `edge ${formatPct(sel.edge)}  EV ${sel.expectedValuePerUnit.toFixed(3)}  [${sel.confidence}]`
        );
      }
      console.log("  (read-only analytics demo — not betting advice)");
    }

    console.log("");
    console.log(`Artifacts: ${dir}`);
    process.exitCode = result.success ? 0 : 1;
  } finally {
    if (labChild) labChild.kill();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
