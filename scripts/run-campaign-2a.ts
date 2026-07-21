/**
 * Phase-2A campaign driver — I/O shell (PROTOCOL_2A §7/§8). The pure state machine,
 * frozen schedule, and budget rule live in packages/agent/src/reliability/
 * campaignDriver.ts (runCampaign); this file only wires real effects into it:
 * loading the suite, spawning a private lab per entry, calling the real
 * runBenchmark, and persisting the campaign state atomically after every trial.
 *
 *   pnpm campaign:2a --suite <scenario-suite.json> --phase keyless
 *   pnpm campaign:2a --suite <scenario-suite.json> --phase keyed [--keyless-state <file>]
 *
 * Each phase defaults to its OWN state file — runs/phase2a/campaign-state.<phase>.json
 * (keyless → …-state.keyless.json, keyed → …-state.keyed.json) — so the keyless and
 * keyed ledgers never collide (the two phases have different schedules). Override with
 * --state <file> if needed.
 *
 * Resume is automatic: re-running the same command continues from the first
 * schedule entry not yet complete (the state file is the resume ledger).
 *
 * Key discipline (machine-enforced, §8): the keyless grid MUST complete before any
 * key exists, so --phase keyless refuses to run when a model provider key is
 * present; --phase keyed refuses to run when none is.
 *
 * §8 gate 3 (machine-enforced): --phase keyed additionally refuses to START until the
 * keyless A/B/B2 grid is COMPLETE and passes the frozen suite verifier. Before loading
 * any keyed state (and after the pinned-model pre-flight), it reads the keyless campaign
 * state — default runs/phase2a/campaign-state.keyless.json, overridable with
 * --keyless-state <file> (keyed phase only) — checks it is a complete, schedule-ordered
 * keyless grid, and re-runs the verify:suite core over its recorded run dirs; any gap,
 * corruption, or verification violation bails with a usage error (exit 2). The keyed
 * state's own freshness (loadOrInitState) is checked only after this gate passes.
 *
 * The budget ($39.90, frozen in the driver — NOT a flag) halts the campaign
 * pre-trial; a halted campaign is preserved evidence and exits with a distinct
 * code (3) so automation can tell a budget stop from a crash (1).
 */
import "dotenv/config";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LabClient,
  createRunDir,
  loadScenarioSuite,
  suiteScenarioToSpec,
  type LoadedScenarioSuite,
  type ScenarioSpec
} from "@ssda/shared";
import {
  CampaignStateSchema,
  PINNED_PRICES,
  buildSchedule,
  initCampaignState,
  loadAgentEnvConfig,
  nextEntry,
  runBenchmark,
  runCampaign,
  type CampaignEntry,
  assertStateMatches,
  type CampaignPhase,
  type CampaignState,
  type EntryRunContext
} from "@ssda/agent";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { verifySuite, type VerifyInput, type ExpectGrid } from "./verify-suite";
import { killAndVerify, pickFreePort, spawnPrivateLab } from "./labControl";

/** The per-phase default state file — keyless and keyed never share a ledger (FIX 5). */
function defaultStateFile(phase: CampaignPhase): string {
  return `runs/phase2a/campaign-state.${phase}.json`;
}
const PHASES: readonly CampaignPhase[] = ["keyless", "keyed"];

const USAGE =
  "Usage: pnpm campaign:2a --suite <scenario-suite.json> --phase <keyless|keyed> " +
  "[--state <file>] [--keyless-state <file> (keyed phase only — the §8 gate-3 keyless ledger)]";

function bail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2); // 2 = usage error (distinct from a budget stop (3) or a crash (1))
}

export interface CampaignCliArgs {
  suiteFile: string;
  phase: CampaignPhase;
  stateFile: string;
  /** The keyless ledger the §8 gate-3 check reads for --phase keyed (keyed only). */
  keylessStateFile: string;
}

