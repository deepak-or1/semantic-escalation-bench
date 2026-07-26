# Corrections

Corrections applied between `v1.0.0` and `v1.0.1`, following an external
multi-perspective review of the repo against its own evidence records and
an independent adjudication of that review. Ground rules observed
throughout: **no frozen protocol bytes and no evidence bytes were
rewritten** — issues inside frozen or checksummed files are resolved here
and by additive supplements, never by editing the originals. **None of
these corrections changes any published outcome, cost figure, pass
count, or finding.** `v1.0.0` is superseded by `v1.0.1`; both tags are
immovable.

Each entry: the old claim, the corrected claim, the source artifact that
decides it, and the effect on results.

---

**1. Decoy metric label.**
*Old (README):* "one decoy trial graded 0.71 field accuracy against the
required 1.00."
*Corrected:* 0.71 is `accuracy.overall`; the recorded `fieldAccuracy` is
exactly 1.00 on both tables. The shortfall is `rowCoverage` (5 of 12
rows).
*Source:* `evidence/phase2a/runs/keyed-s*-C/results.json`,
`f2-decoy-l1-a` (identical in all five sweeps);
`packages/agent/src/core/score.ts`.
*Effect on results:* none — the number was right; the metric name was
wrong.

**2. Decoy failure characterization.**
*Old (README, PHASE2A_RESULTS):* extraction "returns the wrong rows" /
"extracted wrong data."
*Corrected:* extraction silently stopped after page 1 and returned 5 of
12 rows — every extracted row is a genuine ground-truth row and every
checked field is correct (`unexpectedRows: 0`, `duplicateRows: 0`). The
failure is silent truncation, not wrong values.
*Source:* same records as (1).
*Effect on results:* none.

**3. Scope of "it never learns anything went wrong."**
*Old (README):* implied all six pure decoy cells fail silently.
*Corrected:* only the two level-1 cells are silent
(`outcomeClass: silent-corruption`, no error anywhere); level-2 and
level-3 cells recorded explicit `not_found` / `auth` failures. The
verified core claim is unchanged: zero LLM calls across all six cells in
all five sweeps — the repair trigger never fires.
*Source:* `evidence/phase2a/runs/keyed-s*-C/failures.jsonl`.
*Effect on results:* none.

**4. "The one compound cell where C's repair did fire."**
*Old (README):* read out of context, "one" is ambiguous.
*Corrected:* "the one compound **decoy** cell" (`x-class-l2-decoy-l2`).
C's selector repair also fired in `x-class-l3-page-size-2` (4 calls) and
its extraction-repair path spent 2 calls in `x-cards-header-vocabulary`.
The healed selectors in the decoy cell were the drifted login fields;
the failing step's cached selector was never healed because the decoy
absorbed the click.
*Source:* `runs/bench-*/trials/*/artifacts/healed-cache.json` (all five
C sweeps; machine-local `runs/` artifacts, **not bundled** in
`evidence/`); `evidence/phase2a/runs/keyed-s*-C/results.json`.
*Effect on results:* none.

**5. The gate-cell repair call.**
*Old (README):* "C aims its one repair call at a control that does not
exist."
*Corrected:* the cached target (`#tab-table`) genuinely does not exist on
small pages, but the repair call did not fire into a void — `observe()`
returned a candidate, the heal recorded a replacement selector, and the
trial still failed. (Which control the heal landed on is inferred from
markup, not execution evidence, and is deliberately not published.)
*Source:* `runs/bench-*/trials/f3-page-size-*/artifacts/healed-cache.json`
(machine-local `runs/` artifacts, **not bundled** in `evidence/`).
*Effect on results:* none.

**6. Readiness-check location.**
*Old (README, PHASE2A_RESULTS):* "a readiness check buried in the
harness" / "harness assumption."
*Corrected:* the check is `waitForContent` in
`packages/agent/src/core/domReady.ts` — the policies' shared pipeline
core, i.e. inside the systems under test, not the benchmark harness
(`packages/agent/src/reliability/runner.ts`, per ARCHITECTURE.md's
definition).
*Effect on results:* none — the finding is unchanged; its address was
wrong.

