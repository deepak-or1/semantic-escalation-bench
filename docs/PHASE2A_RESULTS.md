# Phase 2A results — the policy frontier on a held-out grid

**Campaign complete 2026-07-21; final pooled verification PASS (exit 0).**
25 runs / 800 trials (15 keyless: A, B, B2 × 5 sweeps; 10 keyed: C, D × 5
sweeps), verified together by the frozen suite verifier:
schema / provenance / completeness / grading all OK, prediction scorecard
141 hit · 19 miss · 0 not-run (report-only, never a gate). Verbatim output:
[`evidence/phase2a/report/verify.final.txt`](../evidence/phase2a/report/verify.final.txt).

Everything below is computed from the per-run records preserved in
[`evidence/phase2a/`](../evidence/phase2a/README.md) and follows the
metrics and language rules frozen in advance in
[PROTOCOL_2A.md §9](PROTOCOL_2A.md). Design, policy ladder, freeze
lineage, and gates: [PROTOCOL_2A.md](PROTOCOL_2A.md). Uniform stamps
across all 25 runs: execution commit `867723c`, gitDirty `false`, suite
frozen at tag `phase2a-suite-freeze-v1`, Phase-1 `promptsHash` unchanged.

The design in one sentence: five frozen addressing policies — A hardcoded
selectors, B structural addressing, B2 + deterministic repair, C + LLM
repair on failure, D full semantic execution — ran against 32 held-out
scenarios authored by an external reviewer (GPT-5.6 "sol") *after* the
policy freeze, with per-cell predictions registered before any trial.

## Determinism

Every one of the 160 policy×scenario cells is 5/5 or 0/5 — outcome maps
are identical scenario-by-scenario across all five sweeps, for all five
policies (the keyless grid had already repeated 480/480 across two full
executions). Repair activation is equally repeatable: every C sweep
records exactly 15 healed trials, 19 healed steps, and 31 LLM calls;
every B2 sweep exactly 9 repair trials and 10 deterministic repair steps;
every D sweep exactly 247 LLM calls. Failure attribution below is
therefore architectural, not sampling noise.

## Stratum F — parametric axes (pass counts per level, of 2 instances)

Per §9: reported per axis, never averaged; no interpolation between
levels; no extrapolation beyond the tested maxima.

**F1 · class-drift level** (L0 none → L4 aggressive):

| Policy | L0 | L1 | L2 | L3 | L4 | First observed failure |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| A | 2 | 1 | 0 | 0 | 0 | L1 (one instance) |
| B | 2 | 2 | 0 | 0 | 0 | L2 |
| B2 | 2 | 2 | 2 | 2 | 2 | none observed |
| C | 2 | 2 | 2 | 2 | 2 | none observed |
| D | 2 | 2 | 2 | 2 | 2 | none observed |

Deterministic repair fully absorbs the class-drift axis on this grid —
every level B2 recovers, C and D also pass, and no model inference was
needed to do it.

**F2 · decoy level** (L0 none → L3 aggressive; decoys render plausible
wrong content alongside the real content):

| Policy | L0 | L1 | L2 | L3 | First observed failure |
| --- | ---: | ---: | ---: | ---: | --- |
| A | 2 | 2 | 0 | 0 | L2 |
| B | 2 | 0 | 0 | 0 | L1 |
| B2 | 2 | 0 | 0 | 0 | L1 |
| C | 2 | 0 | 0 | 0 | L1 |
| D | 2 | 2 | 2 | 2 | none observed |

C's six failing decoy cells recorded **zero LLM calls in all five
sweeps**: the cached action appears to succeed, extraction returns
plausible wrong rows (e.g. `f2-decoy-l1-a` grades 0.71 where 1.00 is
required), and the repair trigger — which fires on *failure* — never
fires. Repair-on-failure is trigger-blind to failures that don't look
like failures. Only D, which pays for semantics on every step, separates
real from decoy content here.

**F3 · page size** (rows per page: 5 → 3 → 2):

| Policy | 5 | 3 | 2 | First failing page size |
| --- | ---: | ---: | ---: | --- |
| A | 2 | 2 | 2 | none observed |
| B | 2 | 0 | 0 | 3 |
| B2 | 2 | 0 | 0 | 3 |
| C | 2 | 0 | 0 | 3 |
| D | 2 | 0 | 0 | 3 |

