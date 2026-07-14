/**
 * Run the reliability benchmark across the scenario catalog and the engines.
 *
 *   pnpm bench                                   # all 24 scenarios, all engines
 *   pnpm bench -- --engines baseline             # baseline only
 *   pnpm bench -- --trials 3                      # 3 trials per scenario/engine
 *   pnpm bench -- --scenarios clean-extraction,class-drift --headed
 *   pnpm bench -- --engines hybrid --no-repair    # frozen structural-deterministic
 *
 * The default engine set is all three engines: "stagehand,baseline,hybrid".
 * Stagehand is auto-skipped (reported, never run) when no model key is present;
 * baseline and hybrid always run (hybrid is designed to run keyless).
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ENGINES,
  LabClient,
  SCENARIOS,
  createRunDir,
  labBaseUrl,
  scenarioById,
  type EngineName,
  type ScenarioSpec
} from "@ssda/shared";
import { runBenchmark } from "@ssda/agent";

interface CliArgs {
  engines: EngineName[];
  trials: number;
  scenarios: ScenarioSpec[];
  headless: boolean;
  labUrl: string;
  /** Freeze the hybrid engine's repair path (--no-repair). */
  noRepair: boolean;
}

const PNPM = path.join(os.homedir(), "Library", "pnpm", "pnpm");

function bail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  let engines: EngineName[] = ["stagehand", "baseline", "hybrid"];
  let trials = 1;
  let scenarios: ScenarioSpec[] = SCENARIOS;
  let headless = true;
  let labUrl = labBaseUrl();
  let noRepair = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--engines") {
      const raw = (argv[++i] ?? "").split(",").filter(Boolean);
      if (raw.length === 0) bail("--engines must list at least one engine");
      engines = raw.map((name) => {
        if (!(ENGINES as readonly string[]).includes(name)) {
          bail(`Unknown engine "${name}" (valid: ${ENGINES.join(", ")})`);
        }
        return name as EngineName;
      });
    } else if (arg === "--trials") {
      trials = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(trials) || trials < 1) bail("--trials must be a positive integer");
    } else if (arg === "--scenarios") {
      const ids = (argv[++i] ?? "").split(",").filter(Boolean);
      if (ids.length === 0) bail("--scenarios must list at least one scenario id");
      scenarios = ids.map((id) => {
        const found = scenarioById(id);
        if (!found) bail(`Unknown scenario "${id}". See packages/shared/src/scenarios.ts`);
        return found;
      });
    } else if (arg === "--headed") {
      headless = false;
    } else if (arg === "--no-repair") {
      noRepair = true;
    } else if (arg === "--lab-url") {
      labUrl = argv[++i] ?? labUrl;
    } else {
      bail(`Unknown flag "${arg}"`);
    }
  }
  return { engines, trials, scenarios, headless, labUrl, noRepair };
}

function startLab(labUrl: string): ChildProcess {
  console.log(`Lab not running at ${labUrl} — starting it...`);
  return spawn(PNPM, ["exec", "tsx", "apps/lab/src/server.ts"], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const lab = new LabClient(args.labUrl);

  let labChild: ChildProcess | null = null;
  if (!(await lab.health())) {
    labChild = startLab(args.labUrl);
    await lab.waitUntilReady(20_000);
  }

  let exitCode = 0;
  try {
    const { runId, dir } = await createRunDir({
      kind: "bench",
      labUrl: args.labUrl,
      description: `reliability benchmark (${args.engines.join("+")}, ${args.trials} trial/scenario)`
    });

    console.log(
      `Benchmark ${runId}: ${args.scenarios.length} scenario(s) × ` +
        `[${args.engines.join(", ")}] × ${args.trials} trial(s)\n`
    );

    await runBenchmark({
      labUrl: args.labUrl,
      engines: args.engines,
      scenarios: args.scenarios,
      trialsPerScenario: args.trials,
      headless: args.headless,
      benchDir: dir,
      benchId: runId,
      ...(args.noRepair ? { disableRepair: true } : {}),
      onProgress: (line) => console.log(line)
    });

    const resultsJson = path.resolve(dir, "results.json");
    const resultsMd = path.resolve(dir, "results.md");
    const failuresJsonl = path.resolve(dir, "failures.jsonl");

    console.log("\n" + (await readFile(resultsMd, "utf8")));
    console.log(`results.json : ${resultsJson}`);
    console.log(`results.md   : ${resultsMd}`);
    console.log(`failures     : ${failuresJsonl}`);
    console.log(`\nNext: pnpm report && pnpm dev:dashboard`);
  } catch (error) {
    // Operational crash (lab died, filesystem, etc.). Scenario FAILures never
    // reach here — they are recorded as results and exit 0.
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    exitCode = 1;
  } finally {
    if (labChild) labChild.kill();
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
