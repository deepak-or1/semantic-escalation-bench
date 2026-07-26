# When Should Web Automation Pay for Semantics?

**A controlled study of selectors, selective LLM repair, and semantic extraction
under web drift — Phase 1 results.**

*Status: draft pending external audit review. Campaign numbers come from the
tracked, checksummed evidence bundle at
[`evidence/phase1/`](../evidence/phase1/README.md); keyless A/B figures come
from the committed keyless evidence in `runs/latest`. Both were generated
under the prospectively frozen protocol at annotated tag `protocol-freeze-v4`
(methodology committed before any keyed trial existed).*

---

## TL;DR

On a frozen suite of 24 robustness scenarios, selective LLM repair (policy C)
**matched full semantic execution (policy D) on observed judged correctness —
120/120 for both — at 8.61× lower model-inference cost** ($0.0036 vs $0.0312
per successful workflow). Repair inference activated only at the four scenarios
where the free structural tier verifiably breaks, and nowhere else. Replaying
cached repairs in fresh browsers cut inference calls by 60% but cost by only
19.7%: in this implementation, **interaction repairs persisted; extraction
repairs re-paid inference every run**. Zero silent corruptions were observed in
384 keyed trials — and the protection was the shared deterministic validator,
not model discretion: all 16 trials of the deliberately poisoned scenario
reached extraction and were rejected by the validator. In D, LLM-driven
extraction emitted the poisoned table in 5/5 trials; the eleven C-family
poison trials extracted deterministically with zero model calls.

This is a controlled case study with a deliberately narrow scope — one
synthetic domain, one model, one automation framework, N=5 — built for causal
attribution rather than generality. Every claim below is bounded to the frozen
suite.

## The question

When a website changes under your automation — renamed classes, shuffled
columns, redesigned layouts — you can address pages positionally, structurally,
with an LLM called only on breakage, or with an LLM addressing every step
(behind two disclosed deterministic UI guards). These
four **tested addressing policies** (not the only possible ones) form a ladder
of increasing semantic inference:

| Policy | Addressing | Inference | Notes |
|---|---|---|---|
| **A — positional** | hardcoded ids/indices | none | breaks on the tested selector/index changes |
| **B — structural** | header-name mapping, cached actions, repair disabled | none (machine-enforced) | survives reorder/reword |
| **C — selective repair** | B, plus one key-gated LLM repair per broken step; action repairs cached, extraction repairs re-inferred | only on breakage | the "pay only when broken" policy |
| **D — full semantic** | instruction-driven LLM addressing and extraction every trial | every trial | includes two disclosed deterministic UI guards (consent, modal-dismiss) |

All four share the same 24 scenarios and the same downstream normalization,
domain validation, and ground-truth grading. Engine behavior, inference
exposure, retries, and guards necessarily differ — that is the treatment. The
question the ladder measures: **what does each additional use of semantic
inference achieve, and what does it cost?**

## Method in brief

- **Lab:** a deterministic synthetic sports-stats site (login → consent →
  reveal → paginated stats and odds tables) with seeded chaos modes. Every
  artificial failure mode is anchored to a documented real-world incident in
  [EVIDENCE.md](EVIDENCE.md) — 28 claim–quote–source citations, re-verified
  live on 2026-07-20 (all URLs live, all claims supported, all quotes
  verbatim). Flagship: baseballr PR #412, a real mid-table column insertion
  that silently mislabeled 26 downstream columns of sports data.
- **Scenarios:** 24 frozen robustness scenarios — structural drift, layout
  redesigns, session expiry, timing, overlays, pagination, and one
  deliberately poisoned dataset (`schema-violation`) whose correct handling is
  refusal. Seeds and scenario definitions were committed before any keyed
  trial existed.
- **Protocol:** methodology frozen prospectively at annotated tag
  `protocol-freeze-v4` after four external audit rounds (lineage v1→v4
  documented with dated amendments in [PROTOCOL.md](PROTOCOL.md) §8). Every
  results file self-attests its git commit, clean-tree flag, prompt-registry
  hash, and lockfile hash. Smoke runs are machine-excluded from evidence.
