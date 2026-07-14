# Prospectively frozen keyed-experiment protocol

**Status: FROZEN at annotated tag `protocol-freeze-v3`** (supersedes
`protocol-freeze-v2` and `-v1` via the pre-key amendments of 2026-07-14 —
see §8; both earlier tags are preserved unchanged as the historical record,
and **no keyed trial was run under any tag before v3**). The keyless
benchmark results committed alongside this file carry provenance
(`gitCommit`, `gitDirty: false`, prompt and lockfile hashes) proving they
were generated at the freeze commit. The keyless benchmark results
in `runs/latest` already exist and predate this document; nothing here is
pre-registration for them. What this document freezes — *before any keyed
result has been observed* — is the methodology for the keyed experiment: the
engine policies, model, prompts, retry and cache rules, repetition counts,
metrics, and analysis plan. Any deviation after the freeze requires a new tag
and a documented amendment at the bottom of this file. The git tag's
timestamp is the proof that the method predates the results.

The claim under test: **does semantic execution, or selective semantic
repair, recover structural drift reliably enough to justify its cost?**
The keyless benchmark already established the free tiers' boundaries
(positional dies on any markup change, sometimes silently; structural
survives reorder/reword but not redesigns). The keyed experiment measures
whether paying a model closes the remaining gap — and what it costs.

---

## 1. Frozen engine configurations

Four configurations, one variable (how the page is addressed). All four share
the identical downstream pipeline — see §2.

| # | Configuration | Command | Policy |
|---|---|---|---|
| A | Positional baseline | `--engines baseline` | Hardcoded ids + fixed column indices; competent waits/retries/re-login; no header mapping; no LLM. |
| B | Structural deterministic | `--engines hybrid --no-repair` | Cached selector replay (`act(action)`, `selfHeal: false`) + header-name column mapping via the fixed synonym dictionary; repair paths hard-disabled; **guaranteed zero model calls** (asserted by test even with a key present). |
| C | Hybrid repair | `--engines hybrid` (key present) | B, plus: on cached-selector failure or no header-mappable table, ONE explicit repair per step — `observe()` → best Action → replay → heal cache; `extract()` as extraction repair using the identical instructions as D. Every repair is recorded in `healedSteps` and token accounting. |
| D | Full semantic | `--engines stagehand` (key present) | Instruction-driven `act`/`extract`/`observe` for ALL page addressing; credentials via act variables. Two hand-written deterministic **session-furniture guards** exist — direct consent-form submit and an overlay dismiss-button click — which fire only after the semantic act has already failed to clear that blocker; every firing is recorded on the trial (`deterministicFallbacks`, accumulated across ALL attempts including failed ones) and must be disclosed alongside any blocked-UI scenario result. |

**Frozen parameters** (values live in code at the tagged commit; listed here
for the record):

- **Model:** `anthropic/claude-haiku-4-5` (the repo default; `STAGEHAND_MODEL`
  must NOT be overridden during the campaign).
- **Prompts:** every fixed instruction string lives in the single-source
  registry `packages/agent/src/instructions.ts` (extraction instructions,
  the stagehand engine's act/observe instructions, and the hybrid's repair
  instructions); `promptsHash` in every results file is the sha256 of that
  sorted registry. No prompt edits mid-campaign.
- **Retries:** `maxAttempts: 2` per trial (one retry); validation failures
  never retry (deterministic data property). Unchanged from the keyless runs.
- **Scenario seeds:** frozen in `packages/shared/src/scenarios.ts`
  (seeds 1101–1124); the catalog of 24 scenarios is closed for the campaign.
- **Judge:** perfect extraction — accuracy 1.0 with full row coverage on both
  pages (override-aware scoring; 0.02 decimal tolerance for American-odds
  round-trips); a successful pipeline with no accuracy sample fails.
- **Outcome taxonomy:** pass / recovered / safe-failure / silent-corruption /
  hard-failure, computed from behavior, orthogonal to the judged outcome.
- **Repetitions:** N = 5 per scenario for every keyed configuration.

## 2. Shared-pipeline invariant

Every configuration feeds the **identical** post-extraction path:

```
engine-specific extraction
        ↓
shared normalization      (packages/agent/src/core/normalize.ts)
        ↓
shared domain validation  (packages/shared/src/quality.ts)
        ↓
shared ground-truth grader (packages/agent/src/core/score.ts)
```

No engine gets a different validator, schema, or grader. The comparison
isolates addressing strategy, not pipeline quality.

