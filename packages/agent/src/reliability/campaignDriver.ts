/**
 * Phase-2A campaign driver — PURE logic (PROTOCOL_2A §7). This module owns the
 * frozen schedule, the per-policy run config, the budget rule, and the resumable
 * campaign state machine. It performs NO filesystem or child-process I/O: every
 * side effect (spawning a lab, calling the benchmark runner, persisting state) is
 * an injected dependency, so the whole run-loop is unit-testable with a stubbed
 * runner. The I/O shell is scripts/run-campaign-2a.ts.
 *
 * The budget is a FROZEN CONSTANT, never a CLI flag: the protocol fixed $39.90 of
 * model-inference spend as the operational stop threshold, checked PRE-TRIAL
 * (before each trial the driver has priced all recorded tokens so far and starts
 * the trial only if spend is still under the threshold). The final completed trial
 * may overshoot $40 by its own cost — that is the protocol's disclosed behaviour.
 */
import { z } from "zod";
import type {
  BenchmarkResults,
  EngineName,
  RepairMode,
  ScenarioSpec,
  TrialResult
} from "@ssda/shared";
import type { BenchmarkRunConfig } from "./runner";
import { trialCostUsd } from "./prices";

/**
 * The operational stop threshold (PROTOCOL_2A §7): $39.90 of model-inference
 * spend. A FROZEN CONSTANT, deliberately NOT a CLI flag — the protocol froze it,
 * and an operator must not be able to alter it per-run.
 */
export const CAMPAIGN_BUDGET_THRESHOLD_USD = 39.9;

export type CampaignPhase = "keyless" | "keyed";
export type CampaignPolicy = "A" | "B" | "B2" | "C" | "D";
/** One of the five frozen sweeps (PROTOCOL_2A §7: N=5). */
export type Sweep = 1 | 2 | 3 | 4 | 5;

/** One scheduled unit of work: a single policy sweep within a phase. */
export interface CampaignEntry {
  phase: CampaignPhase;
  sweep: Sweep;
  policy: CampaignPolicy;
  /** 0-based global order within the phase's schedule. */
  ordinal: number;
}

const SWEEPS: readonly Sweep[] = [1, 2, 3, 4, 5];

/**
 * The frozen campaign schedule (PROTOCOL_2A §7).
 *  - keyless: sweeps 1..5, each running policies in the fixed order [A, B, B2] →
 *    15 entries. Keyless policies run before any key exists (§8) and are
 *    unaffected by counterbalancing.
 *  - keyed: sweeps 1..5 under the ABBA-counterbalanced order — sweep 1 [C, D],
 *    sweep 2 [D, C], sweep 3 [C, D], sweep 4 [D, C], sweep 5 [C, D] → 10 entries.
 */
export function buildSchedule(phase: CampaignPhase): CampaignEntry[] {
  const entries: CampaignEntry[] = [];
  let ordinal = 0;
  if (phase === "keyless") {
    for (const sweep of SWEEPS) {
      for (const policy of ["A", "B", "B2"] as CampaignPolicy[]) {
        entries.push({ phase, sweep, policy, ordinal: ordinal++ });
      }
    }
    return entries;
  }
  // keyed: ABBA counterbalancing, sweep by sweep.
  const keyedOrder: { sweep: Sweep; policies: CampaignPolicy[] }[] = [
    { sweep: 1, policies: ["C", "D"] }, // sweep 1: C then D
    { sweep: 2, policies: ["D", "C"] }, // sweep 2: D then C
    { sweep: 3, policies: ["C", "D"] }, // sweep 3: C then D
    { sweep: 4, policies: ["D", "C"] }, // sweep 4: D then C
    { sweep: 5, policies: ["C", "D"] } //  sweep 5: C then D
  ];
  for (const { sweep, policies } of keyedOrder) {
    for (const policy of policies) {
      entries.push({ phase, sweep, policy, ordinal: ordinal++ });
    }
  }
  return entries;
}

