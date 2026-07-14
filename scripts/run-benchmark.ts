/**
 * Run the reliability benchmark across the scenario catalog and the engines.
 *
 *   pnpm bench                                   # all 24 scenarios, all engines
 *   pnpm bench -- --engines baseline             # baseline only
 *   pnpm bench -- --trials 3                      # 3 trials per scenario/engine
 *   pnpm bench -- --scenarios clean-extraction,class-drift --headed
 *   pnpm bench -- --engines hybrid --no-repair    # frozen structural-deterministic
 *   pnpm bench -- --seed-cache-manifest heals.json # per-scenario warm caches
 *
 * The default engine set is all three engines: "stagehand,baseline,hybrid".
 * Stagehand is auto-skipped (reported, never run) when no model key is present;
 * baseline and hybrid always run (hybrid is designed to run keyless).
 *
 * LAB OWNERSHIP (Wave E 8a): by default this runner NEVER reuses an existing
 * lab. It spawns a PRIVATE lab child on a free ephemeral port, exclusive to this
 * run, and kills it on exit — so two benches can run concurrently without
 * contaminating each other's trial isolation. Pass `--lab-url <url>` to point at
 * a caller-owned lab instead; then exclusivity is the caller's responsibility.
 */
import "dotenv/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGINES,
  LabClient,
  SCENARIOS,
  createRunDir,
  scenarioById,
  type EngineName,
  type ScenarioSpec
} from "@ssda/shared";
import { loadAndVerifySeedCacheManifest, runBenchmark } from "@ssda/agent";

interface CliArgs {
  engines: EngineName[];
  trials: number;
  scenarios: ScenarioSpec[];
  headless: boolean;
  /** Caller-owned lab URL (--lab-url); when unset, a private lab is spawned. */
  labUrl?: string;
  /** Freeze the hybrid engine's repair path (--no-repair). */
  noRepair: boolean;
  /** Warm-start the hybrid cache from a healed-cache.json artifact (--seed-cache). */
  seedCacheFile?: string;
  /** Per-scenario warm-cache manifest (--seed-cache-manifest). */
  seedCacheManifestFile?: string;
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

function bail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  let engines: EngineName[] = ["stagehand", "baseline", "hybrid"];
  let trials = 1;
  let scenarios: ScenarioSpec[] = SCENARIOS;
  let headless = true;
  let labUrl: string | undefined;
  let noRepair = false;
  let seedCacheFile: string | undefined;
  let seedCacheManifestFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // A bare "--" separator (docs use `pnpm bench -- --engines ...`) is skipped
    // so it never trips the unknown-flag guard (Wave E 8k).
    if (arg === "--") continue;
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
    } else if (arg === "--seed-cache") {
      seedCacheFile = argv[++i];
      if (!seedCacheFile) bail("--seed-cache needs a path to a healed-cache.json artifact");
    } else if (arg === "--seed-cache-manifest") {
      seedCacheManifestFile = argv[++i];
      if (!seedCacheManifestFile) bail("--seed-cache-manifest needs a path to a manifest.json");
    } else if (arg === "--lab-url") {
      labUrl = argv[++i];
      if (!labUrl) bail("--lab-url needs a URL");
    } else {
      bail(`Unknown flag "${arg}"`);
    }
  }
  if (seedCacheFile && seedCacheManifestFile) {
    bail("--seed-cache and --seed-cache-manifest are mutually exclusive");
  }
  return {
    engines,
    trials,
    scenarios,
    headless,
    ...(labUrl ? { labUrl } : {}),
    noRepair,
    ...(seedCacheFile ? { seedCacheFile } : {}),
    ...(seedCacheManifestFile ? { seedCacheManifestFile } : {})
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

// NOTE (Wave E 8a): a previous wave added a "pre-flight" that refused to bench
// whenever ANY `stagehand-v3/profile` chrome process was alive, on the theory
// that leftover browsers from an interrupted run could read pages rendered under
// an earlier scenario's SHARED lab configuration and corrupt trial isolation.
// 8a fixes that at the root — every run now owns a PRIVATE lab on its own
// ephemeral port, so a browser belonging to another (crashed or concurrent) run
// points at a different/dead lab and cannot contaminate this run's trials
// (and --disable-http-cache closes the stale-cache vector). A hard-exit guard
// would also break legitimate concurrency (two benches at once). What remains
// is a WARNING-ONLY census: leftover browsers are logged as a forensic signal
// in every bench log, never a reason to refuse.
function warnLeftoverBrowsers(): void {
  if (process.platform === "win32") return; // POSIX-only, best-effort
  const probe = spawnSync("pgrep", ["-f", "stagehand-v3/profile"], {
    encoding: "utf8"
  });
  const count = (probe.stdout ?? "")
    .split("\n")
    .filter((s) => s.trim().length > 0).length;
  if (count > 0) {
    console.warn(
      `Note: ${count} Stagehand chrome process(es) from other/interrupted runs are alive. ` +
        `This run's private lab and disabled HTTP cache keep trials isolated; ` +
        `logging for forensics only.`
    );
  }
}

async function main(): Promise<void> {
  warnLeftoverBrowsers();
  const args = parseArgs(process.argv.slice(2));

  // Resolve the lab: caller-owned (--lab-url) or a private, exclusive child.
  let labUrl: string;
  let labChild: ChildProcess | null = null;
  if (args.labUrl) {
    labUrl = args.labUrl;
    console.warn(
      `--lab-url ${labUrl}: using a CALLER-OWNED lab; this runner will not spawn or ` +
        `manage it, and trial isolation (no other run sharing it) is your responsibility.`
    );
  } else {
    const port = await pickFreePort();
    labUrl = `http://127.0.0.1:${port}`;
    console.log(`Starting a private lab on ${labUrl} (exclusive to this run)...`);
    labChild = spawnPrivateLab(port);
    await new LabClient(labUrl).waitUntilReady(20_000);
  }

  // Cryptographically verifies every referenced cache before the run trusts it
  // (Wave F F4); supplies the combinedContentHash recorded as seedCacheHash.
  const seedCacheManifest = args.seedCacheManifestFile
    ? await loadAndVerifySeedCacheManifest(args.seedCacheManifestFile)
    : undefined;

  let exitCode = 0;
  try {
    const { runId, dir } = await createRunDir({
      kind: "bench",
      labUrl,
      description: `reliability benchmark (${args.engines.join("+")}, ${args.trials} trial/scenario)`
    });

    console.log(
      `Benchmark ${runId}: ${args.scenarios.length} scenario(s) × ` +
        `[${args.engines.join(", ")}] × ${args.trials} trial(s)\n`
    );

    await runBenchmark({
      labUrl,
      engines: args.engines,
      scenarios: args.scenarios,
      trialsPerScenario: args.trials,
      headless: args.headless,
      benchDir: dir,
      benchId: runId,
      ...(args.noRepair ? { disableRepair: true } : {}),
      ...(args.seedCacheFile ? { seedCacheFile: args.seedCacheFile } : {}),
      ...(seedCacheManifest ? { seedCacheManifest } : {}),
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
    if (labChild) await killAndVerify(labChild);
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
