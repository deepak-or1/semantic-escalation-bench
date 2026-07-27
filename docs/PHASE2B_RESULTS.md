# Phase 2B results — the readiness-gate ablation

**Before paying for semantic recovery, make sure the system can
correctly recognize failure.** Phase 2A discovered that a readiness
predicate shared by every policy above the baseline decided five of its
32 scenarios. Phase 2B changed only that predicate and measured the
causal effect.

| Policy | Five-row rule | Any visible row | Change |
| --- | ---: | ---: | ---: |
| A: baseline | 4/5 | 4/5 | 0 |
| B: cached selectors | 0/5 | 4/5 | +4 |
| B2: deterministic repair | 0/5 | 5/5 | +5 |
| C: repair on failure | 0/5 | 5/5 | +5 |
| D: semantic control | 0/5 | 5/5 | +5 |

Cells are scenario cells passed (of the five registered scenarios),
and every cell is uniform across all five sweeps: 5/5 or 0/5, never a
mix. Campaign complete 2026-07-26; all three frozen verification
commands PASS against the committed evidence copies
([`evidence/phase2b/report/VERIFICATION.md`](../evidence/phase2b/report/VERIFICATION.md)).

## What this is

A **post-hoc causal ablation with expectations registered before
execution** ([PROTOCOL_2B.md](PROTOCOL_2B.md), frozen at
`phase2b-ablation-freeze-v1`, commit `22e0e49`). The five scenarios
were not held out and the mechanism was not independently discovered
here: Phase 2A found it, and Phase 2B exists to test whether it was
the cause. The expected outcome of every one of the 50 cells
(5 scenarios × 5 policies × 2 arms) was registered in the protocol at
the freeze, before any trial ran.

**50/50 means registered cell outcomes matched.** It does not mean "50
correct model answers": the registered expectations include failures
(A fails the compound cell under both arms; B still fails it under the
relaxed gate), and those failures landing exactly where registered is
part of the result.

## The one variable

The shared readiness poll (`waitForContent`,
`packages/agent/src/core/domReady.ts`) declares a stats table "ready"
only at five or more visible rows. Pages configured to two or three
rows per page can never satisfy it, so every policy that consults the
gate times out before extraction begins, no matter how capable its
recovery machinery is. Arm F runs the Phase-2A predicate bit-identical;
Arm R relaxes every count threshold to one visible row. One CLI flag.
Policies, suite bytes, seeds, model, prices, prompts, lab, judge,
validator, and sweep protocol are all held fixed.

Two controls anchor the comparison:

- **Negative control:** policy A never consults the gate (and its login
  hooks are stripped on the compound cell). It moved zero cells between
  arms, in both directions.
- **Replication control:** every Arm-F keyless trial was compared
  field-by-field against its Phase-2A record on a frozen 15-field
  projection, paired by (scenario, policy, sweep): 75/75 matched,
  machine-enforced before the paid phase could start.

## What moved, and why the pattern is mechanism-shaped

The bounded claim, in the protocol's frozen language: within the five
pre-registered Phase 2B scenarios, relaxing the shared five-row
readiness predicate caused exactly the recoveries registered before
the ablation ran, with zero cross-sweep variance. B recovered the four
pure small-page scenarios, B2, C, and D recovered all five, and the
negative control A did not move.

The split between B and the rest is the mechanism showing through: the
four pure small-page scenarios need no repair at all once the gate
stops rejecting small pages, so even B (no repair path of any kind)
passes them. The fifth scenario compounds the small page with
class-drift level 3, which breaks the cached login selector before the
gate is ever consulted; B has no way back from that, while B2's
deterministic ladder, C's LLM repair, and D's semantic execution all
recover it. Under the frozen gate, D spent ten model calls per trial on
these scenarios and still failed every one; under the relaxed gate it
passes all five, and its per-trial spend goes up, because success means
walking every page instead of failing out early.

## Cost

Total keyed spend: **$2.088942** (entries $2.051453 + smoke $0.037489),
reconciling exactly with the per-record token accounting at the pinned
2026-07-14 prices. Supporting evidence, not a headline: the point of
the ablation is the outcome table, and the keyless three-fifths of it
(A, B, B2 — 150 of the 250 trials) costs nothing to reproduce.

## Limitations

Five scenarios, one model (`anthropic/claude-haiku-4-5`), one
constructed domain served from `localhost`. The claim is causal inside
this benchmark and stops there: it does not generalize to other
readiness predicates, other suites, or other models, and Phase 2B
results are reported beside Phase 2A's, never pooled into its
scoreboard.

## Reproduce / verify

The committed bundle at
[`evidence/phase2b/`](../evidence/phase2b/) contains all 50 run cells,
both campaign ledgers, the frozen-expectations file, and the smoke
record. The three frozen verification commands (keyless 150, keyed 100,
pooled 250) and their PASS outputs, the 50/50 scorecard, the zero
transport-poison scan, and the ledger reconciliation are recorded in
[`evidence/phase2b/report/VERIFICATION.md`](../evidence/phase2b/report/VERIFICATION.md).
The key lifecycle for the paid phase, including a disclosed
credential-handling deviation and its adjudication, is in
[`evidence/phase2b/report/KEY_LIFECYCLE.md`](../evidence/phase2b/report/KEY_LIFECYCLE.md).