export interface PolicyRunConfig {
  engines: EngineName[];
  repairMode: RepairMode;
}

/**
 * The engine + repair dispatch each frozen policy runs under (PROTOCOL_2A §1).
 * repairMode is irrelevant for baseline/stagehand (they ignore it); a fixed value
 * is passed so the run config is total. Every campaign run is cold, N=1 per
 * scenario, headless (set by the caller, not here).
 */
export function policyRunConfig(policy: CampaignPolicy): PolicyRunConfig {
  switch (policy) {
    case "A":
      return { engines: ["baseline"], repairMode: "off" }; // repairMode ignored by baseline
    case "B":
      return { engines: ["hybrid"], repairMode: "off" };
    case "B2":
      return { engines: ["hybrid"], repairMode: "deterministic" };
    case "C":
      return { engines: ["hybrid"], repairMode: "llm" };
    case "D":
      return { engines: ["stagehand"], repairMode: "llm" }; // repairMode ignored by stagehand
  }
}

// ── Campaign state (resumable, persisted between runs) ────────────────────────

export const SweepSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5)
]);
export const CampaignPhaseSchema = z.enum(["keyless", "keyed"]);
export const CampaignPolicySchema = z.enum(["A", "B", "B2", "C", "D"]);

/** A recorded attempt at one schedule position, updated in place across reruns. */
export const CampaignEntryStateSchema = z.object({
  phase: CampaignPhaseSchema,
  sweep: SweepSchema,
  policy: CampaignPolicySchema,
  /**
   * `complete` = the run finished the whole suite; `stopped` = the pre-trial
   * budget check halted it mid-run (§7); `crashed` = the run threw (preserved and
   * rerun once, §7).
   */
  status: z.enum(["complete", "stopped", "crashed"]),
  benchId: z.string(),
  dir: z.string(),
  /**
   * Model-inference cost this entry contributed to the campaign spend. ACCUMULATED
   * across a crash+rerun: a crashed attempt's spend is already banked in
   * state.spendUsd, so the rerun's record ADDS to (never replaces) the crashed
   * attempt's cost. Invariant: sum(entries.costUsd) === state.spendUsd exactly
   * (FIX 2 — crash-rerun ledger reconciliation).
   */
  costUsd: z.number().nonnegative(),
  /** Trials this entry completed — likewise accumulated across a crash+rerun (FIX 2). */
  completedTrials: z.number().int().nonnegative(),
  /** How many times this position has been rerun after a crash (0 = first attempt). */
  reruns: z.number().int().nonnegative()
});
export type CampaignEntryState = z.infer<typeof CampaignEntryStateSchema>;

export const CampaignStateSchema = z.object({
  version: z.literal(1),
  protocolId: z.string(),
  suiteHash: z.string(),
  /** The frozen threshold, persisted for provenance (always CAMPAIGN_BUDGET_THRESHOLD_USD). */
  thresholdUsd: z.number(),
  /** Cumulative priced model-inference spend across every recorded trial. */
  spendUsd: z.number().nonnegative(),
  entries: z.array(CampaignEntryStateSchema),
  /** Set once the budget stop halts the campaign (§7). */
  stoppedReason: z.string().optional()
});
export type CampaignState = z.infer<typeof CampaignStateSchema>;

/** A fresh campaign state initialised from a suite's provenance. */
export function initCampaignState(protocolId: string, suiteHash: string): CampaignState {
  return {
    version: 1,
    protocolId,
    suiteHash,
    thresholdUsd: CAMPAIGN_BUDGET_THRESHOLD_USD,
    spendUsd: 0,
    entries: []
  };
}

