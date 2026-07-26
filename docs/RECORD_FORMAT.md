# Evidence-complete trial records (record version 2)

**Status: shipped at `record-v2-freeze-v1`.** Applies to all
campaigns after Phase 2A. Existing evidence bundles (Phase 1, Phase 2A) are version-1
records and are never rewritten; the verifier treats them as
"counters attested, not recomputable from raw output" and says so in
its report.

## The gap this closes

A version-1 trial record stores the *outputs of grading* (row-coverage
and field-accuracy counters) but not the *inputs to grading* (the rows
the engine actually extracted, and the oracle rows they were compared
against). The frozen verifier can therefore re-derive every pass/fail
verdict from the counters, but a third party cannot recompute the
counters themselves: the raw extractions live in machine-local `runs/`
artifacts that evidence bundles do not include. Version 2 embeds the
grading inputs in the portable record, so the public verifier can
recompute accuracy from raw output instead of trusting it.

## Additions (all optional in the schema; presence implies v2)

Per-trial (`TrialResult`):

- `recordVersion: 2` — absent means version 1.
- `canonical` — the grading inputs, shipped at two stages. `raw`: the
  pre-normalization extraction payloads per page, shipped **verbatim**
  as `unknown | null` — the same values the pipeline's own schema
  checks consumed, recorded with no reshaping of any kind. `stats`/`odds`: the
  normalized rows the scorer consumed. `failures`/`warnings`: the
  dataset annotations normalization produced. Because `raw` ships,
  everything downstream of it is re-derivable, so the normalized rows,
  failures, and warnings are cross-checks, not assertions: a shipped
  value that does not follow from `raw` fails verification. The record
  layer imposes no shape on `raw` at all: any validation there would
  make the extraction schema checks pass by construction, and any
  reshaping would alter what an honestly malformed payload's
  schema-error detail recomputes to. Null semantics follow the pipeline exactly: both
  row pages are null exactly when no normalized dataset was built (the
  same condition that records `accuracy: null`), and rows-null
  therefore requires raw-null; a single-page `raw` null alongside
  present rows is legitimate (that page's extraction produced no
  payload while normalization still built the dataset), but a
  single-page *rows* null is malformed and fails verification. A page
  that was scored but yielded nothing records an empty array, never
  null. Size: a 12-team league remains a few KB per trial.
- `recordVersion` semantics: version-1 records predate the field and
  normally omit it; an explicit `recordVersion: 1` is accepted and
  means the same thing. All trials in one run must declare the same
  version — a mixed run fails verification — and the verifier's
  `--expect-record-version 2` flag (mandatory for Phase 2B and later
  campaigns) fails any bundle containing a trial that does not declare
  version 2, so a record cannot be "downgraded" out of recomputation.
- `stepTrace` — why escalation did or did not fire, step by step, with
  the stages the trigger framing needs kept separate: `{ step,
  cachedSelectorMatched, readinessOutcome, escalationTriggered,
  repairAttempted, repairSucceeded, repairKind ("llm" | "deterministic"
  | null), modelCallsAtStep, downstreamRecovered, note }`. A trigger
  that activated, a repair that was attempted, a repair that succeeded,
  and a step that then recovered downstream are four different facts
  and are recorded as four fields. Engines fill what they genuinely
  know: the hybrid engine (B/B2/C) records the full trigger evaluation;
  stagehand records its deterministic-fallback and model-call sites;
  the baseline records nothing (it has no escalation machinery). A
  field an engine cannot honestly populate is omitted, never guessed.
  The trace is reconciled, not free-standing, and each recorded field
  is reconciled under its own documented semantics: Σ
  `modelCallsAtStep` against `tokens.llmCalls`; successful LLM repairs
  against `healedSteps`; successful deterministic repairs against
  `deterministicRepairSteps`; and *attempted* deterministic repairs
  against `deterministicFallbacks`, which records that a guard fired,
  not that it cleared the blocker. None of this is optional for
  engines that have the machinery: a v2 record from a non-baseline
  engine must ship non-null `tokens` and a non-empty trace whose
  entries carry `modelCallsAtStep`, so the reconciliation cannot be
  silenced by deleting the trace, its counters, or the token block —
  each strip is itself a violation. Honest scope: the reconciled
  fields are exactly the four above plus the logical invariants
  (`repairSucceeded` ⟹ `repairAttempted` ⟹ `escalationTriggered`;
  `downstreamRecovered` only alongside a successful repair; a
  successful LLM repair entry carries `modelCallsAtStep ≥ 1`; a
  matched cached selector cannot itself be the escalation trigger).
  `cachedSelectorMatched`, `readinessOutcome`, most `escalationTriggered`
  values, and every `note` remain attested narrative — constrained,
  not independently re-derived.
