/**
 * Seed / inspect the flaky lab.
 *
 *   pnpm seed                        # push seed+chaos from .env to a running lab
 *   pnpm seed -- --seed 1101         # specific seed
 *   pnpm seed -- --chaos modal,classDrift
 *   pnpm seed -- --preview           # no lab needed: print generated data locally
 */
import "dotenv/config";
import {
  CHAOS_FLAGS,
  ChaosFlagSchema,
  DEFAULT_SEED,
  generateGroundTruth,
  LabClient,
  labBaseUrl,
  type ChaosFlag,
  type GroundTruth
} from "@ssda/shared";

function parseArgs(argv: string[]): { seed: number; chaos: ChaosFlag[]; preview: boolean } {
  let seed = Number.parseInt(process.env.LAB_SEED ?? "", 10);
  if (!Number.isFinite(seed)) seed = DEFAULT_SEED;
  const chaos: ChaosFlag[] = [];
  let preview = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--seed") seed = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--chaos") {
      for (const raw of (argv[++i] ?? "").split(",").filter(Boolean)) {
        const parsed = ChaosFlagSchema.safeParse(raw);
        if (!parsed.success) {
          console.error(`Unknown chaos flag "${raw}". Valid: ${CHAOS_FLAGS.join(", ")}`);
          process.exit(1);
        }
        chaos.push(parsed.data);
      }
    } else if (arg === "--preview") preview = true;
  }
  if (!Number.isFinite(seed)) {
    console.error("Invalid --seed");
    process.exit(1);
  }
  return { seed, chaos, preview };
}

function printSummary(truth: GroundTruth): void {
  console.log(`\n${truth.league.name} ${truth.league.season} (seed ${truth.seed})\n`);
  console.log("Pos Team                 P   W  D  L   GF  GA  Pts Form");
  truth.teams.forEach((t, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. ${t.name.padEnd(20)} ${String(t.played).padStart(2)}  ` +
        `${String(t.wins).padStart(2)} ${String(t.draws).padStart(2)} ${String(t.losses).padStart(2)}  ` +
        `${String(t.goalsFor).padStart(3)} ${String(t.goalsAgainst).padStart(3)}  ` +
        `${String(t.points).padStart(3)} ${t.form}`
    );
  });
  console.log("\nUpcoming fixtures (decimal odds H/D/A, O/U 2.5):");
  for (const m of truth.markets) {
    console.log(
      `  ${m.homeTeam} vs ${m.awayTeam}  ` +
        `${m.oneXTwo.home.toFixed(2)}/${m.oneXTwo.draw.toFixed(2)}/${m.oneXTwo.away.toFixed(2)}  ` +
        `O ${m.totals.over.toFixed(2)} / U ${m.totals.under.toFixed(2)}`
    );
  }
  console.log("");
}

async function main(): Promise<void> {
  const { seed, chaos, preview } = parseArgs(process.argv.slice(2));

  if (preview) {
    printSummary(generateGroundTruth(seed));
    return;
  }

  const lab = new LabClient(labBaseUrl());
  if (!(await lab.health())) {
    console.error(
      `Lab at ${labBaseUrl()} is not running (start it with: pnpm dev:lab).\n` +
        `Use --preview to inspect generated data without a lab.`
    );
    process.exit(1);
  }
  const state = await lab.configure({ seed, chaos });
  console.log(`Lab configured: seed=${state.seed} chaos=[${state.chaos.join(", ")}]`);
  const { truth } = await lab.groundTruth();
  printSummary(truth);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