/**
 * Validate a loaded campaign state against the suite provenance AND the requested
 * phase (PURE; throws a descriptive Error on mismatch — the I/O shell maps that to a
 * usage bail). Two refusals:
 *  - suite mismatch: the state's protocolId/suiteHash differ from the supplied
 *    suite, so resuming would run the wrong grid;
 *  - phase mismatch (FIX 5): the state records at least one entry from a DIFFERENT
 *    phase. keyless (15 entries) and keyed (10 entries) have different schedules and
 *    MUST use separate per-phase state files; loading the keyless ledger under
 *    --phase keyed would otherwise abort with a length mismatch after zero keyed
 *    trials. The message names both phases and the per-phase file to use.
 * Messages are written to read naturally after a "campaign state at <file> " prefix.
 */
export function assertStateMatches(
  state: CampaignState,
  provenance: { protocolId: string; suiteHash: string },
  phase: CampaignPhase
): void {
  if (state.protocolId !== provenance.protocolId || state.suiteHash !== provenance.suiteHash) {
    throw new Error(
      `belongs to a different suite (state protocolId=${state.protocolId} ` +
        `suiteHash=${state.suiteHash.slice(0, 12)}…; supplied suite ` +
        `protocolId=${provenance.protocolId} suiteHash=${provenance.suiteHash.slice(0, 12)}…)`
    );
  }
  const foreign = state.entries.find((e) => e.phase !== phase);
  if (foreign) {
    throw new Error(
      `records a "${foreign.phase}"-phase entry but --phase is "${phase}": the keyless and ` +
        `keyed phases have different schedules and MUST NOT share a state file. Use ` +
        `runs/phase2a/campaign-state.${phase}.json (or pass --state) for the "${phase}" phase, ` +
        `and runs/phase2a/campaign-state.${foreign.phase}.json for the "${foreign.phase}" phase (FIX 5).`
    );
  }
}

// ── Resume state machine ──────────────────────────────────────────────────────

function sameEntry(a: { phase: CampaignPhase; sweep: Sweep; policy: CampaignPolicy }, b: CampaignEntry): boolean {
  return a.phase === b.phase && a.sweep === b.sweep && a.policy === b.policy;
}

function label(e: { phase: CampaignPhase; sweep: Sweep; policy: CampaignPolicy }): string {
  return `${e.phase}/sweep-${e.sweep}/${e.policy}`;
}

/**
 * The next schedule entry to run given the recorded state, or null when the whole
 * schedule is complete. Resume-aware and strict:
 *  - REFUSES (throws) when the recorded entries deviate from the schedule prefix
 *    (out-of-order, unknown, or a non-final incomplete entry) — a corrupted resume
 *    must never silently re-run the wrong grid.
 *  - A `crashed` entry with reruns === 0 is re-runnable (protocol: a crashed sweep
 *    is preserved and rerun ONCE) and is returned again.
 *  - A `crashed` entry with reruns >= 1 (crashed again after its one rerun) THROWS:
 *    the operator must intervene; there is no silent third attempt.
 *  - A `stopped` entry is returned again; re-running re-checks the frozen budget,
 *    which (spend already at/over threshold) re-stops immediately.
 */
export function nextEntry(state: CampaignState, schedule: CampaignEntry[]): CampaignEntry | null {
  const recorded = state.entries;
  if (recorded.length > schedule.length) {
    throw new Error(
      `campaign state has ${recorded.length} entries but the schedule has only ${schedule.length} — state does not match this schedule`
    );
  }
  // Each recorded entry must align, in order, with the schedule position at its
  // index; every entry before the last must already be complete. (Both indexes are
  // in bounds — recorded.length ≤ schedule.length above, and i < recorded.length.)
  for (let i = 0; i < recorded.length; i++) {
    const rec = recorded[i]!;
    const sched = schedule[i]!;
    if (!sameEntry(rec, sched)) {
      throw new Error(
        `campaign state entry ${i} (${label(rec)}) does not match the frozen schedule position ${i} (${label(sched)}) — out-of-order or unknown entry`
      );
    }
    if (i < recorded.length - 1 && rec.status !== "complete") {
      throw new Error(
        `campaign state entry ${i} (${label(rec)}) is "${rec.status}" but is not the last recorded entry — a non-final incomplete entry means the resume prefix is corrupt`
      );
    }
  }

  if (recorded.length === 0) return schedule[0] ?? null;
  const last = recorded[recorded.length - 1]!;
  const lastPos = schedule[recorded.length - 1]!; // in bounds (recorded.length ≤ schedule.length)

  if (last.status === "complete") {
    return schedule[recorded.length] ?? null; // advance to the next position (or done)
  }
  if (last.status === "crashed") {
    if (last.reruns === 0) return lastPos; // preserved and rerun once
    throw new Error(
      `campaign entry ${label(last)} crashed again after its one permitted rerun (reruns=${last.reruns}) — operator must intervene; no silent third attempt`
    );
  }
  // stopped: re-running re-checks the frozen budget (§7).
  return lastPos;
}