- `pagesRequested` — which pages the pipeline was asked to extract
  (absent means both); the verifier recomputes the extraction verdict
  over exactly this set, so a future single-page run cannot
  false-positive.

Per-run (`BenchmarkResults`):

- `oracles` — map from `scenarioId` to the exact ground-truth slice
  used for grading that scenario: `{ truth, overrides }`. Run-level so
  each oracle ships once, not once per trial; trials reference it via
  their existing `scenarioId`.
- `environment.modelConfig` — `{ temperature: number | null,
  temperatureSource: "explicit" | "provider-default" | "n/a-no-model" }`.
  Today no code sets a temperature anywhere: a run with no configured
  model records `n/a-no-model` (verified on live keyless output), and
  a model-bearing run records `provider-default` — the honest
  statement of what Phase 1 and 2A actually did.
- Chrome provenance is **per-trial** (`TrialResult.chromeVersion`): the
  browser build that executed that trial, acquired at engine init only
  (Playwright's version accessor on the baseline; a timeout-guarded
  read of the CDP `/json/version` endpoint on Stagehand-backed
  engines, retried within a bounded init budget — metadata only,
  never on any page path, never per-step); null when unavailable. The
  build is recorded whether or not the attempt completed: a trial
  whose attempts all threw still names the browser that executed it. `environment.chromeVersion`
  is emitted only when every executed engine in the run reported a
  version and all reported the same one; otherwise it is null — a run
  is never labelled with one engine's browser. Values are recorded
  verbatim, never normalized, and the two engine families genuinely
  run different browsers (the baseline launches Playwright's bundled
  Chromium; Stagehand-backed engines drive the installed system
  Chrome), so a null run-level value on mixed-engine runs is the
  expected, honest reading.
- `environment.pricesPinnedAt` — the pinned price-table date used for
  cost derivation (`packages/agent/src/reliability/prices.ts`).

The deterministic judge's decision and reason are already recorded
(`outcome`, `outcomeReason`, `outcomeClass`) and already re-derived by
the verifier; v2 does not duplicate them.

## Verifier behaviour

For every v2 record with shipped payloads, `verify:suite` re-runs the
pipeline's entire grading chain from `canonical.raw`, using the same
modules the runner uses at every stage: (1) the extraction schema
checks — so `extractionSuccess` is recomputed, not attested; (2)
normalization — the derived rows, failures, and warnings must equal
the shipped ones; (3) the domain assessment (`assessDataset`) — so
`validationSuccess` is recomputed; (4) the pipeline identity —
`pipelineSuccess` must equal `extractionSuccess && domainOk`; (5)
accuracy scoring against the seed-re-derived oracle; (6) the judge;
(7) the failure attribution — for records whose payloads were
produced, `failureCategory` and `failureDetail` follow
deterministically from the recomputed extraction and domain verdicts
(the pipeline derives them as extraction-vs-validation plus the check
issues), so both are recomputed; only crash-class records keep an
attested category. Any divergence at any stage fails verification.
The run-level `environment.chromeVersion` is re-derived from the
per-trial values under the same unanimity rule, and a no-payload
record must satisfy its class invariants exactly: no success flag of
any kind (including `extractionSuccess`), `accuracy: null`, empty
`failures`/`warnings`, and never `failureCategory: "validation"` —
the one category the judge can convert into a pass, and one the
pipeline derives only after payloads exist. (`extraction` stays legal
here: a step can throw with that category before any payload is
produced, and real keyless evidence does exactly that.) That
constraint is what keeps
evidence deletion from manufacturing an *expected* categorized failure
on a failure-expected scenario, the one path by which deletion could
otherwise reach a judged pass.

