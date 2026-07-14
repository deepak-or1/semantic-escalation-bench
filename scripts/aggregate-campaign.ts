/**
 * Cross-run campaign aggregation (Wave E 8i).
 *
 *   pnpm campaign:aggregate <benchDir...> [--out-dir <dir>]
 *
 * Reads each bench directory's results.json and aggregates per (scenario ×
 * engine): raw outcome + class counts, accuracy values, duration median/min–max,
 * llmCalls + token sums and medians, heal rates, and retry recoveries. Writes
 * campaign-report.json + campaign-report.md to --out-dir (default: cwd).
 *
 * Pure file-reading — no lab, no browser. Aggregation logic lives in
 * packages/agent/src/reliability/campaign.ts and is unit-tested there.
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BenchmarkResultsSchema,
  readJson,
  writeJson,
  type BenchmarkResults
} from "@ssda/shared";
import { aggregateCampaign, renderCampaignMarkdown } from "@ssda/agent";

function bail(message: string): never {
  console.error(message);
  process.exit(1);
}

interface Args {
  benchDirs: string[];
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const benchDirs: string[] = [];
  let outDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || arg === "--") continue;
    if (arg === "--out-dir") {
      outDir = argv[++i];
      if (!outDir) bail("--out-dir needs a path");
    } else if (!arg.startsWith("--")) {
      benchDirs.push(arg);
    } else {
      bail(`Unexpected flag "${arg}". Usage: pnpm campaign:aggregate <benchDir...> [--out-dir <dir>]`);
    }
  }
  if (benchDirs.length === 0) {
    bail("Usage: pnpm campaign:aggregate <benchDir...> [--out-dir <dir>]");
  }
  return {
    benchDirs: benchDirs.map((d) => path.resolve(d)),
    outDir: outDir ? path.resolve(outDir) : process.cwd()
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const runs: BenchmarkResults[] = [];
  for (const dir of args.benchDirs) {
    const file = path.join(dir, "results.json");
    if (!existsSync(file)) bail(`No results.json at ${file}`);
    const parsed = BenchmarkResultsSchema.safeParse(await readJson<unknown>(file));
    if (!parsed.success) bail(`results.json at ${file} did not parse under BenchmarkResultsSchema`);
    runs.push(parsed.data);
  }

  const report = aggregateCampaign(runs, { sources: args.benchDirs });
  const jsonOut = path.join(args.outDir, "campaign-report.json");
  const mdOut = path.join(args.outDir, "campaign-report.md");
  await writeJson(jsonOut, report);
  await writeFile(mdOut, renderCampaignMarkdown(report), "utf8");

  console.log(`Aggregated ${runs.length} run(s), ${report.cells.length} scenario×engine cell(s).`);
  console.log(`campaign-report.json : ${jsonOut}`);
  console.log(`campaign-report.md   : ${mdOut}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