## 3. Cache policy (cold by construction)

| Configuration | Stagehand server cache | `cacheDir` action cache | `selfHeal` | Selector cache |
|---|---|---|---|---|
| A baseline | n/a (no Stagehand) | n/a | n/a | none |
| B structural | not reachable (`env: LOCAL`, `disableAPI: true`) | unset | `false` | bootstrap, fresh per trial |
| C hybrid repair | not reachable (same) | unset | `false` | bootstrap fresh per trial (cold); `--seed-cache <healed-cache.json>` (persistence/warm) |
| D full semantic | not reachable (same) | unset | `false` for act-replay paths; engine uses live inference per step | none |

"Cold" therefore means: local Chrome, no Browserbase server cache possible,
no on-disk action cache, no reused selector repairs. **Warm** applies only to
configuration C and means exactly one thing: the trial's initial cache is a
`healed-cache.json` produced by a prior repair run, supplied via
`--seed-cache`.

## 4. Key-in triggers

All six must hold before `ANTHROPIC_API_KEY` enters `.env`:

1. Perfect-extraction judge merged. ✅ (Wave C)
2. Outcome taxonomy + all three silent-corruption denominators visible in
   results.md and the dashboard. ✅ (Wave C)
3. `--no-repair` tested to guarantee zero model calls. ✅ (Wave C)
4. Shared normalize → validate → grade path confirmed for every engine. ✅
   (architectural invariant, §2)
5. This document committed and tagged (`protocol-freeze-v1`; superseded
   pre-key by `protocol-freeze-v2`, then `protocol-freeze-v3`, after the
   second and third external audits — §8).
6. Repo clean; the pre-key benchmark reruns deterministically (two
   consecutive keyless runs produce identical outcome / outcomeClass /
   accuracy vectors; durations may differ).

## 5. Smoke test (first keyed action — NOT benchmark evidence)

Four scenarios only, one trial each, before any campaign sweep. Every smoke
run is launched with `--purpose smoke`, which stamps `runPurpose: "smoke"`
into the results file — and `campaign:aggregate` **unconditionally refuses**
to aggregate smoke runs together with campaign evidence (`--allow-mixed`
does not override this). Evidence separation is machine-enforced, not a
labeling convention.

| Scenario | Configuration | Verifies |
|---|---|---|
| clean-extraction | D full semantic | model genuinely called; token accounting populates; output flows through the shared validator |
| class-drift | D full semantic | semantic addressing on drifted markup |
| schema-violation | D full semantic | whether an LLM extractor also refuses corrupt data (class safe-failure) or "fixes" it silently (class silent-corruption) — calibrates the grader under LLM conditions |
| class-drift | C hybrid repair | repair activates, heals the cache, `healedSteps` + tokens recorded |

Acceptance: costs roughly within expectations (order: cents), **computed —
not eyeballed** — by running `pnpm campaign:aggregate` over the smoke
directory, which prices recorded tokens against the pinned table in
`packages/agent/src/reliability/prices.ts` (Haiku 4.5: $1 input / $5 output
per MTok, pinned 2026-07-14). Smoke artifacts are labeled smoke and
**excluded from published results**; smoke outcomes are never cited as
evidence regardless of what they show.

## 6. Campaign (in order, all local Chrome)

**Trial isolation (enforced by construction):** every benchmark run owns a
**private lab on its own ephemeral port** — runners never reuse an unowned
lab, so concurrent or interrupted runs cannot touch this run's scenario
state (`--lab-url` transfers ownership to the caller, with a warning). Every
trial browser launches with `--disable-http-cache`, so a page can never be
served from a previous trial's cache. Leftover Stagehand browsers from
other runs are logged as a warning-only forensic census at bench start.
(Both protections were added after the determinism gate caught real
cross-trial contamination — see WRITEUP.md, "What broke".)

