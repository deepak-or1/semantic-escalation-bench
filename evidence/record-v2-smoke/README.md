# Gate-1 smoke: record-v2 recompute-from-raw, at the record-v2 commit

The clean keyless smoke required by [PROTOCOL_2B.md](../../docs/PROTOCOL_2B.md)
gate 1: fresh version-2 records produced **at the record-v2 commit itself**
and verified end-to-end from their shipped raw payloads.

- **Commit under test:** `de35638` (tag `record-v2-freeze-v1`); every run
  stamps `gitCommit de35638`, `gitDirty: false`.
- **Runs (2026-07-26, keyless, $0, no provider key in the environment):**
  - `bench-2026-07-26T03-42-41-006Z` — policy A (baseline), the full frozen
    32-scenario Phase-2A suite, 1 trial per scenario.
  - `bench-2026-07-26T03-46-07-582Z` — policy B2 (hybrid,
    `--repair-mode deterministic`), same suite, 1 trial per scenario.
- **Verification** (transcript: [verify.txt](verify.txt)):
  `pnpm verify:suite <both run dirs> --suite data/phase2a/scenario-suite.json
  --expect-policies A,B2 --expect-trials 1 --expect-record-version 2`
  → schema OK, provenance OK, completeness OK, grading OK, **VERIFY: PASS**.
  Grading provenance: 64 trial records — 37 recomputed from shipped raw
  payloads, 27 hard-failure (no payload produced; consistency-checked),
  0 attested.
- **Replication note:** both runs reproduce the Phase-2A failure geography,
  including B2's readiness-gate cluster (`f3-page-size-*`,
  `x-class-l3-page-size-2`) failing exactly as registered.
- **Operational finding for gate 3:** per-trial `chromeVersion` came back
  null on a minority of trials (15/32 and 12/32) — the timeout-guarded
  version read losing the race on back-to-back engine launches. Legal in
  v2 (null is the honest "read failed" value; the run-level null follows
  from the unanimity rule), but Phase 2B requires non-null per-trial
  values, so the gate-3 implementation must make the read reliable before
  the 2B freeze.

`checksums.txt` covers every file in this directory; verify with
`shasum -a 256 -c checksums.txt` from `evidence/record-v2-smoke/`.
