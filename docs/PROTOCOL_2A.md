# Phase 2A protocol — the policy frontier

**Status: DRAFT (revision 2, after external design review) — not yet
frozen.** This document specifies Phase 2A before any of it is implemented.
It becomes binding at the stage-1 tag (`phase2a-policy-freeze-v1`) and is
completed by the stage-2 tag (`phase2a-suite-freeze-v1`); no keyed trial may
run before the stage-2 tag exists. Phase 1 ([PHASE1_RESULTS.md](PHASE1_RESULTS.md),
protocol [PROTOCOL.md](PROTOCOL.md), frozen at `protocol-freeze-v4`) is
complete and untouched — Phase 2A never modifies Phase-1 evidence, its
scenario catalog (seeds 1101–1124, closed), or its interpretation.

**The questions.** Phase 1's keyed policies passed every scenario; the suite
separated the free tiers from the keyed tiers but contained no case that
separates the keyed policies from each other except on cost. Phase 2A probes
two boundaries, each with machinery designed for it:

- **The B2–C boundary:** what does *LLM repair* buy over a deterministic
  repair ladder with the same cache, the same reader, and the same trigger?
- **The C–D boundary:** what does *per-step semantic addressing* buy over
  repair-on-failure? C only repairs what visibly fails; a perturbation that
  makes a cached action *succeed against the wrong target* never triggers
  repair. The decoy axis (§3, F2) is built for exactly this.

Results are reported as **first observed failure** per policy under each
perturbation series — never as "where the policy stops working" (an
unobserved generalization).

**Two-stage freeze (author separation).**

1. **Stage 1 (repo author):** freeze the five policies (including the new
   deterministic-repair policy B2), all prompts/instructions, validator,
   judge, budgets, the *perturbation machinery* (parameterized axes), the
   generic suite loader/verifier, and the diff gate.
   Tag: `phase2a-policy-freeze-v1`.
2. **External audit** of the stage-1 freeze (sol).
3. **Reveal:** sol authors the held-out scenario package — a machine-readable
   JSON of concrete axis values (vocabularies, permutations, copy strings,
   levels), seeds, session modes, expected outcomes, analysis-stratum labels,
   and per-policy predictions, plus its SHA-256. Authored after the policy
   freeze, so no policy can be tuned to it and no scenario can be tuned to a
   policy change.
4. **Fixtures only:** the repo author commits sol's JSON **byte-for-byte**
   (hash-verified, no transcription) plus the protocol appendix. A **diff
   gate** (§6) machine-verifies nothing outside that allowlist changed
   between the two tags.
5. **Stage 2 tag** freezes the complete suite. Keyless gates → smoke → the
   full fixed grid. **No adaptive stopping** (§7). Keyless results cannot
   alter, reorder, or cancel any part of the frozen keyed grid.

The principle: *the perturbation grammar is frozen first; the test sentences
are held out.*

---

## 1. Frozen policy ladder

Five addressing policies. **No policy is claimed byte-identical to
Phase 1.** The exact carry-forward status of each:

| Policy | Engine | Flags | Element addressing | Repair on failure | Model inference |
| --- | --- | --- | --- | --- | --- |
| **A** baseline | `baseline` | — | Hardcoded ids + fixed column indices | Retry, re-login, JSON-island pagination fallback | Zero (by construction) |
| **B** structural | `hybrid` | `--repair-mode off` | Cached Stagehand Actions + header-name mapping | None (categorised failure) | Zero (machine-enforced) |
| **B2** deterministic repair *(new)* | `hybrid` | `--repair-mode deterministic` | Same as B | Deterministic re-location ladder + deterministic card reader (§2); same *triggers* as C | Zero (by construction: the code path contains no model call; every B2 trial must record `llmCalls: 0`) |
| **C** hybrid repair | `hybrid` | `--repair-mode llm` (default) | Same as B | One key-gated LLM repair per broken step (`observe` for failed actions; `extract` — the same frozen instruction D uses — when no header-mappable table exists); action repairs cached, extraction repairs re-inferred | Key-gated, counted |
| **D** full semantic | `stagehand` | — | Model-driven addressing and extraction on every semantic step (login acts, reveal observe/act, two extracts, pagination acts), behind two disclosed deterministic UI guards (consent, dismiss-modal) | Semantic by construction | Every semantic step |

**Carry-forward disclosures.**

- **A, B:** code paths unchanged from Phase 1.
- **C:** shares the hybrid engine with B2's new flag plumbing. The
  `llm`-mode dispatch must be left behaviorally identical; stage-1 tests
  assert the llm branch's call structure is unchanged, and the frozen
  instruction registry must still hash to Phase 1's `promptsHash`
  (`5c07ce1fbc35…`) — any change is a §10 amendment with rationale.
