/**
 * Run one extraction pipeline against the lab and produce a value watchlist.
 *
 *   pnpm agent:local                                  # Stagehand, local browser
 *   pnpm agent:browserbase                            # Stagehand on Browserbase
 *   pnpm agent:local -- --engine baseline             # Playwright baseline
 *   pnpm agent:local -- --scenario class-drift        # a benchmark scenario's lab setup
 *   pnpm agent:local -- --engine hybrid --scenario class-drift --no-repair
 *   pnpm agent:local -- --engine hybrid --scenario class-drift --seed-cache <healed-cache.json>
 *   pnpm agent:local -- --seed 7 --chaos modal,copyDrift --headed
 *
 * LAB OWNERSHIP (Wave E 8a): by default this spawns a PRIVATE lab child on a
 * free ephemeral port, exclusive to this run, and kills it on exit — it never
 * reuses an already-running lab. Pass `--lab-url <url>` to target a caller-owned
 * lab instead (then exclusivity is the caller's responsibility).
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAOS_FLAGS,
  ChaosFlagSchema,
  createRunDir,
  createRunLogger,
  DEFAULT_SEED,
  LabClient,
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
  /** Caller-owned lab URL (--lab-url); when unset, a private lab is spawned. */
  labUrl?: string;
  /** Freeze the hybrid engine's repair path (--no-repair). */
  noRepair: boolean;
  /** Warm-start the hybrid cache from a healed-cache.json artifact (--seed-cache). */
  seedCacheFile?: string;
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

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
  let labUrl: string | undefined;
  let noRepair = false;
  let seedCacheFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // A bare "--" separator (docs use `pnpm agent:local -- --engine ...`) is
    // skipped so it never trips the argument parser (Wave E 8k).
    if (arg === "--") continue;
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
    } else if (arg === "--seed-cache") {
      seedCacheFile = argv[++i];
      if (!seedCacheFile) bail("--seed-cache needs a path to a healed-cache.json artifact");
    } else if (arg === "--lab-url") {
      labUrl = argv[++i];
      if (!labUrl) bail("--lab-url needs a URL");
    } else if (arg === "--scenario") {
      scenarioId = argv[++i];
      const scenario = scenarioId ? scenarioById(scenarioId) : undefined;
      if (!scenario) bail(`Unknown scenario "${scenarioId}". See packages/shared/src/scenarios.ts`);
      seed = scenario.seed;
      chaos = [...scenario.chaos];
    } else {
      bail(`Unknown flag "${arg}"`);
    }
  }
  return {
    engine,
    env,
    seed,
    chaos,
    pages,
    headed,
    ...(scenarioId ? { scenarioId } : {}),
    ...(labUrl ? { labUrl } : {}),
    noRepair,
    ...(seedCacheFile ? { seedCacheFile } : {})
  };
}

/** Ask the OS for a free ephemeral port on the loopback interface. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free ephemeral port")));
      }
    });
  });
}

/**
 * Spawn a PRIVATE lab child bound to `port` (Wave E 8a + 8k). Portable spawn:
 * runs the repo's OWN tsx through the current Node instead of a machine-specific
 * global pnpm path. `node_modules/.bin/tsx` is pnpm's shim whose target is
 * `tsx/dist/cli.mjs`; invoking that target via `process.execPath` means the
 * child depends on nothing on PATH. (Windows caveat: the .bin entry there is
 * `tsx.CMD`, but running `cli.mjs` through `process.execPath` works the same.)
 */
function spawnPrivateLab(port: number): ChildProcess {
  const tsxCli = path.resolve(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
  return spawn(process.execPath, [tsxCli, "apps/lab/src/server.ts"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
    env: { ...process.env, LAB_PORT: String(port) }
  });
}

/** Kill a child and confirm it actually exited (Wave E 8a: verify death). */
async function killAndVerify(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2000))]);
  }
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve the lab: caller-owned (--lab-url) or a private, exclusive child.
  let labUrl: string;
  let labChild: ChildProcess | null = null;
  if (args.labUrl) {
    labUrl = args.labUrl;
    console.warn(
      `--lab-url ${labUrl}: using a CALLER-OWNED lab; this run will not spawn or manage it.`
    );
  } else {
    const port = await pickFreePort();
    labUrl = `http://127.0.0.1:${port}`;
    console.log(`Starting a private lab on ${labUrl} (exclusive to this run)...`);
    labChild = spawnPrivateLab(port);
    await new LabClient(labUrl).waitUntilReady(20_000);
  }
  const lab = new LabClient(labUrl);

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
      ...(args.noRepair ? { disableRepair: true } : {}),
      ...(args.seedCacheFile ? { seedCacheFile: args.seedCacheFile } : {})
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
    if (labChild) await killAndVerify(labChild);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
