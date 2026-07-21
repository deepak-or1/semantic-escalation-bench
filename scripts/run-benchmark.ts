/**
 * Run the reliability benchmark across the scenario catalog and the engines.
 *
 *   pnpm bench                                   # all 24 scenarios, all engines
 *   pnpm bench -- --engines baseline             # baseline only
 *   pnpm bench -- --trials 3                      # 3 trials per scenario/engine
 *   pnpm bench -- --scenarios clean-extraction,class-drift --headed
 *   pnpm bench -- --scenario-suite data/phase2a/scenario-suite.json  # held-out suite (§5 item 4)
 *   pnpm bench -- --scenario-suite <suite.json> --only f2-l1-a,f2-l1-b  # reproduce single cells
 *   pnpm bench -- --engines hybrid --no-repair            # policy B (== --repair-mode off)
 *   pnpm bench -- --engines hybrid --repair-mode deterministic  # policy B2 (deterministic ladder)
 *   pnpm bench -- --engines hybrid --repair-mode llm      # policy C (default; key-gated LLM repair)
 *   pnpm bench -- --seed-cache-manifest heals.json --purpose persistence
 *   pnpm bench -- --purpose smoke                 # smoke run (never evidence)
 *
 * --purpose <smoke|cold|persistence|warm> records why the run exists so evidence
 * separation is machine-enforced. It defaults to "cold" for an unseeded run and
 * is REQUIRED when a seed cache is present (persistence vs. warm must be explicit).
 *
 * --only <ids> (comma-separated) is valid ONLY with --scenario-suite: it filters
 * the loaded held-out suite down to the named scenarios for single-cell
 * reproduction, WITHOUT changing the stamped suite provenance (protocolId +
 * suiteHash still identify the whole suite). A filtered run can never satisfy
 * campaign completeness — the generic verifier (scripts/verify-suite.ts) enforces
 * the full grid — so --only is a debugging/repro aid, never a campaign sweep.
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
import { spawnSync, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killAndVerify, pickFreePort, spawnPrivateLab } from "./labControl";
import {
  ENGINES,
  LabClient,
  SCENARIOS,
  createRunDir,
  loadScenarioSuite,
  scenarioById,
  suiteScenarioToSpec,
  type EngineName,
  type RepairMode,
  type RunPurpose,
  type ScenarioSpec
} from "@ssda/shared";
import { loadAndVerifySeedCacheManifest, runBenchmark, validateRunPurpose } from "@ssda/agent";

const RUN_PURPOSES = ["smoke", "cold", "persistence", "warm"] as const;
const REPAIR_MODES = ["off", "deterministic", "llm"] as const;

export interface CliArgs {
  engines: EngineName[];
  trials: number;
  scenarios: ScenarioSpec[];
  headless: boolean;
  /** Caller-owned lab URL (--lab-url); when unset, a private lab is spawned. */
  labUrl?: string;
  /**
   * The hybrid engine's resolved repair dispatch (--repair-mode, default "llm").
   * --no-repair is the frozen alias of --repair-mode off; passing both is an error.
   */
  repairMode: RepairMode;
  /** Warm-start the hybrid cache from a healed-cache.json artifact (--seed-cache). */
  seedCacheFile?: string;
  /** Per-scenario warm-cache manifest (--seed-cache-manifest). */
  seedCacheManifestFile?: string;
  /**
   * Why this run exists (--purpose). Resolved to "cold" for an unseeded run when
   * omitted; required (no default) when a seed cache is present so a seeded run
   * can never blend persistence with the warm sweep.
   */
  purpose: RunPurpose;
  /**
   * Held-out scenario-suite provenance (--scenario-suite, PROTOCOL_2A §5 items
   * 4/6). Set only when a suite file is loaded: the suite's protocolId and the
   * SHA-256 of its raw bytes, both stamped on the run's environment. Absent for a
   * built-in Phase-1 catalog run (the runner then stamps "phase1-catalog").
   */
  protocolId?: string;
  suiteHash?: string;
}

