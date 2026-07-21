# Phase 2A protocol — the policy frontier

**Status: DRAFT (revision 6, after the external executable audit of
`phase2a-policy-freeze-v1`) — not yet frozen.** Revision 6 repairs the
three blockers that audit found in the freeze-v1 tag: (1) the generic
verifier now enforces a caller-declared expect-grid — all required
policies present, exact per-cell trial counts drawn from distinct sweeps,
duplicate-run rejection — and grades against the supplied suite's oracle,
never the run's own recorded copy (§5 item 5, §8); (2) the §7 budget rule
is implemented, not merely promised — a pre-trial hook in the runner plus
a resumable campaign driver with persisted spend state and the
machine-enforced ABBA schedule (§5 item 9, §7); (3) F1 levels 1–3 now
drift a nested seeded fraction of id tokens as well as class tokens — the
earlier definition renamed only class tokens, which no frozen policy
reads, leaving the id-addressed policies unperturbed until level 4 (§3).
(Revision 5 had refined §2/§3 from stage-1 implementation feedback:
nav-anchor exclusion, card identity-from-heading, capped reveal poll,
layout-suppresses-pagination, canary judged-failure wording.)
`phase2a-policy-freeze-v1` is preserved as history and superseded. This
document becomes binding at the stage-1 tag (`phase2a-policy-freeze-v2`)
and is completed by the stage-2 tag (`phase2a-suite-freeze-v1`); no keyed
trial may run before the stage-2 tag exists. Phase 1 ([PHASE1_RESULTS.md](PHASE1_RESULTS.md),
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
   Tag: `phase2a-policy-freeze-v2` (`…-v1` is preserved history: audited,
   found blocking, superseded).
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

- **A:** unchanged from Phase 1.
- **B:** behaviorally carried forward through the new `--repair-mode`
  dispatch (`off` must reproduce Phase-1 `--no-repair` behavior exactly;
  asserted by stage-1 tests).
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
  with `role=tab`; then, inside a `nav`, `[role=tablist]`, or an ancestor
  whose children are ≥2 sibling `button`/`a` elements (a tab-strip
  signature): visible enabled `button` elements, and `a` elements only
  when their `href` is absent or fragment-only — a full-href anchor is
  site navigation, not a tab, and clicking one abandons the page. Click
  candidates in order (≤5), running the existing content-ready poll
  (capped at 3000 ms per candidate) after each; stop at first success.
- `next-page`: within the smallest ancestor containing the current-page
  indicator and ≥2 `button`/`a` controls (the pager signature), the first
  visible enabled control with `rel="next"` or trimmed text matching
  `/^\s*(next|more|»|→|older)\s*$/i`; else the last visible enabled control
  in that container. Page-merge budget identical to B/C.

**Deterministic extraction repair** (same trigger as C's extract repair —
no header-mappable `<table>` found): find the largest set of ≥4 sibling
blocks each containing ≥3 label–value pairs; map labels through the **same
frozen synonym dictionaries B and C use** (`STAT_SYNONYMS`/`ODDS_SYNONYMS`,
unchanged from Phase 1). A block's **identity field** (team/match name) may
come from the block's heading element (`h1`–`h6`) or, absent one, its
first text outside any label–value pair — identity in card anatomy is
structural, not vocabulary. All other fields map through the dictionary
only; apply the same field thresholds as the table path (≥4 stat fields;
match + ≥3 odds value fields). No new vocabulary: B2's dictionary *is*
B's dictionary — that boundary is the measurement.

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
`[role=button]`, `a` — filtered to visible and enabled candidates per §2's
operational definitions (the guard and B2's rung share one semantics), and
considering only the **first** >50%-viewport fixed overlay (the Phase-1
guard fell through to later overlays; none of the frozen scenarios renders
more than one). Recorded here as the single disclosed change-set to a
Phase-1 policy; it alters no Phase-1 result against the frozen lab and is
applied before the stage-1 tag.

## 3. Perturbation machinery — the frozen axes

Machinery (renderers, config plumbing, schema) is frozen at stage 1; the
*values* are held-out scenario data. Ground truth is never affected:
headers, labels, class names, decoys, and layout are presentation; truth
always comes from `/__lab/ground-truth`.

**Layout suppresses pagination (Phase-1 lab semantics, carried forward):**
when a layout condition is active (`layoutVariant` flag or
`layoutCondition` param), the pagination render path — and with it the
`next-page` control — does not render. A scenario with `decoyLevel ≥ 1`
(which always rebinds `next-page`) therefore cannot compose with a layout
condition; the config API rejects that combination rather than rebinding a
control that does not exist.

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
| **F1 class drift** | `classDriftLevel` | 0 off · 1 = 25% of class tokens AND an independently seeded 25% of id tokens renamed · 2 = 50%/50% · 3 = 100%/100% (every id present but renamed) · 4 = 100% of classes renamed + ALL ids removed (≡ Phase-1 `classDrift`, byte-identical). Both renamed sets are nested across levels 1–3 (per-token monotone thresholds, distinct salts for pick and rename); level 4's removal of every id is the deliberate superset break, not a rename. Renamed tokens keep the base as a prefix (`standings-x3f2a…`) — disclosed because a prefix-matching selector heuristic could exploit it; none of the five frozen policies uses one. Decoy ids (F2) are emitted as literals and never drift, at every level. *Revision-6 correction (external audit of freeze-v1): the earlier definition renamed only class tokens at levels 1–3, which no frozen policy reads — the axis was inert below level 4 for the id-addressed policies (A's selectors, B/B2/C's cached actions).* |
| **F2 decoy rebinding** *(new; trigger-blind)* | `decoyLevel` | **Fixed scaffold at every level (including 0):** every F2 scenario carries chaos `[pagination, hiddenTab]`, so `next-page` and `reveal-table` exist at all levels — the lab renders those controls only under their flags, so without the scaffold, levels 1–2 would rebind controls that do not exist. Fixed control order **[next-page, reveal-table, login-submit]** (names = the engine step names B2's §2 rungs repair); level k rebinds the first k. Rebinding a control: the canonical id attaches to a same-tag, **inert** decoy element (no handler; clicking it is a no-op), while the functional control renders with seed-drifted class-only markup, no canonical id. The decoy's visible text and its placement relative to the functional control are **held-out parameters** (`decoyCopy`: map control → decoy text; `decoyPlacement`: `before` \| `after` the functional control in document order) — sol, not the policy author, chooses the cues semantic addressing sees, and holds them constant across the nested levels of the series. Selector-faithful policies (A, B, B2, C) act on the decoy and *observe success at the act layer*; whether and where each policy fails downstream is the measurement. |
| **F3 pagination stress** | `pageSize` | 5 · 3 · 2. **`pageSize` activates pagination** (it is the parameterized form of the `pagination` flag, subject to the flag-XOR-param rule): `pageSize: 5` ≡ the Phase-1 `pagination` flag; lower values raise the click-and-merge demand. |

Design intent for F2, stated for the audit: C repairs only on act failure;
a decoy click does not fail, so C's repair should never trigger. That
mechanism claim is *verified, not assumed*, by two checks that precede any
keyed trial — neither uses smoke (the frozen smoke scenarios contain no
decoys) or held-out cells:

- **Stage-1 fake-key canary** (part of the frozen test suite, never
  evidence): a built-in decoy fixture — not a held-out scenario — run with
  `--repair-mode llm` and a syntactically valid **fake key**. Required
  observations: the cached click reports success at the act layer;
  downstream behavior fails — as a pipeline failure **or a judged
  failure**: implementing the canary showed the level-1 decoy's actual
  mechanism is that the pipeline *accepts* incomplete standings (5 of 12
  rows) and the judge fails the trial, i.e. the trigger-blind failure
  mode is accepted-wrong-output, the silent-corruption class; `llmCalls
  === 0`; `healedSteps` empty; and no provider/auth error occurs — the
  fake key proves no model call was even *attempted*, which is exactly
  trigger-blindness.
- **Keyless A/B/B2 grid** (§8 gate 3) checks mechanism instrumentation,
  never outcomes: (a) the fixture and decoy behavior are mechanically
  valid — decoy present, inert, carrying the canonical id; functional
  control present and operable; (b) B2 records no deterministic repair
  for a rebound action whose cached click reported success. **Final
  pass/fail outcomes are evidence, never gate conditions.** A policy may
  legitimately survive a decoy: A's JSON-island pagination fallback can
  recover the complete dataset after clicking an inert `next-page` decoy,
  so A can pass F2 level 1 — if observed, that is an admissible and
  interesting result, not a gate failure.

The two check stages carry different failure policies: a **stage-1 canary
failure is a defect, fixed before the policy tag**; **unexpected held-out
behavior after stage 2 is disclosed and never patched**.

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

### Stratum S — reserved, unused in Phase 2A

The `S` label (poison/corrupt-data, partial-data, session-failure) exists
in the schema but the Phase-2A package contains **no S scenarios**:
validator safety belongs to Phase 2B, under its own protocol and tag.
**All Phase-2A cells (F, K, X) are `expected: success`, fresh-session,
presentation/addressing perturbations only.**

### Timing (not an axis)

`delayRangeMs` / `networkDelayRangeMs` `[min,max]` override the Phase-1
seeded ranges. Available to sol for realism; timing results are reported
descriptively, not as a frontier.

## 4. Held-out scenario package contract

Sol's package is a machine-readable JSON plus its SHA-256, containing for
each scenario: id, name, description, `chaos` flags and/or `params`
(subject to §3 precedence), seed (reserved range **2201–2299**, disjoint
from Phase 1), session mode, `expected`, `stratum` (`F1|F2|F3|K|X` with
the condition/level identifier), and a per-policy prediction (§4a).

**Binding size and allocation: exactly 32 scenarios — 24 F + 4 K + 4 X.**
The F allocation is two instances at every level of every series:
F1 5 levels × 2 = 10, F2 4 levels × 2 = 8, F3 3 levels × 2 = 6.
(S is omitted; §3.)

**Paired seeds across levels.** The two instances of an F series use the
**same two underlying seeds at every level** of that series, so that
raising the level changes only the perturbation, never the generated page
content. Seed reuse across scenarios is therefore intentional and the
suite loader must permit it: **uniqueness is enforced on scenario ids,
not on seeds.** Decoy copy/placement (F2) are likewise held constant
across the levels of the series.

Sol may compose any axes, params within declared ranges, and existing
chaos flags. Sol may not request machinery changes — that is a stage-1
amendment requiring a new policy tag and re-audit.

### 4a. Prediction semantics (frozen)

With N=5, "pass/fail" is ambiguous for a 4/5 cell. The prediction enum is:

- `all-pass` — observed 5/5 judged-correct.
- `observed-failure` — observed 0–4/5 (at least one judged failure).

An optional free-text predicted mechanism/failure category may accompany
either value and is scored descriptively. **Prediction misses are analysis
results**: they are reported in full and can never fail the generic
verifier, any gate, or the campaign — the verifier gates only
completeness, provenance, schema validity, and grading consistency (§5),
never predictions or judged outcomes.

## 5. Stage-1 deliverables (implemented before the policy tag)

1. `--repair-mode` flag + B2 ladder + `deterministicRepairSteps` schema
   field + config label, with tests (including: llm-mode dispatch
   unchanged; B2 never writes `healedSteps`; B2 `llmCalls: 0` enforced).
2. §2a guard correction in the stagehand engine.
3. Axis machinery per §3, each param covered by lab render tests at fixed
   seeds, plus the precedence/contradiction validation.
4. **Generic suite loader**: `--scenario-suite <path>` loads and validates
   a scenario-suite JSON (schema, seed range, **scenario-id uniqueness —
   seeds may intentionally repeat across levels, §4**, stratum labels,
   precedence rules) and computes `suiteHash` = SHA-256 of the file bytes.
   Runs on the built-in Phase-1 catalog record `suiteHash` as the SHA-256
   of the catalog's canonical JSON serialization, computed by the same
   code path.
5. **Generic suite verifier** (replaces per-engine `verify.ts` editing —
   acceptance logic is frozen at stage 1): the caller DECLARES the
   expected grid (`--expect-policies`, a subset of A,B,B2,C,D, and
   `--expect-trials`; both required — §8 pins the exact invocation per
   checkpoint) and the verifier refuses to certify anything that does
   not realise it exactly: each expected policy maps by string equality
   to its single admissible configuration label (cold-only, so C admits
   only `C-hybrid-repair-cold`; `hybrid-keyless` is the image of no
   policy); every suite scenario × policy cell must hold exactly the
   expected trial count, drawn from that many DISTINCT runs (one sweep
   each — N trials inside one run are not N sweeps); no configuration
   outside the expected set may appear; duplicate run inputs (shared
   benchId, or identical trial content — a relabeled copy of one run is
   not a distinct sweep) are rejected. Scope, stated honestly: the
   verifier checks structure and internal consistency of self-reported
   evidence files; it detects copy-based forgery but cannot
   cryptographically prove two files came from separate executions —
   fabricated fresh content is countered by publishing the raw run
   artifacts, not by this tool. Grading recomputes
   the judge from raw trial data against the SUPPLIED SUITE's oracle —
   never the run's own recorded scenarios, which are cross-checked
   against the suite; any divergence is a violation. **A judged policy
   failure is admissible evidence and never fails the verifier.** The
   verifier gates only completeness, provenance, schema validity, and
   grading consistency. (All 2A scenarios are `expected: success`;
   policy failures against them are the result being measured.) The
   prediction table is scored report-only (§4a). No per-scenario code,
   ever. *Revision-6 hardening (external audit of freeze-v1): the
   earlier verifier gated only observed configurations at any uniform N
   and graded against the run's own recorded oracle; the audit
   demonstrated it certifying a one-run, one-policy, N=1 synthetic
   campaign with a contradicting run-local oracle. That exploit is now
   an adversarial regression test.*
6. **Provenance**: `results.json` environment gains `protocolId`
   (`"phase2a-v1"`), `repairMode`, and `suiteHash`; the campaign
   aggregator refuses to aggregate runs with mixed `protocolId` or
   `suiteHash`.
7. Diff-gate script (§6).
8. **Fake-key decoy canary** (§3 F2): a built-in decoy fixture and a test
   that runs it under `--repair-mode llm` with a fake key and asserts
   act-layer success, downstream failure, `llmCalls === 0`, empty
   `healedSteps`, and no provider/auth error. Never evidence; part of the
   frozen suite.
9. **Budget rule + campaign driver** (§7; added in revision 6 after the
   freeze-v1 audit found the budget promised but unimplemented):
   `runBenchmark` gains pre/post-trial hooks; a stopped run stamps
   `results.stopped { reason, completedTrials, plannedTrials }` and
   still writes every artifact — an incomplete campaign is preserved
   evidence. `pnpm campaign:2a` executes the frozen §7 schedule from a
   persisted, resumable state file (atomic writes, spend updated after
   every trial), prices every trial with the pinned price table,
   enforces the $39.90 pre-trial threshold as a frozen in-code constant
   (deliberately not a flag), machine-enforces §8 key discipline (the
   keyless phase refuses to run while any key is present; the keyed
   phase refuses without one) and the §7 crash-rerun-once rule, and
   exits with a distinct code on a budget stop. Campaign state is
   per-phase (`runs/phase2a/campaign-state.<phase>.json` by default;
   the keyless and keyed phases never share a state file). Before any
   keyed run, the driver additionally asserts the configured model is
   in the pinned price table — no keyed trial may execute on an
   unpriceable model; the per-trial unpriceable check remains as
   defense-in-depth (a budget cannot be enforced over spend that cannot
   be priced). For operator
   reproduction, `pnpm bench --scenario-suite <file> --only <ids>` runs
   a subset of a held-out suite with provenance stamps unchanged — a
   filtered run can never satisfy campaign completeness.

## 6. Diff gate

`scripts/diff-gate-2a.sh` diffs `phase2a-policy-freeze-v2` against a
given ref and exits nonzero on any change outside this allowlist:

- `data/phase2a/scenario-suite.json` — sol's exact bytes; the commit
  message records sol's published SHA-256 and the gate re-verifies it.
- `docs/PROTOCOL_2A.md` — §10 appendix only (scenario table, prediction
  table, revealed counts).
- `evidence/phase2a/diff-gate.txt` — the gate's own output.

Explicitly **not** changeable at stage 2: anything under `packages/`,
`apps/`, `scripts/`, tests, per-engine verify harnesses.

The §10 appendix is delimited by frozen literal markers
(`<!-- PHASE2A-APPENDIX-START -->` / `<!-- PHASE2A-APPENDIX-END -->`,
present and empty from stage 1), and the gate verifies that every byte of
`docs/PROTOCOL_2A.md` outside that region is unchanged.

**Executable stage-2 sequence (fixed; prevents gate/report circularity):**

1. Commit sol's JSON and the §10 appendix — the *suite-candidate* commit.
2. Run the gate against `phase2a-policy-freeze-v2..HEAD`; write
   `evidence/phase2a/diff-gate.txt`.
3. Commit the report.
4. Rerun the gate. Because the gate **excludes its own allowlisted report
   path from its calculation**, the rerun must produce byte-identical
   output; any difference stops the process.
5. Only then create `phase2a-suite-freeze-v1`.

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
- **Budget:** operational stop threshold **$39.90** of model-inference
  spend, checked **pre-trial**: before each keyed trial the runner prices
  all recorded tokens so far and starts the trial only if cumulative
  spend is strictly below $39.90.
  The engine has no enforced per-trial token ceiling, so the final
  completed trial may overshoot $40 by its own cost — disclosed here
  rather than claimed away. Projection: 32 scenarios × 5 sweeps × 2
  keyed policies at D ≈ $0.032 per trial (Phase-1 observed average
  $0.0312) and C projected at $0.004–0.012 per trial (above Phase-1's
  observed $0.0036 average, whose per-cell costs ranged up to ≈$0.029 on
  repair-heavy scenarios, because near-boundary trials fire more repairs)
  ≈ **$5.76–$7.04**. That is a projection, not a bound; D extraction
  under heavy perturbation may also use more tokens, so the actual number
  may exceed it. **The threshold is the stop rule**: if it halts the
  campaign, the campaign is reported **incomplete**, and an incomplete
  grid supports no frontier claims. Declared now; not adaptive stopping.
  *Implemented in revision 6 (§5 item 9): the runner's pre-trial hook
  halts the run, stamps `results.stopped`, and still writes every
  artifact; the campaign driver persists cumulative priced spend across
  runs (state file, atomic writes, updated after every trial) and
  re-checks the frozen threshold before every trial; the ABBA schedule
  and the crash-rerun-once rule are machine-enforced by the same driver.
  One disclosed accounting boundary: a trial whose engine throws records
  no token usage and prices at $0, so provider spend inside a crashed
  call is not counted by the operational threshold — this is a stop rule
  over recorded tokens, not a billing reconciliation.*

## 8. Gates before any keyed trial

1. Full test suite green at the stage-2 tag; `gitDirty: false`.
2. Diff gate passes; sol's package hash matches.
3. **Keyless full grid** of A, B, B2 (N=5) on the held-out suite —
   complete before any key exists (machine-enforced: the driver's
   keyless phase refuses to run while any key is present). Run via
   `pnpm campaign:2a --suite data/phase2a/scenario-suite.json --phase
   keyless --state runs/phase2a/campaign-state.keyless.json` (the
   per-phase default; keyless and keyed never share a state file);
   verified with `pnpm verify:suite <sweep dirs> --suite
   data/phase2a/scenario-suite.json --expect-policies A,B,B2
   --expect-trials 5`. Also validates every fixture renders
   and grades, and checks the F2 mechanism instrumentation (§3 — never
   outcomes). Keyless outcomes
   are recorded and cannot alter the keyed grid.
4. Fresh temporary key, scoped to the campaign, revoked after.
5. **Smoke (predeclared here):** Phase-1 scenarios `clean-extraction`
   (seed 1101) and `class-drift` (seed 1108) × C and D,
   `--purpose smoke`, on the *Phase-1* catalog — held-out cells are never
   touched before the campaign. Green criteria: both scenarios judged
   pass per policy; C heals `class-drift` (nonempty `healedSteps`,
   `llmCalls > 0`); D records `llmCalls > 0` with both token sides; all
   trials priced; stamps (`gitCommit`, `gitDirty: false`, `protocolId`,
   `promptsHash`, `repairMode`, and `suiteHash` — the built-in Phase-1
   catalog hash, since smoke runs on that catalog; §5 item 4) correct.
   Smoke is never evidence. Any
   smoke-driven code change invalidates the suite tag: new tag, new
   audit, new smoke.
6. Campaign start. Model, pinned prices (2026-07-14), and
   model-inference-cost-only accounting identical to Phase 1
   (`anthropic/claude-haiku-4-5`). The keyed grid runs via
   `pnpm campaign:2a --suite data/phase2a/scenario-suite.json --phase
   keyed --state runs/phase2a/campaign-state.keyed.json` (per-phase
   default; the driver refuses a state file from another phase and
   refuses any keyed run whose model is not in the pinned price
   table); final campaign acceptance is verified with
   `pnpm verify:suite <all sweep dirs> --suite
   data/phase2a/scenario-suite.json --expect-policies A,B,B2,C,D
   --expect-trials 5` (the §5 item-5 grid contract).

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
  classes). No S scenarios exist in 2A (§3); the rule is stated for
  completeness.
- **Cost:** model-inference cost per successful workflow per cell (C, D);
  repair activation counts (`healedSteps` for C, `deterministicRepairSteps`
  for B2); zero-model-inference-cost policies reported at $0.00 with the
  phrase "zero model-inference cost" (compute/wall-clock is not costed).
- **Predictions:** sol's frozen prediction table scored per cell under
  the §4a semantics (`all-pass` ⇔ 5/5; `observed-failure` ⇔ 0–4/5) —
  hits and misses both reported, per policy. Misses are analysis
  results, never gate or verifier failures.
- **Language rules (binding):** "matched/separated on this held-out grid",
  never "equivalent/superior in general". B2's failures bound *this
  implementation* of deterministic repair, not the concept. If every
  policy again passes everything, the headline is "the held-out grid also
  failed to separate the policies" — a null result. Judged-correct
  framing, observed-not-inferred safety claims, and
  model-inference-cost-only accounting carry over from Phase 1 verbatim.

## 10. Amendments

None. (Stage 2 will add, inside the markers below and before any keyed
trial: the revealed scenario table, sol's prediction table and package
SHA-256, and the frozen scenario count. The diff-gate report is not part
of the appendix — its single home is `evidence/phase2a/diff-gate.txt`,
§6. The gate verifies every byte of this file outside the marked region
is unchanged from `phase2a-policy-freeze-v2`.)

<!-- PHASE2A-APPENDIX-START -->
<!-- PHASE2A-APPENDIX-END -->