Provenance is part of the record, and deleting it is a violation, not
a downgrade. A v2 run must ship `environment.modelConfig` and
`environment.pricesPinnedAt`; every v2 trial must carry its
`chromeVersion` key, and the run must carry
`environment.chromeVersion` (whose value is still re-derived under
the unanimity rule). An explicit `null` records the honest "version
read failed" or "no unanimity" case; an *absent* key fails
verification, and each of these deletions lives on as a named
regression (`ATTACK-PROVENANCE-STRIP-*`). Presence is not
consistency, and both are required: `modelConfig` must match the run
it describes — `n/a-no-model` exactly when the run configures no
model (and then `temperature: null`); `provider-default` only when a
model is configured (and then `temperature: null`); `explicit` only
with a numeric temperature. Each contradiction is a named regression
(`ATTACK-MODELCONFIG-*`). And a run that configures no model cannot
have spent inference: every trial on such a run must record
`tokens: null` or an all-zero token block — every usage counter and
cost field zero, not just `llmCalls` — so a keyed record cannot be
laundered into a modelless one while its own trials still count the
calls or the tokens (`ATTACK-MODELCONFIG-CALLS-WITHOUT-MODEL`,
`ATTACK-MODELCONFIG-USAGE-WITHOUT-MODEL`). An offline verifier cannot
tell an honest recorded `null` from a substituted one — that boundary
stands — which is why Phase 2B additionally requires non-null
per-trial values, the exact frozen model and price date, and one
browser build per policy across both arms
([PROTOCOL_2B.md](PROTOCOL_2B.md)).

v2 recompute is certified for fresh-session scenarios expecting
success or a categorized failure. The `session: reuse` and
`success-with-warnings` judge branches read inputs v2 does not yet
ship (login-step presence; warning-based acceptance), so the verifier
refuses — with an explicit violation, never a silent partial replay —
any v2 record whose scenario declares an unsupported mode, until those
inputs ship. What remains attested,
stated as the format's boundary: the raw payloads' own authenticity,
the facts of a crash that produced no payload, and timing/token
measurements (the latter reconciled against the step trace where both
exist). The provenance tally distinguishes three classes:
recomputed-from-raw, v2 hard-failure records (no payload produced;
consistency-checked, nothing to recompute), and attested v1.

The shipped oracle is itself never trusted. Because the lab derives
ground truth deterministically from the scenario's seed, the verifier
re-derives the truth from the **supplied suite's** seed (and the
overrides from the scenario's own parameters) via the shared generator,
and fails verification if the run's `oracles` entry differs from the
re-derivation. A v2 record therefore cannot be forged by editing rows
and oracle together — the same principle as the frozen "grade against
the suite's oracle, never the run's own" rule that closed the
run-local-oracle exploit in protocol revision 6. For v1 records it
performs the existing counter-based re-grade and counts the record in a
clearly labelled "attested (v1)" total in its report, so mixed bundles
are legible at a glance.

## What verification proves — and what it cannot

The verifier proves that every published number follows from the
shipped bytes and the frozen suite: the grading chain is re-derived
end to end, the oracle is the suite's, and every tested forgery class
fails loudly (each closed attack lives on as a named regression test).
It does not prove the bytes themselves are authentic. Absent signed
browser or provider evidence, a fabricator who invents an entire,
internally consistent trial — oracle-perfect raw payloads, coherent
metadata, reconciled traces — is outside what any offline
re-derivation can catch. The same boundary covers deletion: an offline
verifier cannot distinguish "payload never produced" from "payload
deleted after the fact", so a record can be degraded toward the
hard-failure class by discarding its own evidence — visible in the
provenance tally, constrained by that class's invariants, and always
degrading toward fail, never toward pass. Diagnostic bytes that change
no verdict (an invalid payload versus a deleted one) are likewise
indistinguishable. The accurate claim is "every tested attack is
closed and every number follows from the records"; "forgery is
impossible" is not a claim this format makes, and no document in this
repo should make it.

## Compatibility rules

- Additive only: every new field is optional; v1 bundles must keep
  verifying byte-for-byte (`pnpm verify:suite evidence/phase2a/runs/*`
  stays PASS).
- Frozen tags are untouched; the v2 recorder and verifier live at HEAD
  and apply to future campaigns (first consumer: Phase 2B,
  [PROTOCOL_2B.md](PROTOCOL_2B.md)).
- A re-run of the Phase-2A verify command now prints an additional
  `## grading provenance` section relative to the frozen transcript at
  `evidence/phase2a/report/verify.final.txt`; the transcript's bytes
  and checksum are unchanged, and the verdict lines are identical.
- Campaign duplicate-rejection hashes cover trial content; v2 records
  of new runs hash differently from v1 records by construction, which
  is correct — they are different records.