function bail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function parseArgs(argv: string[]): CliArgs {
  let engines: EngineName[] = ["stagehand", "baseline", "hybrid"];
  let trials = 1;
  let scenarios: ScenarioSpec[] = SCENARIOS;
  let scenariosFlagSeen = false;
  let scenarioSuiteFile: string | undefined;
  let onlyIds: string[] | undefined;
  let headless = true;
  let labUrl: string | undefined;
  let noRepair = false;
  let repairMode: RepairMode | undefined;
  let repairModeSeen = false;
  let seedCacheFile: string | undefined;
  let seedCacheManifestFile: string | undefined;
  let purpose: RunPurpose | undefined;

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
      scenariosFlagSeen = true;
      scenarios = ids.map((id) => {
        const found = scenarioById(id);
        if (!found) bail(`Unknown scenario "${id}". See packages/shared/src/scenarios.ts`);
        return found;
      });
    } else if (arg === "--scenario-suite") {
      scenarioSuiteFile = argv[++i];
      if (!scenarioSuiteFile) bail("--scenario-suite needs a path to a scenario-suite JSON");
    } else if (arg === "--only") {
      const ids = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) bail("--only must list at least one scenario id");
      onlyIds = ids;
    } else if (arg === "--headed") {
      headless = false;
    } else if (arg === "--no-repair") {
      noRepair = true;
    } else if (arg === "--repair-mode") {
      const raw = argv[++i];
      if (!raw || !(REPAIR_MODES as readonly string[]).includes(raw)) {
        bail(`--repair-mode must be one of: ${REPAIR_MODES.join(", ")}`);
      }
      repairMode = raw as RepairMode;
      repairModeSeen = true;
    } else if (arg === "--seed-cache") {
      seedCacheFile = argv[++i];
      if (!seedCacheFile) bail("--seed-cache needs a path to a healed-cache.json artifact");
    } else if (arg === "--seed-cache-manifest") {
      seedCacheManifestFile = argv[++i];
      if (!seedCacheManifestFile) bail("--seed-cache-manifest needs a path to a manifest.json");
    } else if (arg === "--purpose") {
      const raw = argv[++i];
      if (!raw || !(RUN_PURPOSES as readonly string[]).includes(raw)) {
        bail(`--purpose must be one of: ${RUN_PURPOSES.join(", ")}`);
      }
      purpose = raw as RunPurpose;
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

  // --scenario-suite loads a validated, hash-verified held-out suite and runs it
  // INSTEAD of the built-in catalog (PROTOCOL_2A §5 item 4). It is mutually
  // exclusive with --scenarios (which selects built-in catalog ids), and it
  // supplies the protocolId + file-bytes suiteHash the runner stamps.
  let protocolId: string | undefined;
  let suiteHash: string | undefined;
  if (scenarioSuiteFile) {
    if (scenariosFlagSeen) {
      bail("--scenario-suite and --scenarios are mutually exclusive");
    }
    try {
      const suite = loadScenarioSuite(path.resolve(scenarioSuiteFile));
      scenarios = suite.scenarios.map(suiteScenarioToSpec);
      protocolId = suite.protocolId;
      suiteHash = suite.suiteHash;
    } catch (error) {
      bail(error instanceof Error ? error.message : String(error));
    }
  }

  // --only <ids> selects single cells from a loaded suite for reproduction. It is
  // valid ONLY with --scenario-suite (the ids name held-out scenarios), and it
  // leaves protocolId/suiteHash UNCHANGED — the stamp still identifies the whole
  // suite, so a filtered run is transparently incomplete against the frozen grid.
  if (onlyIds !== undefined) {
    if (!scenarioSuiteFile) {
      bail(
        "--only is valid only together with --scenario-suite: it selects ids from a " +
          "held-out suite. A filtered run can never satisfy campaign completeness — " +
          "the verifier enforces the full grid."
      );
    }
    const bySuiteId = new Map(scenarios.map((s) => [s.id, s]));
    const filtered: ScenarioSpec[] = [];
    for (const id of onlyIds) {
      const found = bySuiteId.get(id);
      if (!found) {
        bail(
          `--only: unknown scenario id "${id}" for this suite. Valid ids: ${[...bySuiteId.keys()].join(", ")}`
        );
      }
      filtered.push(found);
    }
    scenarios = filtered;
  }

  // --no-repair is the frozen alias of --repair-mode off; passing BOTH is an error
  // (a scenario must state its repair dispatch exactly once). Resolve to the
  // canonical RepairMode: --no-repair → "off", else --repair-mode, else "llm".
  if (noRepair && repairModeSeen) {
    bail(
      "--no-repair and --repair-mode are mutually exclusive: --no-repair is the " +
        "frozen alias of --repair-mode off."
    );
  }
  const resolvedRepairMode: RepairMode = noRepair ? "off" : repairMode ?? "llm";

  // Resolve the run purpose and fail fast on an illegal purpose × seeding combo,
  // BEFORE any lab is spawned. A seeded run must state its purpose explicitly so
  // persistence runs never blend with the warm economics sweep; an unseeded run
  // defaults to "cold".
  const seedCacheMode: "none" | "file" | "manifest" = seedCacheManifestFile
    ? "manifest"
    : seedCacheFile
      ? "file"
      : "none";
  if (purpose === undefined) {
    if (seedCacheMode !== "none") {
      bail(
        "--purpose is required when seeding a cache (--seed-cache / --seed-cache-manifest): " +
          "pass --purpose persistence or --purpose warm so a seeded run is never mislabelled."
      );
    }
    purpose = "cold";
  }
  try {
    validateRunPurpose(purpose, seedCacheMode);
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
  }

  return {
    engines,
    trials,
    scenarios,
    headless,
    ...(labUrl ? { labUrl } : {}),
    repairMode: resolvedRepairMode,
    ...(seedCacheFile ? { seedCacheFile } : {}),
    ...(seedCacheManifestFile ? { seedCacheManifestFile } : {}),
    purpose,
    ...(protocolId !== undefined ? { protocolId } : {}),
    ...(suiteHash !== undefined ? { suiteHash } : {})
  };
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
      runPurpose: args.purpose,
      repairMode: args.repairMode,
      ...(args.protocolId !== undefined ? { protocolId: args.protocolId } : {}),
      ...(args.suiteHash !== undefined ? { suiteHash: args.suiteHash } : {}),
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

// Only auto-run when this file is the process entrypoint (e.g. `tsx
// scripts/run-benchmark.ts`), so tests can import `parseArgs` without spawning a
// lab and running a benchmark.
const isEntrypoint =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