// ── Budget pricing ────────────────────────────────────────────────────────────

/**
 * The priced model-inference cost of one trial for the budget (PROTOCOL_2A §7):
 *  - baseline → 0 (zero inference by construction);
 *  - otherwise the pinned-table cost of the recorded tokens (trialCostUsd — the
 *    single pricing source, NEVER reimplemented);
 *  - when that is null AND the trial recorded llmCalls > 0 → null to signal
 *    UNPRICEABLE (the driver treats it as fatal: a budget cannot be enforced over
 *    unpriceable spend);
 *  - null with llmCalls 0/absent → 0 (a real, priced zero, e.g. a keyless hybrid
 *    trial or one with no token record).
 */
export function trialCost(
  record: Pick<TrialResult, "tokens">,
  engine: EngineName,
  model: string | undefined | null
): number | null {
  if (engine === "baseline") return 0;
  const cost = trialCostUsd(record.tokens, model);
  if (cost !== null) return cost;
  const llmCalls = record.tokens?.llmCalls ?? 0;
  return llmCalls > 0 ? null : 0;
}

/**
 * The pre-trial budget verdict (PROTOCOL_2A §7): a stop-reason string once the
 * recorded spend has reached the frozen threshold, else undefined. The check is
 * PRE-trial, so the final completed trial may overshoot $40 by its own cost —
 * the protocol's disclosed behaviour; there is deliberately no projected-cost
 * guard here.
 */
export function shouldStop(state: Pick<CampaignState, "spendUsd">): string | undefined {
  if (state.spendUsd >= CAMPAIGN_BUDGET_THRESHOLD_USD) {
    return (
      `budget stop (PROTOCOL_2A §7): recorded model-inference spend ` +
      `$${state.spendUsd.toFixed(4)} has reached the operational threshold ` +
      `$${CAMPAIGN_BUDGET_THRESHOLD_USD.toFixed(2)} (checked pre-trial)`
    );
  }
  return undefined;
}

/** Thrown from the afterTrial hook when a keyed trial's spend cannot be priced (§7). */
export class UnpriceableTrialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpriceableTrialError";
  }
}

type BenchmarkHooks = NonNullable<BenchmarkRunConfig["hooks"]>;

/**
 * Build the runner hooks that enforce the budget for one entry, closing over the
 * MUTABLE campaign state and the persist function:
 *  - beforeTrial: the pre-trial budget check (shouldStop) → `{ stop }` or undefined.
 *  - afterTrial: price the trial (trialCost); UNPRICEABLE → throw a fatal labelled
 *    error; otherwise add the cost to the campaign spend AND this entry's running
 *    cost, then persist the state (atomic write is the caller's persist function)
 *    after EVERY trial so a crash mid-entry never loses spend accounting.
 * Exposes the entry's running cost/trial count for the entry record.
 */