**7. Chaos-mode grounding.**
*Old (README, EVIDENCE.md):* "every chaos flag in the lab maps to a
cited real-world incident."
*Corrected:* three of the fourteen chaos flags (`classDrift`,
`layoutVariant`, `columnShuffle`) carry cited external evidence, and
most citations document failure *modes* rather than incidents. The
Phase-2A decoy and small-page axes are constructed diagnostic probes,
not observed incidents.
*Source:* `docs/EVIDENCE.md` table of contents;
`packages/shared/src/chaos.ts`. The same overclaim also appeared in
`docs/LIMITATIONS.md`, `docs/PHASE1_RESULTS.md`, and `docs/WRITEUP.md`
and is corrected in all three.
*Effect on results:* none.

**8. The baseballr incident.**
*Old (README):* "…which is this suite's column-shuffle scenario observed
in production."
*Corrected:* Baseball Savant *inserted* a column (`miss_distance`); the
lab's `columnShuffle` is an exact permutation of a fixed 9-column set
and cannot represent an insertion. Same positional-addressing failure
class; different mechanism. EVIDENCE.md had it right; the README
overclaimed identity.
*Source:* baseballr PR #412 / issue #408;
`packages/shared/src/chaosParams.ts`.
*Effect on results:* none.

**9. Keyless zero-cost verification method.**
*Old (PHASE2A_RESULTS):* "every keyless trial records `llmCalls: 0`."
*Corrected:* B and B2 record `llmCalls: 0` on all 320 trials; policy A's
160 trials record `"tokens": null` (baseline engine, no model
configured). Zero cost is machine-verified via those fields plus the
keyless ledger pricing all 15 sweeps at $0.
*Source:* `evidence/phase2a/runs/keyless-*/results.json`;
`evidence/phase2a/states/campaign-state.keyless.json`.
*Effect on results:* none — costs unchanged; the stated verification
route was imprecise.

**10. Phase-1 durations (published values change; no findings do).**
*Old (HARNESS.md, WRITEUP.md):* baseline mean 4.51s, hybrid mean 4.12s;
layout-variant 42.5s vs 4.2s.
*Corrected:* 4.52s (4517.125 ms) and 4.18s (4179.875 ms); 42.6s
(42 590 ms) and 4.5s (4466 ms). The stale values were copied from a
superseded run rather than the committed evidence snapshot.
*Source:* `evidence/phase1/keyless-tier/results.json` (per-trial
`durationMs`).
*Effect on results:* the four duration figures themselves are corrected;
no pass/fail outcome, accuracy, cost, or finding changes.