- **D:** carried forward with **one disclosed guard correction** (§2a): the
  Phase-1 dismiss-modal fallback's text matcher
  `/no thanks|close|dismiss|x/i` is unanchored — its `x` alternative
  matches any button whose text merely *contains* the letter x
  ("Ne**x**t"). Harmless against Phase-1's fixed lab copy; unsound against
  held-out copy. Corrected before the policy freeze to an anchored
  whole-text match (§2a). This is a Phase-2 correction to D, applied and
  disclosed — Phase-1 results are not restated.

Flag migration: `--repair-mode off|deterministic|llm` supersedes
`--no-repair`; `--no-repair` remains a frozen alias for `--repair-mode off`.
`environment.repairMode` is recorded in `results.json`; the aggregator
labels `hybrid + repairMode=deterministic` as configuration
`B2-deterministic-repair`. All Phase-1 configuration labels are unchanged.

## 2. Policy B2 — the deterministic repair ladder (operational specification)

B2 answers the "B is not the strongest free baseline" threat. It is the
hybrid engine with repair enabled but **no model call in the code path**:
where C calls `observe`/`extract`, B2 runs the following heuristics. All
DOM predicates below are class-free and id-free. Definitions used
throughout:

- **visible**: `getBoundingClientRect()` has positive area and computed
  `visibility !== "hidden"` and `display !== "none"`.
- **enabled**: not `disabled` and computed `pointer-events !== "none"`.
- **candidate order**: document order (`querySelectorAll` order).
- **label–value pair**: a `dt`/`dd` pair inside a `dl`, or an element pair
  where the first child's text is non-numeric and the second's parses under
  the same cell parsers B uses.

**Action re-location, per step** (fires only on the same trigger as C: the
cached action failed):

- `username` / `password` / `login-submit`: locate the first visible form
  containing an `input[type=password]`. `password` = that input.
  `username` = the last visible `input` of type text/email (or typeless)
  preceding it in that form. `login-submit` = the form's first visible
  enabled `[type=submit]`, else its only visible enabled button.
- `consent`: the first visible form whose submit target is the consent
  endpoint **or** — generalized beyond the Phase-1 guard, which hardcodes
  `form[action="/consent"]` — the first visible form inside a
  fixed-position element covering >50% of the viewport; click its first
  visible enabled button.