export function makeBudgetHooks(
  state: CampaignState,
  model: string | undefined | null,
  persist: (state: CampaignState) => Promise<void>
): { hooks: BenchmarkHooks; entryCostUsd: () => number; entryTrials: () => number } {
  let entryCost = 0;
  let entryTrials = 0;
  const hooks: BenchmarkHooks = {
    beforeTrial: async () => {
      const stop = shouldStop(state);
      return stop ? { stop } : undefined;
    },
    afterTrial: async (record) => {
      const cost = trialCost(record, record.engine, model);
      if (cost === null) {
        throw new UnpriceableTrialError(
          `UNPRICEABLE trial ${record.runId} (engine ${record.engine}): it recorded ` +
            `llmCalls > 0 but its tokens are not priceable under the pinned table ` +
            `(model ${model ?? "none"}). A budget cannot be enforced over unpriceable ` +
            `spend — halting the campaign.`
        );
      }
      entryCost += cost;
      entryTrials += 1;
      state.spendUsd += cost;
      await persist(state);
    }
  };
  return { hooks, entryCostUsd: () => entryCost, entryTrials: () => entryTrials };
}

// ── The injected run-loop ─────────────────────────────────────────────────────

/** One entry's lab + run-directory context (the I/O shell provides it). */
export interface EntryRunContext {
  labUrl: string;
  benchDir: string;
  benchId: string;
  /** Release the lab (killAndVerify); called after the run on every path. */
  dispose: () => Promise<void>;
}

export interface CampaignDeps {
  schedule: CampaignEntry[];
  /** The suite scenarios, already projected to ScenarioSpec (suiteScenarioToSpec). */
  scenarios: ScenarioSpec[];
  /** Pricing model for the budget (loadAgentEnvConfig().stagehandModel), or null. */
  model: string | undefined | null;
  headless: boolean;
  /** The real @ssda/agent runBenchmark (or a stub in tests). */
  runBenchmark: (config: BenchmarkRunConfig) => Promise<BenchmarkResults>;
  /** Spawn a private lab + create the run dir for one entry (I/O, injected). */
  prepareRun: (entry: CampaignEntry) => Promise<EntryRunContext>;
  /** Atomically persist the campaign state (tmp + rename), injected. */
  persist: (state: CampaignState) => Promise<void>;
  /** Per-entry progress line (optional). */
  log?: (line: string) => void;
}

export type CampaignOutcome =
  | { kind: "complete" }
  | { kind: "stopped"; reason: string; entry: CampaignEntry }
  | { kind: "crashed"; entry: CampaignEntry; error: Error };

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Record (or update in place) the entry for a schedule position. A rerun of a
 * previously-crashed position increments its rerun counter AND accumulates its
 * cost/trials onto the crashed attempt's (see below); a fresh position is appended
 * with reruns 0.
 */
function recordEntry(
  state: CampaignState,
  entry: CampaignEntry,
  fields: Pick<CampaignEntryState, "status" | "benchId" | "dir" | "costUsd" | "completedTrials">
): void {
  const idx = state.entries.findIndex((e) => sameEntry(e, entry));
  if (idx === -1) {
    state.entries.push({ phase: entry.phase, sweep: entry.sweep, policy: entry.policy, reruns: 0, ...fields });
    return;
  }
  const prev = state.entries[idx]!;
  const wasCrashed = prev.status === "crashed";
  const reruns = wasCrashed ? prev.reruns + 1 : prev.reruns;
  // A crashed attempt's spend/trials are already banked in state.spendUsd; ACCUMULATE
  // them into the rerun's record so sum(entries.costUsd) always reconciles exactly
  // with state.spendUsd (FIX 2). A non-crashed prior (re-recording a stopped/complete
  // position, which the loop no longer does) is overwritten as before.
  const costUsd = wasCrashed ? prev.costUsd + fields.costUsd : fields.costUsd;
  const completedTrials = wasCrashed ? prev.completedTrials + fields.completedTrials : fields.completedTrials;
  state.entries[idx] = {
    phase: entry.phase,
    sweep: entry.sweep,
    policy: entry.policy,
    status: fields.status,
    benchId: fields.benchId,
    dir: fields.dir,
    costUsd,
    completedTrials,
    reruns
  };
}