export function parseCampaignArgs(argv: string[]): CampaignCliArgs {
  let suiteFile: string | undefined;
  let phase: CampaignPhase | undefined;
  let stateFile: string | undefined;
  let keylessStateFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--suite") {
      suiteFile = argv[++i];
      if (!suiteFile) bail("--suite needs a path to a scenario-suite JSON");
    } else if (arg === "--phase") {
      const raw = argv[++i];
      if (!raw || !(PHASES as readonly string[]).includes(raw)) {
        bail(`--phase must be one of: ${PHASES.join(", ")}`);
      }
      phase = raw as CampaignPhase;
    } else if (arg === "--state") {
      stateFile = argv[++i];
      if (!stateFile) bail("--state needs a path to a campaign-state JSON");
    } else if (arg === "--keyless-state") {
      keylessStateFile = argv[++i];
      if (!keylessStateFile) bail("--keyless-state needs a path to the keyless campaign-state JSON");
    } else {
      bail(`Unknown flag "${arg}"`);
    }
  }
  if (!suiteFile) bail("--suite is required");
  if (!phase) bail("--phase is required");
  // --keyless-state is the §8 gate-3 ledger for the keyed phase only; it is meaningless
  // (and a likely operator mistake) alongside --phase keyless, which HAS no prerequisite.
  if (keylessStateFile !== undefined && phase === "keyless") {
    bail("--keyless-state only applies to --phase keyed");
  }
  return {
    suiteFile: path.resolve(suiteFile),
    phase,
    stateFile: path.resolve(stateFile ?? defaultStateFile(phase)),
    keylessStateFile: path.resolve(keylessStateFile ?? defaultStateFile("keyless"))
  };
}

/** Atomically persist the campaign state (write a tmp file, then rename over it). */
async function writeStateAtomic(stateFile: string, state: CampaignState): Promise<void> {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(tmp, stateFile);
}

/**
 * Load an existing campaign state (zod-validated) and REFUSE if it belongs to a
 * different suite OR records entries from a different phase (per-phase state files,
 * FIX 5), or initialise a fresh state from the suite's provenance. The suite/phase
 * refusals are the pure, unit-tested assertStateMatches.
 */