This is the campaign's headline finding — see
[the readiness gate](#the-readiness-gate-finding) below.

## Stratum K — named single conditions (pass/fail)

| Scenario | A | B | B2 | C | D |
| --- | :-: | :-: | :-: | :-: | :-: |
| k-header-vocabulary | pass | fail | fail | pass | pass |
| k-ui-copy | pass | pass | pass | pass | pass |
| k-column-order | fail | pass | pass | pass | pass |
| k-layout-cards | fail | fail | fail | pass | pass |

No ordering claims (per §9). Notable raw facts: header-vocabulary drift
defeats B/B2's synonym dictionary but not A (which never reads headers)
— and C recovers it via LLM repair; column reorder defeats only A's
fixed indices; the card layout defeats every deterministic reader and
both repair-capable keyed policies recover it.

## Stratum X — compound cells (pass/fail; interactions described, not modeled)

| Scenario | A | B | B2 | C | D |
| --- | :-: | :-: | :-: | :-: | :-: |
| x-cards-header-vocabulary | fail | fail | fail | pass | pass |
| x-class-l2-decoy-l2 | fail | fail | fail | fail | pass |
| x-class-l3-page-size-2 | fail | fail | fail | fail | fail |
| x-wrapped-column-copy | fail | pass | pass | pass | pass |

Two interactions worth describing. In `x-class-l2-decoy-l2`, C's repair
*does* fire (2 LLM calls, heals the login step broken by class drift) —
and the trial still fails downstream: repair fixes locators, not
meaning, so co-occurring visible breakage doesn't rescue C from the
decoy. In `x-class-l3-page-size-2` the compound closes the one escape
route: class drift at L3 removes A's login hooks, so the only policy
that passes pure small-page scenarios also fails, and the cell goes
0/5 across the entire ladder.

## The readiness-gate finding

All four policies above A share one readiness predicate
(`waitForContent`, `packages/agent/src/core/domReady.ts`): stats content
counts as "ready" only when a visible table shows **≥ 5 rows** (or a
card grid ≥ 8 cards). A valid 3- or 2-row page is misclassified as
not-ready, every gated policy concludes the real table must be hidden
behind a reveal control, and each fails in its own idiom, every sweep:

- **B** — no repair available: "stats content never appeared".
- **B2** — the deterministic ladder clicks every candidate tab/strip,
  re-polls the same ≥5-row predicate, exhausts candidates, fails.
- **C** — LLM repair is asked to click a control that does not exist:
  1 call, fails.
- **D** — full semantic execution burns **10 LLM calls per failing
  trial**, every sweep, and still fails, because it re-checks readiness
  through the same predicate.
- **A** — never consults the heuristic (it waits for any row and walks
  the pager): passes all four pure small-page cells.

One hard-coded harness assumption sits upstream of every semantic
capability and defeats all of them at once; model inference cannot buy
the answer because the failure happens before the model is allowed to
see the page. Removing the five gate-blocked columns as a descriptive
cut (not a registered metric), the remainder orders B2 17/27 < C 20/27
< D 27/27: on the 27 cells the gate doesn't poison, full semantic
execution passed everything it was asked on this held-out grid.

## Cost (model-inference cost only, per §9)

A, B, and B2 ran at **zero model-inference cost** (machine-verified:
every keyless trial records `llmCalls: 0`). Keyed, averaged over five
sweeps each:

| | Per 32-scenario sweep | Per successful workflow | LLM calls / sweep |
| --- | ---: | ---: | ---: |
| C (LLM repair) | $0.1192 | $0.005960 | 31 |
| D (full semantic) | $1.0565 | $0.039128 | 247 |

D's per-sweep spend is ~8.9× C's (Phase 1 cold ratio: 8.61×), for the
seven decoy cells C cannot see and D can. D's spend is nearly flat
between winning and losing: 11 calls per passing decoy trial, 10 per
failing gate trial — the spend is constant; the gate decides whether it
buys anything.

Ledger close-out: replacement-grid entry costs sum to $5.878303; the
final ledger `spendUsd` is $8.213774; the difference is the
$2.274621 carried from the aborted first keyed attempt (an explicitly
approved exception, so the stop-threshold kept counting every recorded
dollar) plus $0.060850 banked by a window-close partial that was
discarded and rerun. The $39.90 stop-threshold — a pre-trial
recorded-spend threshold, not a total-cost bound — was never approached.
Full reconciliation and the transport-contamination incident that forced
the restart:
[`evidence/phase2a/report/KEYED_REPORT.md`](../evidence/phase2a/report/KEYED_REPORT.md)
and
[`KEYED_INCIDENT.md`](../evidence/phase2a/report/KEYED_INCIDENT.md).

## Prediction scorecard — 141 hit · 19 miss · 0 not-run

Sol's per-cell predictions, frozen before any trial, scored under the
registered semantics (all-pass ⇔ 5/5; observed-failure ⇔ 0–4/5):

| Policy | Hit | Miss |
| --- | ---: | ---: |
| A | 32 | 0 |
| B | 28 | 4 |
| B2 | 27 | 5 |
| C | 27 | 5 |
| D | 27 | 5 |

A was predicted exactly, including its instance-specific L1 split. **All
19 misses are one cluster** — the five readiness-gate columns, across
every gated policy (B's fifth gate column was predicted as a failure via
its login-drift path, so it scores as a hit). The suite's discovery is
precisely the thing its author didn't predict, which is what a held-out
suite is for. Misses are analysis results, never gate or verifier
failures.

## Interpretation (under the frozen language rules)

- On this held-out grid, structural addressing without repair (B)
  **underperformed the hardcoded baseline** (11 vs 15 cells): structure
  buys nothing under drift until a repair path exists.
- Deterministic repair (B2) is the strongest zero-model-inference-cost
  policy measured here (17 cells); its failures bound *this
  implementation* of deterministic repair, not the concept.
- LLM repair-on-failure (C) recovered three named/compound cells beyond
  B2 at ~$0.006 per successful workflow — but was trigger-blind on every
  decoy cell (zero calls) and gate-blocked with the rest.
- Full semantic execution (D) separated from C exactly on the silent
  decoys, at ~8.9× the per-sweep spend, and was perfect outside the
  gate cluster on this grid.
- No claim of equivalence or superiority in general is made: one model,
  one synthetic site, one task family, one frozen suite.

## Scope and limitations

- The suite was authored by one external reviewer under a frozen
  perturbation grammar; 32 scenarios probe chosen axes, not a
  population. Raw counts are reported without intervals by design
  (deterministic outcomes; the repetition question is answered by exact
  repeatability, not variance).
- The readiness-gate finding generalizes as a *pattern* (shared
  pre-semantic assumptions defeat downstream intelligence), not as a
  frequency claim about production systems.
- Keyless numbers were verified twice end-to-end; keyed numbers come
  from the single post-incident replacement grid, with the aborted
  attempt preserved and excluded
  ([incident report](../evidence/phase2a/report/KEYED_INCIDENT.md)).
- Grading is exact structured-output correctness against lab ground
  truth (accuracy 1.00 with full row coverage); a policy can only pass
  by being right, but "pass" is bounded by the lab's fidelity, which is
  synthetic by design.