**Metric definitions:** silent corruption is reported over three
denominators — D1 total trials; D2 judged failures (`outcome === "fail"`;
silent corruption is always a subset of D2); D3 accepted outputs (classes
pass + recovered + silent-corruption). For the committed keyless run these
are 48 / 10 / 36. `llmCalls` counts Stagehand inference operations; token
counts are provider-reported via Stagehand metrics, accumulated across ALL
attempts of a trial (a failed attempt's spend is never discarded). Dollar
costs are computed at analysis time from recorded tokens and the pinned
price table (`packages/agent/src/reliability/prices.ts`, pinned 2026-07-14;
an unknown model yields cost `null`, never a guess) — never estimated fields
in raw results. Class `recovered` requires a recorded semantic repair
(`healedSteps` nonempty); retry-only successes are reported separately as
`retryRecoveries`. Persistence runs use per-scenario seed caches via
`--seed-cache-manifest`, harvested from repair sweeps by `pnpm heals:collect`
under a **frozen selection rule** (the first healed trial per scenario in
results order, recorded in the manifest as `selectionRule`); the manifest
carries full provenance — source benchId, trial runId, producing git commit,
model, promptsHash, and a **per-cache content sha256**. At bench start every
referenced cache file is re-hashed and verified against the manifest (a
mismatch aborts the run), and the recorded `seedCacheHash` covers the
**verified cache contents**, not just the manifest text — a cache file can
no longer change without changing the recorded hash. Cross-run campaign
reporting comes from `pnpm campaign:aggregate` (raw counts, median, min–max
— never reduced to majority pass/fail), which groups by **scenario ×
configuration** (A / B / C-cold / C-persistence / C-warm / D, derived from
each run's recorded `disableRepair`, `seedCacheMode`, model-key state, and
`runPurpose` — every run records why it exists: smoke | cold | persistence |
warm, validated against its seeding mode at launch) and **refuses** to
aggregate runs whose model or promptsHash disagree unless `--allow-mixed`
is passed explicitly; smoke runs never aggregate with evidence under ANY
flag. Cost accounting is strict: a trial with `llmCalls > 0` is priced only
when the provider reported BOTH token sides (a missing side yields an
unpriced trial, never a silent half-cost); `llmCalls === 0` and baseline
trials price as an exact $0; every cost total carries its **coverage**
("n/m trials priced") and is marked an INCOMPLETE lower bound whenever
coverage is partial. The campaign report renders, per configuration, the
three frozen silent-corruption denominators (D1/D2/D3), the
deterministic-fallback firing counts, and **cost per successful workflow**
— machine-readable in `configTotals`, not just prose. The keyless seed-cache test proves replay mechanics only; that
semantic repair produces *valid* caches is a keyed question answered by
campaign step 3.

1. **Five cold full-semantic sweeps** (D × 24 scenarios × 5).
2. **Five cold hybrid-repair sweeps** (C × 24 × 5, bootstrap cache each trial).
3. **Persistence runs, paired per sweep:** each of the five step-2 sweeps is
   harvested with `pnpm heals:collect` into its own manifest, and C is re-run
   once per manifest (`--seed-cache-manifest`, `--purpose persistence`) in
   fresh browsers — five persistence runs, each seeded exclusively from its
   own source sweep's repairs. "Persistently repaired" = judged pass with
   `llmCalls === 0`.
4. **One warm-cache economics sweep** (C × 24, seeded from the FIRST step-2
   sweep's manifest — fixed in advance so the choice can't chase results —
   with `--purpose warm`, so it aggregates as `C-hybrid-repair-warm` and can
   never blend with step 3's persistence cells even though it shares
   sweep 1's `seedCacheHash`): steady-state cost and latency.
5. **Analysis and publication** (§7). Browserbase is added **afterward, as a
   hosted demonstration only** — never a requirement for the core benchmark,
   so model behavior stays the only new paid variable in steps 1–4.

## 7. Metrics and statistics discipline

Reported per configuration, and per scenario where meaningful:

- Judged pass rate; outcome-class counts.
- **Silent corruption with three denominators**: /total trials, /failed
  trials, /accepted outputs (the headline: "of the data the pipeline vouched
  for, how much was wrong").
- Accuracy: mean and median (diagnostic; the judge itself is binary at 1.0).
- Latency: median and min–max range per scenario; percentiles only pooled
  across all trials of a configuration. **No per-scenario P95 at N=5.**
- Tokens (input/output) and dollars per trial and per sweep, from recorded
  usage — never from estimates.
- Recovery, split: `recovered` (within-run) vs **persistently repaired**
  (later-run pass at zero additional LLM calls, from §6.3).
- Variance: raw counts and ranges. No standard-deviation theater at N=5.
- The decision metric: **probability of undetected incorrect data per
  dollar** — silent-corruption rate over accepted outputs, against cost per
  successful workflow.

## 8. Amendments

Any post-freeze change: add a dated entry here, bump the tag, and disclose
it in the writeup.

### 2026-07-14 — `protocol-freeze-v2` (pre-key; second external audit)

A second external audit of `protocol-freeze-v1` found four material gaps.
All were fixed **before any API key entered the environment** — no keyed
trial was ever run under v1, so nothing here is a post-hoc change to a
methodology that had produced results. The v1 tag is preserved unchanged.

1. **Configuration D was misdescribed.** The frozen table claimed "no
   hand-written fallback selectors," but the stagehand engine contains two
   deterministic session-furniture guards (direct consent-form submit,
   overlay dismiss-button click) that fire when the semantic act fails to
   clear a blocker. The description is now honest (§1), and every guard
   firing is recorded per-trial in a new `deterministicFallbacks` field so
   blocked-UI results can never silently lean on hand-written code.
2. **The pinned price table now exists.** `packages/agent/src/reliability/
   prices.ts` pins Haiku 4.5 at $1 input / $5 output per MTok (2026-07-14);
   `pnpm campaign:aggregate` computes dollars per trial/sweep from recorded
   tokens against it, and the smoke test's "order: cents" acceptance is
   computed the same way (§5). Unknown models price as `null`, never a guess.
3. **Seed caches are cryptographically pinned.** Heals manifests now record
   per-cache content sha256 plus source benchId, trial runId, git commit,
   model, and promptsHash, under a frozen selection rule
   (first-healed-trial-in-results-order). Every cache is re-hashed and
   verified at bench start, and `seedCacheHash` covers verified cache
   contents rather than manifest text (§6). Campaign step 3 is now
   explicitly paired — one persistence run per source sweep's own manifest —
   and step 4's warm sweep is fixed in advance to the first sweep's manifest.
4. **Campaign aggregation is configuration-aware.** `campaign:aggregate`
   groups by scenario × configuration (derived from recorded `disableRepair`,
   `seedCacheMode`, and model-key state), so cold, persistence, and warm
   hybrid runs can never silently blend, and it refuses to mix runs whose
   model or promptsHash differ without an explicit `--allow-mixed` (§6).

Two disclosure-level corrections ride along: `promptsHash` is now computed
from a single-source registry of **all** fixed instruction strings
(`packages/agent/src/instructions.ts` — the stagehand act/observe
instructions were previously omitted, and the hybrid repair strings were a
hand-maintained mirror), so v2 promptsHash values differ from v1 by
construction; and README/WRITEUP silent-corruption denominators were
normalized to the frozen D1/D2/D3 (a per-engine figure had used
outcome-class passes instead of judged passes). The keyless benchmark
evidence in `runs/latest` was regenerated at the v2 freeze commit with the
determinism gate re-verified.

### 2026-07-14 — `protocol-freeze-v3` (pre-key; third external audit)

A third audit verified the v2 freeze mechanics end-to-end (remote tags, hash
recomputation, tamper detection, concurrent-bench isolation, vector match
with v1) and found three **machine-enforcement gaps** — places where the
protocol promised a discipline the code did not yet enforce. All fixed
pre-key; v1 and v2 tags preserved; still no keyed trial under any tag.

1. **Run purpose is now recorded and enforced.** Every run stamps
   `runPurpose: smoke | cold | persistence | warm` (validated against its
   seeding mode at launch). Aggregation keys include it — paired persistence
   runs and the warm economics sweep land in distinct configurations
   (`C-hybrid-repair-persistence` / `C-hybrid-repair-warm`) even when they
   share a manifest, closing a silent blend v2's own amendment had wrongly
   claimed impossible. Smoke runs are machine-excluded from evidence:
   `campaign:aggregate` refuses smoke+evidence mixes unconditionally.
2. **"Every firing is recorded" is now literally true.** Deterministic
   session-furniture fallbacks (and the hybrid's healed steps) accumulate
   across ALL attempts — including failed attempts and wholly-failed trials,
   which previously vanished from the record via the final-attempt-only
   copy. Campaign reports render the firing counts.
3. **Cost accounting is strict and coverage-honest.** A trial with
   `llmCalls > 0` prices only when both token sides were reported (v2 could
   silently emit half-costs from a missing side); zero-inference and
   baseline trials price as exact $0; every total carries "n/m trials
   priced" coverage and is flagged an INCOMPLETE lower bound when partial.
   The campaign report now renders the protocol-promised D1/D2/D3
   silent-corruption denominators, fallback counts, and cost per successful
   workflow, machine-readable in `configTotals`.

The keyless evidence in `runs/latest` was regenerated at the v3 freeze
commit with the determinism gate re-verified.