function loadOrInitState(stateFile: string, suite: LoadedScenarioSuite, phase: CampaignPhase): CampaignState {
  if (!existsSync(stateFile)) {
    return initCampaignState(suite.protocolId, suite.suiteHash);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (error) {
    bail(`campaign state at ${stateFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = CampaignStateSchema.safeParse(raw);
  if (!parsed.success) {
    bail(
      `campaign state at ${stateFile} failed validation: ${parsed.error.issues
        .slice(0, 3)
        .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ")}`
    );
  }
  try {
    assertStateMatches(parsed.data, suite, phase);
  } catch (error) {
    bail(`campaign state at ${stateFile} ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed.data;
}

/** Enforce the §8 key discipline for the phase (bails on violation). */
function enforceKeyDiscipline(phase: CampaignPhase): void {
  const hasKey = loadAgentEnvConfig().modelProvider !== null;
  if (phase === "keyless" && hasKey) {
    bail(
      "--phase keyless refuses to run while a model provider key is present: the " +
        "keyless grid must complete before any key exists (PROTOCOL_2A §8)."
    );
  }
  if (phase === "keyed" && !hasKey) {
    bail(
      "--phase keyed refuses to run without a model provider key: set ANTHROPIC_API_KEY " +
        "or OPENAI_API_KEY (PROTOCOL_2A §8)."
    );
  }
}

/**
 * PROTOCOL_2A §8 gate 3 (machine-enforced): the keyless A/B/B2 grid must be COMPLETE
 * and VERIFIER-PASSED before any keyed trial may run. Throws a descriptive Error on
 * any failure; returns void only when the keyless phase is a complete, schedule-ordered
 * grid whose recorded runs pass the frozen suite verifier. `verify` defaults to the real
 * verifySuite and is injectable ONLY so unit tests can stub the expensive verification
 * path — every state-machine check below always runs the real frozen code.
 */
export function keyedPhaseGate(
  keylessStateRaw: unknown,
  suite: LoadedScenarioSuite,
  readRunInput: (dir: string) => VerifyInput,
  verify: typeof verifySuite = verifySuite
): void {
  // (a) The keyless ledger must validate as a campaign state.
  const parsed = CampaignStateSchema.safeParse(keylessStateRaw);
  if (!parsed.success) {
    throw new Error(
      `keyless campaign state failed validation: ${parsed.error.issues
        .slice(0, 3)
        .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ")}`
    );
  }
  const state = parsed.data;

  // (b) It must belong to THIS suite and record only keyless-phase entries.
  try {
    assertStateMatches(state, suite, "keyless");
  } catch (error) {
    throw new Error(`keyless campaign state ${error instanceof Error ? error.message : String(error)}`);
  }

  // (c) It must be a COMPLETE prefix of the frozen keyless schedule (all entries done).
  // nextEntry throws on a corrupt/out-of-order prefix and returns the next unfinished
  // entry when the grid is merely incomplete.
  const schedule = buildSchedule("keyless");
  let next: CampaignEntry | null;
  try {
    next = nextEntry(state, schedule);
  } catch (error) {
    throw new Error(
      `keyless campaign state is not a valid schedule prefix: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (next !== null) {
    const completed = state.entries.filter((e) => e.status === "complete").length;
    throw new Error(
      `keyless grid incomplete — next unfinished entry is ${next.phase}/sweep-${next.sweep}/${next.policy}, ` +
        `${completed}/${schedule.length} entries complete; the keyed phase refuses to start before the ` +
        `keyless grid is complete and verified (PROTOCOL_2A §8 gate 3)`
    );
  }

  // (d) Derive the expect-grid FROM THE SCHEDULE (never hard-coded): the policies in
  // first-appearance order, each contributing the same number of sweeps (its trial count).
  const policies: CampaignEntry["policy"][] = [];
  const counts = new Map<CampaignEntry["policy"], number>();
  for (const e of schedule) {
    counts.set(e.policy, (counts.get(e.policy) ?? 0) + 1);
    if (!policies.includes(e.policy)) policies.push(e.policy);
  }
  const first = policies[0];
  if (first === undefined) {
    throw new Error("keyless schedule is empty — cannot derive an expect-grid (internal invariant)");
  }
  const trials = counts.get(first)!;
  for (const p of policies) {
    const c = counts.get(p)!;
    if (c !== trials) {
      throw new Error(
        `keyless schedule is not rectangular: policy ${p} has ${c} entries but policy ${first} has ${trials} — ` +
          `cannot derive an expect-grid (internal invariant)`
      );
    }
  }
  const expectGrid: ExpectGrid = { policies: policies as ExpectGrid["policies"], trials };

  // (e) Read each recorded run's results.json. The reader propagates its own throw
  // (naming the dir) on a missing/unreadable file — the keyless ledger points at run
  // dirs that must still exist for the grid to be re-verifiable.
  const inputs = state.entries.map((e) => readRunInput(e.dir));

  // (f) The recorded grid must pass the FROZEN suite verifier exactly.
  const report = verify(inputs, suite, expectGrid);
  if (!report.ok) {
    const firstMessages = report.violations.slice(0, 5).map((v) => `\n  - ${v.message}`).join("");
    const dirs = state.entries.map((e) => e.dir).join(" ");
    throw new Error(
      `keyless grid failed suite verification (${report.violations.length} violation(s)) — first messages:${firstMessages}; ` +
        `run pnpm verify:suite ${dirs} --suite <suite-file> --expect-policies ${expectGrid.policies.join(",")} ` +
        `--expect-trials ${expectGrid.trials} for the full report; the keyed phase refuses to start (PROTOCOL_2A §8 gate 3)`
    );
  }
}

/** Spawn a private lab + run dir for one entry; dispose kills the lab. */
async function prepareRun(entry: CampaignEntry): Promise<EntryRunContext> {
  const port = await pickFreePort();
  const labUrl = `http://127.0.0.1:${port}`;
  const child = spawnPrivateLab(port);
  // FIX 1 — everything after the spawn can throw (waitUntilReady timeout, createRunDir
  // error). On any failure, kill the just-spawned lab before rethrowing so a failed
  // prepareRun never leaks a lab child; the driver then records the entry as crashed.
  try {
    await new LabClient(labUrl).waitUntilReady(20_000);
    const { runId, dir } = await createRunDir({
      kind: "bench",
      labUrl,
      description: `phase2a ${entry.phase} sweep-${entry.sweep} ${entry.policy}`
    });
    return { labUrl, benchDir: dir, benchId: runId, dispose: () => killAndVerify(child) };
  } catch (error) {
    await killAndVerify(child);
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseCampaignArgs(process.argv.slice(2));

  let suite: LoadedScenarioSuite;
  try {
    suite = loadScenarioSuite(args.suiteFile);
  } catch (error) {
    bail(`Could not load --suite ${args.suiteFile}: ${error instanceof Error ? error.message : String(error)}`);
  }

  enforceKeyDiscipline(args.phase);

  // FIX 4 — keyed-phase pinned-model pre-flight. Refuse BEFORE any real spend if the
  // pricing model is not in the pinned price table: otherwise the first keyed trial
  // would execute, spend real money, and only then die unpriceable. The
  // UnpriceableTrialError path in the driver stays as defense-in-depth.
  if (args.phase === "keyed") {
    const pricingModel = loadAgentEnvConfig().stagehandModel;
    const pinned = Object.keys(PINNED_PRICES);
    if (!pricingModel || !pinned.includes(pricingModel)) {
      bail(
        `--phase keyed refuses to run: pricing model ${pricingModel ?? "(none)"} is not in the ` +
          `pinned price table, so keyed spend cannot be enforced against the budget. ` +
          `Pinned models: ${pinned.join(", ")}. Set STAGEHAND_MODEL to a pinned model (PROTOCOL_2A §7).`
      );
    }

    // §8 gate 3 (machine-enforced) — the keyless A/B/B2 grid must be COMPLETE AND
    // verifier-passed before any keyed trial. Enforced here, after the pinned-model
    // pre-flight and before any keyed state is loaded or lab spawned.
    if (!existsSync(args.keylessStateFile)) {
      bail(
        `--phase keyed refuses to run: no keyless campaign state at ${args.keylessStateFile} — the ` +
          `keyless grid must be complete and verifier-passed first (PROTOCOL_2A §8 gate 3); pass ` +
          `--keyless-state if it lives elsewhere.`
      );
    }
    let keylessRaw: unknown;
    try {
      keylessRaw = JSON.parse(readFileSync(args.keylessStateFile, "utf8"));
    } catch (error) {
      bail(
        `keyless campaign state at ${args.keylessStateFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const reader = (dir: string): VerifyInput => {
      const file = path.join(dir, "results.json");
      if (!existsSync(file)) {
        throw new Error(`no results.json at ${file} (recorded keyless run dir moved or deleted?)`);
      }
      return { source: path.relative(process.cwd(), file), raw: JSON.parse(readFileSync(file, "utf8")) };
    };
    try {
      keyedPhaseGate(keylessRaw, suite!, reader);
    } catch (error) {
      bail(error instanceof Error ? error.message : String(error));
    }
  }

  const state = loadOrInitState(args.stateFile, suite!, args.phase);
  await writeStateAtomic(args.stateFile, state); // materialise a fresh state up front

  const schedule = buildSchedule(args.phase);
  const scenarios: ScenarioSpec[] = suite!.scenarios.map(suiteScenarioToSpec);
  const model = loadAgentEnvConfig().stagehandModel;

  console.log(
    `Phase-2A ${args.phase} campaign: ${schedule.length} scheduled entrie(s) over ` +
      `${scenarios.length} scenario(s); state ${args.stateFile}; threshold $${state.thresholdUsd.toFixed(2)}\n`
  );

  let outcome;
  try {
    outcome = await runCampaign(state, {
      schedule,
      scenarios,
      model,
      headless: true,
      runBenchmark,
      prepareRun,
      persist: (s) => writeStateAtomic(args.stateFile, s),
      log: (line) => console.log(line)
    });
  } catch (error) {
    // The only throw that escapes runCampaign is a fatal resume/rerun error from
    // nextEntry (out-of-order/corrupt state, or a sweep that crashed a second time):
    // it is raised at the top of the loop, before any lab is spawned for the offending
    // position and without mutating state, so the persisted ledger stays the untouched
    // resume evidence. A prepareRun/runBenchmark failure no longer reaches here — it is
    // recorded as a "crashed" entry and returned as a crashed outcome (handled below),
    // with its lab killed.
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (outcome.kind === "stopped") {
    console.error(
      `\nCampaign STOPPED (budget): ${outcome.reason}\n` +
        `State preserved at ${args.stateFile}. The grid is INCOMPLETE and supports no ` +
        `frontier claims (PROTOCOL_2A §7). Resume by re-running this command.`
    );
    process.exit(3); // 3 = budget stop (distinct from crash 1 / usage 2)
  }
  if (outcome.kind === "crashed") {
    console.error(
      `\nCampaign CRASHED at ${outcome.entry.phase} sweep-${outcome.entry.sweep} ` +
        `${outcome.entry.policy}: ${outcome.error.message}\n` +
        `Lab killed, state preserved at ${args.stateFile} (the crashed sweep will rerun once).`
    );
    process.exit(1);
  }

  console.log(`\nCampaign COMPLETE: all ${schedule.length} entrie(s) ran. State at ${args.stateFile}.`);
  process.exit(0);
}

const isEntrypoint =
  !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  });
}