**11. Citation re-verification date.**
*Old (EVIDENCE.md):* verified 2026-07-13; "two were additionally
hand-checked."
*Corrected:* verified 2026-07-20 — 27 citations by the automated sweep,
the 28th (baseballr issue #408) by hand, and two Stagehand docs quotes
additionally confirmed by raw-HTML re-checks.
*Source:*
`evidence/phase1/citations/evidence-reverification-summary.json`
(`checkedAt: 2026-07-20`).
*Effect on results:* none.

**12. Phase-1 checksum coverage.**
*Old (evidence/phase1/README.md — frozen, checksummed, left untouched):*
"`checksums.txt` covers every file."
*Corrected:* the frozen manifest covers 32 of 36 files; the four
`keyless-tier/` files (the committed keyless evidence) were outside it.
An **additive supplementary manifest**,
`evidence/phase1/checksums.keyless-tier.txt`, now covers them; verify
with `shasum -a 256 -c checksums.keyless-tier.txt` from
`evidence/phase1/`. The original manifest and README bytes are
unchanged.
*Effect on results:* none.

**13. PROTOCOL_2A "DRAFT" status header.**
*Old:* `docs/PROTOCOL_2A.md` opens "Status: DRAFT … not yet frozen."
*Clarified (bytes untouched):* that header is part of the stage-1 frozen
text. The document became binding at `phase2a-policy-freeze-v3` and
complete at `phase2a-suite-freeze-v1`; editing it now would break the
freeze it documents. Clarifying note added to PHASE2A_RESULTS.md.
*Effect on results:* none.

**14. Browserbase.**
*Old (README):* "Built on Stagehand + Browserbase."
*Corrected:* all campaign runs drove local Chrome; every evidence record
stamps `browserbase not configured`. A Browserbase adapter ships but was
not exercised in either campaign.
*Source:* `evidence/phase2a/runs/*/results.md`; `docs/LIMITATIONS.md`.
Also corrected in `package.json`'s description.
*Effect on results:* none.

**15. Suite-author identity.**
*Old (README):* stated "GPT-5.6" as bare fact.
*Corrected:* the repo's artifacts prove the suite's bytes, SHA-256,
post-freeze timing, and registered predictions; the author's *model
identity* is an operator attestation, now labeled as such.
*Effect on results:* none.

**16. Mechanical.**
`git clone <this-repo>` placeholder replaced with the real URL; eslint
now ignores `.venv/` (its vendored third-party JS was failing `pnpm
lint` with 63 errors unrelated to repo source).
*Effect on results:* none.

**17. "Five policies, one variable."**
*Old (README):* "They differ in exactly one thing" / "when two policies
score differently, the policy is the reason."
*Corrected:* B, B2, and C are settings of one hybrid engine; A and D
use distinct engines, so comparisons involving them are policy-bundle
comparisons rather than configuration-only ablations. The section is
now titled "Five policies, one treatment."
*Source:* `packages/agent/src/` (three engines); README "Under the
hood."
*Effect on results:* none.

**18. Hold-out direction.**
*Old (README):* "Held out, so nothing could be tuned to it."
*Corrected:* the freeze protects one direction only: the frozen
implementations could not be tuned to the suite. The suite author had
read the frozen code (three executable audits preceded suite
authorship) and deliberately targeted known policy internals.
*Source:* `docs/PROTOCOL_2A.md` freeze lineage and audit record.
*Effect on results:* none.

**19. Premium-line scope.**
*Old (README, this correction pass's own first draft):* "catching
failures that don't look like failures" implied all six decoy cells
were silent.
*Corrected:* only the two level-1 cells are silent; the precise
statement common to all six is that none presented as a
cached-selector miss, so C's repair trigger never fired.
*Source:* entry 3's records.
*Effect on results:* none.

---

## Disclosures added in the same pass (not corrections)

- Model under test named in the README and results doc:
  `anthropic/claude-haiku-4-5`, priced from provider-reported tokens at
  the table pinned 2026-07-14 (`packages/agent/src/reliability/prices.ts`).
- Phase-2A recorded inference spend stated in the README: **$8.213774**
  ($5.878303 in the accepted published grid + $2.274621 aborted first
  attempt, preserved and never pooled + $0.060850 discarded partial).
- The no-cost keyless reproduction command
  (`pnpm campaign:2a --suite data/phase2a/scenario-suite.json --phase
  keyless`, 480 trials) added to the README.
- An independence statement (no affiliation with Anthropic or
  Browserbase; costs from provider-reported tokens at pinned public
  prices, not invoice-reconciled).
- A browser-runtime disclosure in `docs/LIMITATIONS.md`: policy A ran
  on Playwright's bundled Chromium while B/B2/C/D drove installed
  Chrome, so browser build is part of the policy bundle, not
  controlled across policy families (surfaced by per-trial browser
  provenance added after `v1.0.0`).
- What the frozen verifier can and cannot reproduce (re-verification of
  shipped records, not a re-run; raw extractions are machine-local).
- Why the scoreboard carries no error bars (deterministic cells;
  correlated sweeps; effective unit = 32 scenarios).
- A Phase-2A section in `docs/LIMITATIONS.md`, which previously covered
  Phase 1 only.