/**
 * Drive the campaign to completion, a budget stop, or a crash — over injected
 * effects only (no direct I/O). For each remaining schedule entry: prepare a lab,
 * run the policy's benchmark over the whole suite with the budget hooks, record
 * the entry, and persist. The frozen budget is enforced by the hooks; nextEntry
 * enforces resume order and the rerun-once rule.
 */
export async function runCampaign(state: CampaignState, deps: CampaignDeps): Promise<CampaignOutcome> {
  for (;;) {
    const entry = nextEntry(state, deps.schedule); // may throw (fatal resume/rerun error)
    if (entry === null) return { kind: "complete" };

    // FIX 3 — pre-trial budget short-circuit, BEFORE preparing anything. If the
    // recorded spend already meets the frozen threshold, return the budget stop
    // WITHOUT spawning a lab or touching any entry record. This preserves a resumed
    // budget-stopped campaign's stopped entry byte-for-byte (re-running it would
    // otherwise prepare a fresh lab + run dir, immediately re-stop with 0 trials, and
    // clobber the original record) and refuses to start a fresh campaign whose prior
    // spend already exceeds the threshold. stoppedReason is set only if absent, so the
    // original stop-reason evidence is preserved on resume.
    const preStop = shouldStop(state);
    if (preStop) {
      const reason = state.stoppedReason ?? preStop;
      state.stoppedReason = reason;
      await deps.persist(state);
      return { kind: "stopped", reason, entry };
    }

    const cfg = policyRunConfig(entry.policy);
    const budget = makeBudgetHooks(state, deps.model, deps.persist);

    // FIX 1 — prepareRun runs INSIDE the per-entry try, so a lab-spawn / waitUntilReady
    // / createRunDir failure records the entry as "crashed" (subject to the rerun-once
    // rule) instead of leaking a lab and escaping runCampaign. On that path ctx is
    // undefined, so benchId/dir are recorded as empty strings and cost/trials as 0.
    let ctx: EntryRunContext | undefined;
    let results: BenchmarkResults;
    try {
      ctx = await deps.prepareRun(entry);
      results = await deps.runBenchmark({
        labUrl: ctx.labUrl,
        engines: cfg.engines,
        scenarios: deps.scenarios,
        trialsPerScenario: 1,
        headless: deps.headless,
        benchDir: ctx.benchDir,
        benchId: ctx.benchId,
        runPurpose: "cold",
        repairMode: cfg.repairMode,
        protocolId: state.protocolId,
        suiteHash: state.suiteHash,
        hooks: budget.hooks,
        ...(deps.log ? { onProgress: deps.log } : {})
      });
    } catch (error) {
      if (ctx) await ctx.dispose();
      recordEntry(state, entry, {
        status: "crashed",
        benchId: ctx?.benchId ?? "",
        dir: ctx?.benchDir ?? "",
        costUsd: budget.entryCostUsd(),
        completedTrials: budget.entryTrials()
      });
      await deps.persist(state);
      return { kind: "crashed", entry, error: asError(error) };
    }

    // Reached only when prepareRun AND runBenchmark both succeeded → ctx is defined.
    await ctx!.dispose();
    const status: CampaignEntryState["status"] = results.stopped ? "stopped" : "complete";
    recordEntry(state, entry, {
      status,
      benchId: ctx!.benchId,
      dir: ctx!.benchDir,
      costUsd: budget.entryCostUsd(),
      completedTrials: budget.entryTrials()
    });
    await deps.persist(state);

    deps.log?.(
      `${label(entry)} [${entry.ordinal + 1}/${deps.schedule.length}] bench=${ctx!.benchId} ` +
        `status=${status} cost=$${budget.entryCostUsd().toFixed(4)} ` +
        `spend=$${state.spendUsd.toFixed(4)}/$${CAMPAIGN_BUDGET_THRESHOLD_USD.toFixed(2)}`
    );

    if (results.stopped) {
      state.stoppedReason = results.stopped.reason;
      await deps.persist(state);
      return { kind: "stopped", reason: results.stopped.reason, entry };
    }
  }
}