- **Model:** `anthropic/claude-haiku-4-5` at pinned prices ($1 input / $5
  output per MTok, pinned 2026-07-14). Costs below are **model-inference cost
  only** — not engineering, browser infrastructure, or maintenance.
- **Repetition:** the keyed campaign ran 5 sweeps per cold configuration
  (N=5); the keyless tier's committed evidence is single-sweep. A/B and C/D
  comparisons below are at scenario-coverage level across these different
  repetition regimes, disclosed here.

## Results

### The free tier (keyless, committed evidence)

- **A — positional: 18/24 scenarios.** Fails on class drift, layout redesigns,
  and the survival scenarios reprising them. Its shuffled-column misreads were
  caught by domain validation — recorded failures, not silent corruption.
- **B — structural: 20/24 scenarios at $0.00 and provably zero LLM calls.**
  Header-name mapping survives column shuffles and label rewording; it cannot
  survive the four scenarios that invalidate its cached selectors or change
  the page's representation: `class-drift`, `layout-variant`, `site-v3`,
  `compound-redesign-storm`.

### The keyed campaign (16 runs, 384 trials, all admissibility-checked)

| Configuration | Judged correct | LLM calls | Inference cost | Cost / successful workflow |
|---|---:|---:|---:|---:|
| D full semantic (5 sweeps) | 120/120 | 690 | $3.7457 | $0.0312 |
| C selective repair, cold (5 sweeps) | 120/120 | 75 | $0.4349 | $0.0036 |
| C persistence (5 paired runs) | 120/120 | 30 | $0.3491 | $0.0029 |
| C warm (1 run) | 24/24 | 6 | $0.0694 | $0.0029 |

"Judged correct" counts 23 correct extractions plus one correct
validator-enforced refusal of the poisoned scenario per sweep. Judged
outcomes, repair locations, and inference-call counts were exactly
reproducible across sweeps under the frozen environment; token counts and
latency varied run to run (per-cell medians and min–max ranges are in the
[campaign report](../evidence/phase1/report/campaign-report.md)).

### Where C actually paid

C's repair inference fired on exactly the four scenarios B cannot survive, in
every sweep, and nowhere else:

| Scenario | Steps healed | Calls | What broke |
|---|---|---:|---|
| `class-drift` | `login` | 3 | build-tooling renamed every class, stripped ids |
| `layout-variant` | both extractors | 2 | table replaced by card grid |
| `site-v3` | `login` + both extractors | 5 | full redesign |
| `compound-redesign-storm` | `login` + both extractors | 5 | redesign + compounding chaos |

The other 20 scenarios ran on the deterministic tier at zero calls and $0. On
this frozen suite, full-time semantic execution bought no additional observed
judged correctness or safety over selective repair — there was **no observed
scenario where C failed and D succeeded**. (Equally: this suite contains no C-resistant case, so it cannot
say where D *is* worth paying for. See limitations.)

### The persistence boundary

