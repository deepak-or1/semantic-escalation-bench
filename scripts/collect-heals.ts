/**
 * Collect the healed selector caches a benchmark run produced into a
 * --seed-cache-manifest (Wave E 8h).
 *
 *   pnpm heals:collect <benchDir> [--out <manifest.json>]
 *
 * Scans <benchDir>/results.json for trials that healed at least one step, finds
 * the healed-cache.json artifact each wrote, and emits a manifest mapping every
 * such scenario to its cache file plus provenance (benchId, healedSteps,
 * createdAt). Feed the manifest to `pnpm bench -- --seed-cache-manifest <file>`
 * to replay those repairs deterministically (zero model) in a later run.
 *
 * Pure file-reading — no lab, no browser.
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import { BenchmarkResultsSchema, readJson, writeJson } from "@ssda/shared";

function bail(message: string): never {
  console.error(message);
  process.exit(1);
}

interface Args {
  benchDir: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  let benchDir: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === "--") continue;
    if (arg === "--out") {
      out = argv[++i];
      if (!out) bail("--out needs a path");
    } else if (!arg.startsWith("--") && !benchDir) {
      benchDir = arg;
    } else {
      bail(`Unexpected argument "${arg}". Usage: pnpm heals:collect <benchDir> [--out <manifest.json>]`);
    }
  }
  if (!benchDir) bail("Usage: pnpm heals:collect <benchDir> [--out <manifest.json>]");
  return {
    benchDir: path.resolve(benchDir),
    out: out ? path.resolve(out) : path.join(path.resolve(benchDir), "heals-manifest.json")
  };
}

interface ManifestEntry {
  cacheFile: string;
  provenance: { benchId: string; healedSteps: string[]; createdAt: string };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const resultsFile = path.join(args.benchDir, "results.json");
  if (!existsSync(resultsFile)) bail(`No results.json at ${resultsFile}`);

  const parsed = BenchmarkResultsSchema.safeParse(await readJson<unknown>(resultsFile));
  if (!parsed.success) bail(`results.json at ${resultsFile} did not parse under BenchmarkResultsSchema`);
  const results = parsed.data;

  const scenarios: Record<string, ManifestEntry> = {};
  let found = 0;
  for (const trial of results.trials) {
    if ((trial.healedSteps?.length ?? 0) === 0) continue;
    // Only the first healed trial per scenario is kept (deterministic pick).
    if (scenarios[trial.scenarioId]) continue;
    const cacheFile = path.join(args.benchDir, "trials", trial.runId, "artifacts", "healed-cache.json");
    if (!existsSync(cacheFile)) {
      console.warn(`  (skipping ${trial.scenarioId}/${trial.engine}: no healed-cache.json at ${cacheFile})`);
      continue;
    }
    scenarios[trial.scenarioId] = {
      cacheFile,
      provenance: {
        benchId: results.benchId,
        healedSteps: [...(trial.healedSteps ?? [])],
        createdAt: results.createdAt
      }
    };
    found += 1;
  }

  await writeJson(args.out, { scenarios });
  console.log(`Collected ${found} healed cache(s) from ${resultsFile}`);
  console.log(`Manifest: ${args.out}`);
  if (found === 0) {
    console.log("(No trials healed — the manifest is empty; every scenario will fall back to the bootstrap.)");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
