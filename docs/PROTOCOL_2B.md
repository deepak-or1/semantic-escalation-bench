# Phase 2B — the readiness-gate ablation

**Status: DRAFT — externally audited (gate 2: PASS 2026-07-25,
conditional on gate 1's clean smoke); not frozen; no trial may
run.** This document freezes under its own tag lineage
(`phase2b-ablation-freeze-v1`) at gate 5, with the expectations table
below finalized *before* any trial executes. Evidence records use the
version-2 format ([RECORD_FORMAT.md](RECORD_FORMAT.md)); Phase 2B does
not begin until that format is implemented and verified.

## What this is, and is not

Phase 2A discovered that a readiness predicate shared by every policy
above the baseline (`waitForContent`,
`packages/agent/src/core/domReady.ts`: a stats table is "ready" only at
≥ 5 visible rows, a card grid at ≥ 8 cards) decided five of the 32
scenarios. Because the gate was *discovered from* Phase 2A's results,
this follow-up is a **post-hoc causal ablation**: it can confirm the
mechanism, it cannot independently discover it, and it is never pooled
with Phase 2A's registered results.

The claim it can support, at maximum:

> Relaxing the readiness predicate removed the failures on these
> scenarios, confirming that the shared gate caused them.

It cannot support "the model is never the ceiling in general."

## Design

One variable: the readiness predicate, selected by a new CLI flag.

- **Arm F (frozen)** — `--readiness-mode frozen`: the Phase-2A
  predicate, bit-identical behaviour. Exact thresholds, both content
  modes: stats mode ≥ 5 visible rows (table, heading required) or
  ≥ 8 cards; odds mode ≥ 4 rows (no heading requirement) or ≥ 4
  cards. This arm is the replication control and is expected to
  reproduce Phase 2A's gate failures exactly.
- **Arm R (relaxed)** — `--readiness-mode any-row`: every count
  threshold becomes ≥ 1, in **both** content modes (stats and odds) —
  relaxing only the stats gate would let a small page clear it and
  then fail the odds mode's own ≥ 4, an artifact rather than the
  mechanism under test. Everything else in the poll — the
  structure-awareness flags (heading required for stats, not for
  odds), class-freedom, timeout, poll cap — is unchanged. The
  existence proof for this choice is policy A, which waits for any
  row, walks the pager, and passed the pure small-page scenarios.

Held fixed: the five frozen policies at their Phase-2A tags' behaviour,
the suite bytes for the five scenarios, seeds, model
(`anthropic/claude-haiku-4-5`), pinned prices, prompts, lab, judge,
validator, sweep protocol.

**Arm-aware evidence contract.** Every run stamps its arm
(`environment.readinessMode: "frozen" | "any-row"`); the verifier
refuses a Phase-2B bundle whose runs miss the stamp, and completeness
is enforced over the full cell identity **scenario × policy × arm ×
sweep**, so the two arms can never collapse into repeat runs of one
existing cell.

**Subset semantics.** Phase 2B verifies against the full frozen
Phase-2A suite bytes (its hash is preserved and still checked),
restricted by an exact allowlist of the five registered scenario ids:
a bundle missing any of the five, or containing any scenario outside
them, fails completeness. The other 27 scenarios are excluded by the
allowlist, never by editing the suite.

**Campaign identity.** The reused suite's `protocolId` stays
`phase2a-v1` — it names the suite's lineage, and the verifier
requires every run's `environment.protocolId` to equal the supplied
suite's, so that field cannot also name this campaign. Phase-2B
identity is a separate required stamp: every 2B run and every 2B
ledger records `campaignProtocolId: "phase2b-ablation-v1"`, exact
and uniform across the campaign, and the verifier's
`--expect-campaign` flag refuses a bundle whose runs miss the stamp
or disagree on it.

**Model-provenance consistency.** `environment.modelConfig` must be
semantically consistent with the run, not merely well-typed: keyless
policies (A, B, B2) configure no provider and no model, so they must
record `temperatureSource: "n/a-no-model"` with `temperature: null`
and no configured model; keyed policies (C, D) run Anthropic with the
exact frozen model, so they must record
`temperatureSource: "provider-default"` with `temperature: null`.
`"explicit"` requires a numeric temperature by definition and is
inadmissible anywhere in Phase 2B. (The run-shape consistency rules
live in the record-format verifier, [RECORD_FORMAT.md](RECORD_FORMAT.md);
the exact-model and Phase-2B-admissibility rules are campaign checks,
gate 3.)

**Scope:** the five gate scenarios only — `f3-page-size-3-a`,
`f3-page-size-3-b`, `f3-page-size-2-a`, `f3-page-size-2-b`,
`x-class-l3-page-size-2` — × all five policies × both arms × 5 sweeps
= 250 trials (150 keyless, 100 keyed).

**Cost projection (recomputed and frozen at gate 5):** keyed trials
only (C, D). At Phase-2A per-trial averages this is on the order of
$2 total; the Phase-2A $39.90 stop-threshold convention carries over.

## Expectations (registered at freeze, before any trial)

Draft, non-binding until the freeze tag exists. Rationale must cite
mechanism, not hope:

| Scenario | Arm | A | B | B2 | C | D |
| --- | --- | --- | --- | --- | --- | --- |
| f3-page-size-* (4 scenarios) | F | pass | fail | fail | fail | fail |
| f3-page-size-* (4 scenarios) | R | pass | pass | pass | pass | pass |
| x-class-l3-page-size-2 | F | fail | fail | fail | fail | fail |
| x-class-l3-page-size-2 | R | fail | fail | pass | pass | pass |

Draft reasoning, finalized only after the implementation-diff audit
(gate 4): under Arm R the small pages need no reveal step, so every
policy should pass the four pure small-page scenarios; on the compound
scenario, class drift L3 still breaks cached login selectors, so B
(no repair path) fails at login, B2/C pass only if their repair paths
recover login as they did in Phase 2A's other L3 cells, D passes, and
A still fails (its login hooks are stripped and it has no repair).
Any Arm-F result that does not reproduce Phase 2A on the frozen
comparison projection invalidates the run environment, not the
hypothesis.

## Language rules (carried from PROTOCOL_2A §9, plus)

- Always "post-hoc causal ablation"; never "held-out", never
  "prediction" for the expectations table (they are registered
  expectations about a discovered mechanism).
- Results are reported beside Phase 2A's, never merged into its
  scoreboard or scorecard.
- The bounded claim above is the ceiling; no generalization to other
  predicates, suites, or models.

## Operational machinery (carried from Phase 2A unchanged)

- Per-phase state files (`runs/phase2b/campaign-state.<phase>.json`,
  never shared between phases); crash-rerun-once with an accumulating
  ledger (`sum(entries.costUsd) == spendUsd`).
- The frozen **$39.90** pre-trial recorded-spend stop-threshold — a
  stop rule over recorded tokens, never a bound or a billing
  reconciliation.
- The outcome-blind transport-poisoning criterion:
  `(llmCalls > 0 ∧ both token sides 0) ∨ failureDetail matches
  /ENOTFOUND|Cannot connect to API|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/`.
  Any poisoned entry invalidates its grid per the Phase-2A incident
  rule: full restart, aborted attempt preserved and never pooled.
- Runner hygiene: a private ephemeral lab per run, browsers launched
  with `--disable-http-cache`, `caffeinate` wrapper, DNS pre-check, no
  VPN or network changes mid-campaign.
- Verification: exactly the three phase-specific commands frozen in
  the Schedule section (keyless, keyed, final pooled) — there is no
  other verification invocation, and no generic "both phases" form
  that could be mistaken for a fourth.

## Schedule (frozen at gate 5; exact CLI shapes fixed at gate 4)

- **Run entries:** 30 keyless (A, B, B2 × 2 arms × 5 sweeps) + 20
  keyed (C, D × 2 arms × 5 sweeps); each run entry executes the five
  allowlisted scenarios once. 250 trials total.
- **Balanced arm ordering** (time and network conditions must not
  align with one arm — the within-policy F-vs-R contrast is the causal
  result): within each policy, each sweep runs both arms back-to-back,
  and the per-sweep arm order is frozen as an explicit table, not a
  rule to interpret:

  | Policy | Sweep 1 | Sweep 2 | Sweep 3 | Sweep 4 | Sweep 5 |
  | --- | --- | --- | --- | --- | --- |
  | A  | F,R | R,F | F,R | R,F | F,R |
  | B  | R,F | F,R | R,F | F,R | R,F |
  | B2 | F,R | R,F | F,R | R,F | F,R |
  | C  | R,F | F,R | R,F | F,R | R,F |
  | D  | F,R | R,F | F,R | R,F | F,R |

  Policy execution order is likewise frozen: the keyless phase runs
  A, then B, then B2; the keyed phase runs C, then D. The campaign
  state machine enforces both orders — a run entry executed out of
  schedule order, or with the wrong arm for its slot, is refused, not
  reordered.
- **Keyed smoke** (Phase-2A §8.5 carried over, `runPurpose: smoke`,
  never evidence, Arm F): one C trial that must heal a
  class-drift-broken login with its repair path and one D trial that
  must complete the full flow, both with correct stamps; either
  failing blocks the keyed phase. The exact two smoke scenario ids
  are frozen at gate 5.
- **State files:** `runs/phase2b/campaign-state.keyless.json` and
  `runs/phase2b/campaign-state.keyed.json`, never shared; resume =
  Phase 2A's crash-rerun-once with the accumulating ledger.
- **Phase gating is machine-enforced, not procedural.** The Phase-2B
  driver refuses to start (a) any keyless run entry while a provider
  key is present in the environment; (b) any keyed run entry without
  a key; and (c) the keyed phase entirely until it has read the
  complete 30-entry keyless ledger and re-verified the keyless bundle
  with the frozen *keyless* verification command below (a PASS
  verdict recorded against the keyless state file — the pooled
  command cannot do this job, since a keyless-only bundle has no C or
  D and must fail pooled completeness). Immediately before the first
  paid call it re-checks, against
  its frozen expectations: the schedule table above, the suite hash,
  the protocol tag, the code commit, both arm stamps, the record
  version, and the keyless verifier verdict — any mismatch stops the
  campaign before any spend.
- **Verification (exact flags fixed at gate 4; three frozen
  commands, one per bundle shape — a single pooled command cannot
  validate a single phase, because a keyless-only bundle contains no
  C or D and must fail pooled completeness):**
  - *Keyless bundle* (150 trials):
    `pnpm verify:suite <keyless 2B runs>
    --suite data/phase2a/scenario-suite.json
    --expect-policies A,B,B2 --expect-trials 5
    --expect-record-version 2 --expect-scenarios <the five ids>
    --expect-arms frozen,any-row
    --expect-campaign phase2b-ablation-v1
    --expect-model anthropic/claude-haiku-4-5
    --expect-prices-pinned-at 2026-07-14`
  - *Keyed bundle* (100 trials): the same flags with
    `--expect-policies C,D`.
  - *Final pooled bundle* (250 trials): the same flags with
    `--expect-policies A,B,B2,C,D`. Only this command supports the
    pooled result.

  The keyed phase gate runs the *keyless* command against the
  keyless ledger's runs before any paid call. `--expect-model` is
  **policy-aware**: it requires the exact model on every
  model-bearing run (C, D) and requires that model-less runs (A, B,
  B2) record no model at all — it never demands the keyed model of a
  keyless policy. Phase-2B bundles additionally require a
  **non-null** per-trial `chromeVersion` on every trial, **exactly
  one browser build per policy across both arms** (the machine check
  behind "the browser is held fixed across readiness arms",
  [LIMITATIONS.md](LIMITATIONS.md)), and reject
  `temperatureSource: "explicit"` anywhere — a set temperature is a
  deviation from the frozen Phase-2A behaviour.
- **Key lifecycle:** fresh key created immediately before the keyed
  smoke; pre-flight confirms the model is in the pinned price table;
  post-campaign the key is revoked and the revocation is confirmed by
  a recorded 401 check before the evidence bundle is built.
- **Transport poisoning:** any poisoned entry (criterion above)
  invalidates the FULL keyed grid — restart, aborted attempt
  preserved and never pooled, exactly the Phase-2A incident rule.

## Gates before any trial (in this order)

1. Record format v2 (including the raw-payload extension) implemented
   and accepted; `verify:suite` recompute-from-raw passes on a fresh
   keyless smoke run executed **at the record-v2 commit itself**
   (`gitDirty: false`, final field names, per-trial browser
   provenance present) and preserved as evidence. A smoke run from a
   dirty tree or a pre-final revision does not satisfy this gate.
2. External audit of this protocol draft.
3. Implementation: the `--readiness-mode frozen|any-row` flag, the
   per-run arm stamp, arm-aware completeness in the verifier, the
   `campaignProtocolId` stamp and `--expect-campaign` flag, the
   model/price expects (`--expect-model` with the policy-aware
   semantics above, `--expect-prices-pinned-at`), the
   `"explicit"`-temperature rejection, the non-null per-trial browser
   provenance and per-policy browser-build uniformity checks, the
   machine-enforced phase gating above (key-presence refusals; keyed
   refuses until the keyless ledger verifies under the keyless
   command), and the Phase-2B campaign driver — wiring
   `--expect-record-version 2` into its expect-grid and every
   operator hint it prints (the Phase-2A driver,
   `scripts/run-campaign-2a.ts`, predates the flag and does neither;
   carrying it forward unmodified would silently drop the
   enforcement).
4. External audit of the exact implementation diff, including the
   Arm-F replication requirement: Arm F keyless runs on the five
   scenarios must match Phase 2A's keyless **A, B, and B2** records
   (A is the negative control and must be unchanged across arms) on a
   **frozen comparison projection, exhaustive over graded behaviour**:
   judged `outcome`, `outcomeClass`, and `outcomeReason`;
   `pipelineSuccess`, `extractionSuccess`, and `validationSuccess`;
   the entire per-page `accuracy` object compared by **deep
   equality** — every counter it contains (expected and matched
   rows, field checks and field matches, coverage, accuracy,
   overall, per-page scores), never a manually enumerated subset;
   `failureCategory` and `failureDetail`; `retries` and
   `recoveredAfterFailure`; `healedSteps`,
   `deterministicRepairSteps`, and `deterministicFallbacks`; and
   `llmCalls`. A field a policy honestly never records (the
   baseline's token block) matches only if it is equally absent on
   both sides. (Byte identity is impossible by construction: v2
   records carry new fields, fresh timestamps, and a new commit.)
5. Expectations table finalized; the two keyed-smoke scenario ids and
   the recomputed cost projection frozen; code and protocol tagged
   **together** at `phase2b-ablation-freeze-v1`.
6. Keyless sweeps run and verify under the frozen *keyless* command
   before any keyed trial; the keyed phase uses a fresh key, revoked
   after the campaign.
7. Campaign acceptance: the keyed bundle passes the frozen *keyed*
   command; the complete 250-trial bundle passes the frozen *final
   pooled* command; the transport-poison criterion matched zero
   entries in the accepted grids. No analysis, no results document,
   and no evidence claim of any kind is made before all three hold.