Each cold C sweep's repairs were harvested into a content-hash-verified
manifest and replayed in fresh browsers (paired per sweep; the warm run used
sweep 1's manifest, fixed in advance):

- **Calls fell 60% (15 → 6 per sweep); cost fell only 19.7%** (configuration
  totals $0.4349 → $0.3491) — the surviving extraction calls carry most of
  the tokens.
- Of the 20 healed scenario-trials across the five persistence runs, only the
  five `class-drift` trials became fully zero-call — the frozen definition of
  *persistently repaired*. Its healed `login` action replayed from cache.
- `site-v3` and `compound-redesign-storm` replayed their action repairs free
  but re-paid extraction inference (2 calls each). `layout-variant`'s heal was
  extraction-only, produced no cacheable action artifact, and re-paid in full.

**In this implementation, action repair persisted while extraction repair was
ephemeral.** This is a property of the controlled C implementation built for
this study (cached Stagehand Actions with repair-on-breakage); it does not
test Stagehand's native caching product, which has its own keying and
invalidation behavior. As a general architectural observation: *cacheability
depended sharply on the kind of knowledge being repaired* — "where to click"
persisted as replayable structure; "how to read this table" did not.

### Silent corruption and where safety actually lives

**Zero silent corruptions were observed** across all 384 keyed trials and all
three frozen denominators (per configuration: 0/120 trials; the
judged-failure denominator is undefined because no judged failures occurred;
0/115 accepted outputs for D and for C-cold). As supplementary
statistics (not a frozen metric): under a simple binomial reading, 0/120
leaves a rule-of-three 95% upper bound of ≈2.5% per configuration — reported
per configuration because the five sweeps are correlated repetitions of the
same frozen scenarios, not independent samples.

The poisoned scenario decomposes the safety mechanism: every keyed trial of
`schema-violation` records `extractionSuccess: true` and
`validationSuccess: false` — all 16 poison trials reached extraction and were
rejected by the shared validator. In D, LLM-driven extraction emitted the
poisoned table in 5/5 trials; the eleven C-family trials used deterministic
extraction with zero model calls, so only D's five trials exercise model
behavior on poison at all. **The observed safety property resides in the
deterministic validator, not in model discretion.** A different model, or corrupt data engineered to sit inside the
validator's acceptance region, could behave differently — mapping that
acceptance region is the subject of a planned separate safety study.

D's two disclosed deterministic UI guards fired zero times in the campaign.
(Guard-firing recording is exercised by unit tests; C's heal records come
from a separate recording mechanism, exercised throughout the campaign.)

### The decision metric

The protocol's headline metric is the probability of undetected wrong data
per dollar. On this suite: **0 observed silent corruptions in 115 accepted
outputs per configuration, at $0.0036 (C-cold) vs $0.0312 (D) per successful
workflow.** For this workload, paying for full-time semantics bought no
additional observed judged correctness or safety over selective repair, at
8.61× the model-inference cost.

## What this supports — and what it does not

Supported by the frozen evidence:

- C **matched** D's observed judged correctness on this suite at 8.61× lower
  model-inference cost. (*Matched, not "equivalent"* — a suite with no
  C-resistant case cannot establish equivalence.)
- Structural addressing alone (B) covered 20/24 scenarios at $0.
- Repair inference activated precisely at the measured failure boundary of
  the free tier — no spurious healing.
- Persistence was **partially durable and implementation-specific**: action
  repairs replayed free; extraction repairs re-paid inference.
- Safety was **validator-enforced**: all 16 poison trials were rejected by
  the shared validator; the LLM emitted the poisoned table in D's five
  trials, and the eleven C-family poison trials never invoked the model.

Not supported (and not claimed):

- Any statement about where D *is* worth paying for — this suite contains no
  observed C-resistant case.
- Equivalence of C and D, generality beyond this domain/model/framework, or
  any claim about Stagehand's native caching product.
- "The model refuses corrupt data" — in the five D trials where the model
  performed extraction, it demonstrably did not; the C-family poison trials
  never asked it to.
- Any "first"/priority claim. Differentiation from specific verified neighbor
  work is documented in Related work; a systematic literature review was not
  performed.

## Threats to validity

1. **Ceiling effect.** Every keyed policy passed every scenario. The suite's
   difficulty range sits below C's and D's capability, so the reliability
   axis does not discriminate between them here; only cost does. The planned
   follow-up (a predefined perturbation-intensity ladder with held-out seeds)
   exists to locate each policy's breaking frontier.
2. **Same-author suite.** Scenarios, lab, and engines were built together.
   Mitigations: the three drift failure modes are anchored to documented
   external evidence ([EVIDENCE.md](EVIDENCE.md)), while the mechanical
   obstacle modes are uncited by design; seeds and scenarios were frozen
   before keyed results existed; a pre-implementation prediction table for
   the keyless tier matched 24/24. Residual risk is real: scenario *selection*
   could still favor the implemented policies. Known omission: split/merged
   columns — a documented real-world failure class requiring schema
   transformation rather than re-addressing — is absent, and its absence
   plausibly favors C.
3. **B is not the strongest free baseline.** Published zero-cost deterministic
   self-healing exists (accessibility-tree locator hierarchies); a stronger
   study would include one between B and C. Planned for the follow-up.
4. **One domain, one model, one framework, N=5.** Correlated repetitions of
   frozen scenarios demonstrate repeatability, not distributional coverage.
   A null result at this scope would have been inconclusive; the observed
   result is a matched-coverage-at-lower-cost finding on this suite only.
5. **Synthetic ground truth is circular by construction** — the generator
   knows the right answer because it generated the page. That buys exact
   grading and causal attribution at the price of external validity.
6. **Simulated vs. not simulated.** The lab simulates: structural drift,
   layout redesigns, session expiry, overlays/consent walls, delayed
   rendering, network slowdown, pagination, hidden tabs, poisoned data. It
   does not simulate: anti-bot systems, CAPTCHAs, SPA framework hydration,
   authentication beyond a simple form, IP blocking, or adversarial
   anti-scraping. Results say nothing about those pressures.
7. **Model-inference cost only.** Engineering time, browser infrastructure,
   and maintenance are excluded; the cached-action tier's engineering cost is
   real and unpriced here.

## Related work

Differentiation below is relative to these specific, verified works — not a
priority claim over the literature.

- **StressWeb** (arXiv:2604.16385) stress-tests web *agents* under controlled
  DOM/layout/semantic/execution perturbations across 10 sites and 8 models,
  with checkpoint grading and step-count cost; its "silent failures" are
  agents misreporting their own success. This study varies the *addressing
  policy* with the model fixed, measures corruption among *accepted outputs*,
  and prices persistence in dollars.
- **NEXT-EVAL** (arXiv:2505.17125) compares heuristic vs LLM web data
  extraction on snapshot datasets with token accounting and hallucination
  metrics; no live browser workflows or repair.
- **Beyond BeautifulSoup** (arXiv:2601.06301) benchmarks LLM-assisted
  scripting vs autonomous agents across 35 real sites and security tiers —
  breadth and usability rather than controlled drift.
- **Budget-constrained web agents** (arXiv:2606.15017) finds skill/memory
  modules' "apparent gains often vanish against a budget-matched actor" —
  the same pay-for-itself question, asked of agent memory; here it is asked
  of addressing policies and answered with priced outcomes.
- **Zero-cost self-healing** (arXiv:2603.20358) heals broken selectors
  deterministically via accessibility-tree extraction — evidence that part of
  C's niche may be capturable for free, and the reason the follow-up adds
  such a baseline.
- **Stagehand** (browserbase/stagehand) supplies the primitives C and D are
  built from and markets caching + self-healing; this study is an independent
  controlled evaluation of a specific implementation of those architectural
  ideas, not of the product's native cache.

## Reproducibility

Annotated tags `protocol-freeze-v1` … `-v4` freeze the methodology pre-key;
every results file records `gitCommit`, `gitDirty`, `promptsHash`
(`5c07ce1f…`), and `lockfileHash` (`b6f0dd3a…`). The keyless benchmark is
deterministic (two consecutive runs produce identical outcome vectors — the
frozen determinism gate) and requires no API key to re-run. The campaign's
16 result files, the five byte-preserved manifests with a content-addressed
cache-payload map, the aggregate reports, the campaign driver, the
admissibility verifier, the citation re-verification ledger, and per-file
checksums are tracked in [`evidence/phase1/`](../evidence/phase1/README.md),
whose README shows how to re-run the aggregation from the bundle alone. The
aggregate's one warning — multiple `seedCacheHash` values — is required
behavior: five paired persistence manifests plus unseeded cold runs are
mandated by the protocol, and the aggregator discloses rather than suppresses
the spread.

## What's next (separate from this campaign)

Two prospectively frozen follow-ups, each under its own protocol tag, neither
altering anything reported above:

- **Phase 2A — policy frontier:** a fully predeclared perturbation-intensity
  grid on held-out seeds, adding a deterministic self-healing baseline. The
  complete grid is executed as frozen — no adaptive stopping — and reported
  as survival curves with any frontier thresholds. Answers the question this
  suite's ceiling cannot: where full semantics is actually worth its price.
- **Phase 2B — validator red-team:** a separate safety study that first maps
  the frozen validator's acceptance region with directly-fired poison
  payloads (including independently authored held-out cases), then embeds
  surviving payloads end-to-end to test for true silent corruption.