- `dismiss-modal`: inside the first fixed-position element covering >50% of
  the viewport, click the first visible enabled `button`, `[role=button]`,
  or `a` whose **trimmed whole text** matches
  `/^\s*(no thanks|close|dismiss|×|x)\s*$/i` (the §2a corrected matcher,
  shared with D's guard).
- `reveal-table`: candidates, in document order: visible enabled elements
  with `role=tab`; then visible enabled `button`/`a` elements inside a
  `nav`, `[role=tablist]`, or an ancestor whose children are ≥2 sibling
  `button`/`a` elements (a tab-strip signature). Click candidates in order
  (≤5), running the existing content-ready poll after each; stop at first
  success.
- `next-page`: within the smallest ancestor containing the current-page
  indicator and ≥2 `button`/`a` controls (the pager signature), the first
  visible enabled control with `rel="next"` or trimmed text matching
  `/^\s*(next|more|»|→|older)\s*$/i`; else the last visible enabled control
  in that container. Page-merge budget identical to B/C.

**Deterministic extraction repair** (same trigger as C's extract repair —
no header-mappable `<table>` found): find the largest set of ≥4 sibling
blocks each containing ≥3 label–value pairs; map labels through the **same
frozen synonym dictionaries B and C use** (`STAT_SYNONYMS`/`ODDS_SYNONYMS`,
unchanged from Phase 1); apply the same field thresholds as the table path
(≥4 stat fields; match + ≥3 odds value fields). No new vocabulary: B2's
dictionary *is* B's dictionary — that boundary is the measurement.

**Recording (schema addition, stage 1):** B2 records successful heuristic
repairs in a **new optional trial field `deterministicRepairSteps`**.
`healedSteps` keeps its frozen Phase-1 meaning — semantic (LLM) repair —
and B2 never writes it, because the frozen classifier
(`metrics.ts` `classifyOutcome`) upgrades a trial that would otherwise
class as `pass` (accepted, perfect accuracy, expected success) to
`recovered` when `healedSteps` is nonempty — the field means semantic
repair. A successful B2 trial is class
**`pass`**, with deterministic-repair activation reported separately.
B2 heals its in-memory cache for within-trial replay but **never persists a
healed cache** (Phase 2A is cold-only; a deterministic-heal artifact would
overload the Phase-1 meaning of `healed-cache.json`).

**Failure strings:** `"cached selector failed; deterministic repair found
no candidate (repair-mode=deterministic)"` and `"no header-mappable table
found; deterministic card reader found no mappable structure
(repair-mode=deterministic)"`, with the same category conventions as B.

**Disclosed boundaries, stated in advance:** B2's text patterns are frozen
English regexes — held-out UI copy outside them defeats those rungs. B2's
readers cannot map any header/label outside the frozen dictionary. Decoy
rebinding (§3 F2) defeats B2's *triggers* — a decoy click "succeeds", so no
repair fires. These are the policy, not bugs; mid-campaign fixes are
prohibited. Where B2 fails and C survives, the difference is what LLM
repair buys; where both fail and D survives, the difference is what
per-step semantics buys.

### 2a. Guard correction applied to D (and shared by B2)

`clickOverlayDismiss` in the stagehand engine (and B2's reuse of it)
changes its matcher from `/no thanks|close|dismiss|x/i` tested against raw
`textContent` to `/^\s*(no thanks|close|dismiss|×|x)\s*$/i` tested against
trimmed whole text, and widens candidates from `button` only to `button`,
`[role=button]`, `a`. Recorded here as the single code change to a Phase-1
policy; it alters no Phase-1 result and is applied before the stage-1 tag.

## 3. Perturbation machinery — the frozen axes

Machinery (renderers, config plumbing, schema) is frozen at stage 1; the
*values* are held-out scenario data. Ground truth is never affected:
headers, labels, class names, decoys, and layout are presentation; truth
always comes from `/__lab/ground-truth`.

**Precedence and contradiction rule (enforced in lab config validation and
the suite loader):** for any rendering surface, a scenario uses the legacy
binary chaos flag **or** the new parameter, never both. Contradictory
combinations (`columnShuffle` flag + `columnOrder`; `copyDrift` +
`uiCopy`; `classDrift` + `classDriftLevel`; `layoutVariant` +
`layoutCondition`; `pagination` + `pageSize`) are rejected with a config
error, not resolved silently. No new chaos flags are added; params are a
parallel mechanism and the Phase-1 flag set is untouched.

### Stratum F — ordered single-axis series (frontier-eligible)

Each F-axis is a monotone series; F1 and F2 are additionally **nested**
(each level's perturbation set contains the previous level's). Frontier =
first observed failure level, per policy, per axis.

| Axis | Param | Levels |
| --- | --- | --- |
| **F1 class drift** | `classDriftLevel` | 0 off · 1 = 25% of class tokens renamed (seeded per-token choice), ids kept · 2 = 50%, ids kept · 3 = 100%, ids kept · 4 = 100% + all ids removed (≡ Phase-1 `classDrift`) |
| **F2 decoy rebinding** *(new; trigger-blind)* | `decoyLevel` | Fixed control order **[next-page, reveal-tab, login-submit]**; level k rebinds the first k. Rebinding a control: the canonical id attaches to a same-tag, visually plausible, **inert** decoy element (no handler; clicking it is a no-op), while the functional control renders with seed-drifted class-only markup, no canonical id, and its canonical visible text. Selector-faithful policies (A, B, B2, C) act on the decoy and *observe success at the act layer*; whether and where each policy fails downstream is the measurement. Semantic addressing can still identify the functional control by its text/role. |
| **F3 pagination stress** | `pageSize` | 5 (≡ today) · 3 · 2 |

Design intent for F2, stated for the audit: C repairs only on act failure;
a decoy click does not fail, so C's repair should never trigger. That
mechanism claim is *verified, not assumed*: the keyless A/B/B2 grid run and
the smoke test must show decoy trials failing without repair activation
(B2: empty `deterministicRepairSteps` on the rebound step) before the keyed
grid runs — if the mechanism does not behave as designed, that is a stage-2
finding to disclose, not to patch.

### Stratum K — categorical named conditions (no frontier language)

Sol authors the values; each is a named condition reported as raw pass
counts per policy. No ordering, no "level", no frontier estimates.

| Surface | Param | Machinery |
| --- | --- | --- |
| Header vocabulary | `headerVocab` (map: column/label key → string) | Rendered as stats/odds table headers and card `dt` labels. Fairness constraint (audited, not code-enforced): every string must remain unambiguously human-decodable in page context. |
| UI copy | `uiCopy` (map: the 9 copy keys → string) | Rendered for headings/buttons/tabs. Stresses B2's frozen regexes and D's instruction-following; which policy it stresses more is an empirical question, not a design assumption. |
| Column order | `columnOrder` (explicit permutation of the 9 stat columns) | Rendered exactly. Adjacent swap vs full derangement is sol's choice per condition. |
| Layout | `layoutCondition` ∈ `wrapped` \| `cards` | `wrapped` = table nested in non-semantic divs (still a `<table>`); `cards` = card grid (≡ Phase-1 `layoutVariant`). Categorical: the two conditions are not a nested series. |

### Stratum X — predeclared interactions

Compositions of ≥2 axes (e.g., `cards` × `headerVocab`; `classDriftLevel`
× `decoyLevel`). Reported separately; never pooled with F or K; no
frontier language. Sol declares each interaction cell explicitly.

### Stratum S — secondary (non-frontier) strata

Poison/corrupt-data, partial-data, and session-failure scenarios are
labelled `stratum: "S"` and analyzed only as safety/robustness checks.
**Primary strata (F, K, X) cells are `expected: success`, fresh-session,
presentation/addressing perturbations only.**

### Timing (not an axis)

`delayRangeMs` / `networkDelayRangeMs` `[min,max]` override the Phase-1
seeded ranges. Available to sol for realism; timing results are reported
descriptively, not as a frontier.

## 4. Held-out scenario package contract

Sol's package is a machine-readable JSON plus its SHA-256, containing for
each scenario: id, name, description, `chaos` flags and/or `params`
(subject to §3 precedence), seed (reserved range **2201–2299**, disjoint
from Phase 1), session mode, `expected`, `stratum` (`F1|F2|F3|K|X|S` with
the condition/level identifier), and a predicted outcome per policy
(A, B, B2, C, D). The package must include **at least two distinct seed
instances per F-axis level** for any level a frontier claim will rest on
(single-instance levels are reported but marked non-generalizing). The
exact scenario count is frozen verbatim into the §10 appendix at reveal,
before implementation.

Sol may compose any axes, params within declared ranges, and existing
chaos flags. Sol may not request machinery changes — that is a stage-1
amendment requiring a new policy tag and re-audit.

## 5. Stage-1 deliverables (implemented before the policy tag)

1. `--repair-mode` flag + B2 ladder + `deterministicRepairSteps` schema
   field + config label, with tests (including: llm-mode dispatch
   unchanged; B2 never writes `healedSteps`; B2 `llmCalls: 0` enforced).
2. §2a guard correction in the stagehand engine.
3. Axis machinery per §3, each param covered by lab render tests at fixed
   seeds, plus the precedence/contradiction validation.
4. **Generic suite loader**: `--scenario-suite <path>` loads and validates
   a scenario-suite JSON (schema, seed range, uniqueness, stratum labels,
   precedence rules) and computes `suiteHash` = SHA-256 of the file bytes.
5. **Generic suite verifier** (replaces per-engine `verify.ts` editing —
   acceptance logic is frozen at stage 1): data-driven runner that, for
   each scenario × policy, compares the judged outcome to `expected` and
   to the prediction table. No per-scenario code, ever.
6. **Provenance**: `results.json` environment gains `protocolId`
   (`"phase2a-v1"`), `repairMode`, and `suiteHash`; the campaign
   aggregator refuses to aggregate runs with mixed `protocolId` or
   `suiteHash`.
7. Diff-gate script (§6).

## 6. Diff gate

`scripts/diff-gate-2a.sh` diffs `phase2a-policy-freeze-v1` against
`phase2a-suite-freeze-v1` and exits nonzero on any change outside this
allowlist:

- `data/phase2a/scenario-suite.json` — sol's exact bytes; the commit
  message records sol's published SHA-256 and the gate re-verifies it.
- `docs/PROTOCOL_2A.md` — §10 appendix only (scenario table, prediction
  table, revealed counts).
- `evidence/phase2a/diff-gate.txt` — the gate's own output.

Explicitly **not** changeable at stage 2: anything under `packages/`,
`apps/`, `scripts/`, tests, per-engine verify harnesses. The gate's output
lives at the allowlisted `evidence/phase2a/diff-gate.txt` and is committed
with the stage-2 evidence.

## 7. The grid — fixed in advance

- **Cells:** every revealed scenario × every policy (A, B, B2, C, D).
- **Sweeps: N=5** per policy (keyless policies included — they cost
  nothing but time). Phase 1's zero cross-sweep variance was observed at
  the suite's ceiling and does not transfer to near-boundary cases; N=5 is
  still small and all results report **raw counts (x/5)** per cell, never
  rates alone.
- **Cold only.** No seeded-cache configurations (persistence was Phase 1's
  question). Every C sweep starts from the bootstrap cache.
- **Counterbalanced keyed schedule** (fixed now): keyed sweeps alternate
  policy order ABBA-style — sweep 1: C then D; sweep 2: D then C; sweep 3:
  C then D; sweep 4: D then C; sweep 5: C then D. Within each policy-sweep,
  scenario order is suite order. Keyless policies run before any key
  exists (§8) and are unaffected by the schedule.
- **No adaptive stopping:** the grid runs to completion regardless of
  interim results; no cell is added, dropped, reordered, or re-run based
  on outcomes. A crashed sweep is preserved and rerun once, crash
  artifacts kept (Phase-1 operator rules apply unchanged). Keyless
  results, however surprising, cannot modify the keyed grid.
- **Budget:** hard cap **$40** of model-inference spend. Projection:
  ≤24 scenarios × 5 sweeps × 2 keyed policies at D ≈ $0.032 per trial
  (Phase-1 observed average $0.0312) and C projected at $0.004–0.012 per
  trial (above Phase-1's observed $0.0036 average, whose per-cell costs
  ranged up to ≈$0.029 on repair-heavy scenarios, because near-boundary
  trials fire more repairs) ≈ **$4.30–$5.30**. That is a projection, not
  a bound; D extraction under heavy perturbation may also use more
  tokens, so the actual number may exceed it. The **cap is the bound**: if
  hit, the campaign halts and is reported **incomplete**, and an
  incomplete grid supports no frontier claims. Declared now; not adaptive
  stopping.

## 8. Gates before any keyed trial

1. Full test suite green at the stage-2 tag; `gitDirty: false`.
2. Diff gate passes; sol's package hash matches.
3. **Keyless full grid** of A, B, B2 (N=5) on the held-out suite —
   complete before any key exists. Also validates every fixture renders
   and grades, and checks the F2 mechanism claim (§3). Keyless outcomes
   are recorded and cannot alter the keyed grid.
4. Fresh temporary key, scoped to the campaign, revoked after.
5. **Smoke (predeclared here):** Phase-1 scenarios `clean-extraction`
   (seed 1101) and `class-drift` (seed 1108) × C and D,
   `--purpose smoke`, on the *Phase-1* catalog — held-out cells are never
   touched before the campaign. Green criteria: both scenarios judged
   pass per policy; C heals `class-drift` (nonempty `healedSteps`,
   `llmCalls > 0`); D records `llmCalls > 0` with both token sides; all
   trials priced; stamps (`gitCommit`, `gitDirty: false`, `protocolId`,
   `promptsHash`, `repairMode`) correct. Smoke is never evidence. Any
   smoke-driven code change invalidates the suite tag: new tag, new
   audit, new smoke.
6. Campaign start. Model, pinned prices (2026-07-14), and
   model-inference-cost-only accounting identical to Phase 1
   (`anthropic/claude-haiku-4-5`).

## 9. Metrics and interpretation rules (fixed in advance)

- **Primary (stratum F):** per axis and policy, raw pass counts at each
  level and the **first observed failure level**. Reported per axis; never
  averaged across axes; no interpolation between levels; no extrapolation
  beyond level 4/3/2 (the tested maxima).
- **Stratum K:** named-condition raw pass counts per policy. No ordering
  claims.
- **Stratum X:** per-cell raw counts; interaction effects described, not
  modeled.
- **Stratum S:** safety outcomes only (the three silent-corruption
  denominators D1/D2/D3 exactly as Phase 1 §7; safe- vs hard-failure
  classes).
- **Cost:** model-inference cost per successful workflow per cell (C, D);
  repair activation counts (`healedSteps` for C, `deterministicRepairSteps`
  for B2); zero-model-inference-cost policies reported at $0.00 with the
  phrase "zero model-inference cost" (compute/wall-clock is not costed).
- **Predictions:** sol's frozen prediction table scored per cell — hits
  and misses both reported, per policy.
- **Language rules (binding):** "matched/separated on this held-out grid",
  never "equivalent/superior in general". B2's failures bound *this
  implementation* of deterministic repair, not the concept. If every
  policy again passes everything, the headline is "the held-out grid also
  failed to separate the policies" — a null result. Judged-correct
  framing, observed-not-inferred safety claims, and
  model-inference-cost-only accounting carry over from Phase 1 verbatim.

## 10. Amendments

None. (Stage 2 will add, as a dated appendix before any keyed trial: the
revealed scenario table, sol's prediction table and package SHA-256, and
the frozen scenario count. The diff-gate report is not part of the
appendix — its single home is `evidence/phase2a/diff-gate.txt`, §6.)
