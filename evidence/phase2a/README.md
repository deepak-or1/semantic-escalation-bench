# Phase-2A evidence bundle

Portable, tracked evidence for the Phase-2A held-out campaign reported in
[docs/PHASE2A_RESULTS.md](../../docs/PHASE2A_RESULTS.md). Assembled from the
local `runs/` tree on 2026-07-21 by [scripts/build-bundle.py](scripts/build-bundle.py);
`checksums.txt` covers every file. Every number the repo publishes for
Phase 2A recomputes from what is in this directory.

- `runs/<label>/` — the 25 verified campaign runs: 15 keyless
  (`keyless-s{1..5}-{A,B,B2}`) and 10 keyed (`keyed-s{1..5}-{C,D}`). Each
  `results.json` carries the 32 per-trial outcomes, token counts, and
  self-attested provenance (gitCommit `867723c`, gitDirty `false`, the
  frozen `suiteHash` and `promptsHash`); `manifest.json`, `results.md`, and
  `failures.jsonl` ride along byte-for-byte. Full per-trial artifact
  directories (screenshots, event logs, raw extractions) are machine-local
  and not bundled — nothing the frozen verifier gates on lives there.
- `runs-aborted-attempt1/` — the five completed entries of the first keyed
  attempt, aborted for transport contamination (a local connectivity
  interruption zeroed token accounting mid-campaign: sweep-2 C ledgered
  $0.0000 across 30 recorded LLM calls, with `ENOTFOUND api.anthropic.com`
  failure details). Preserved because the incident report cites them;
  **never pooled into any published number**. The ruling, the outcome-blind
  poison criterion, and the full contamination map are in
  [report/KEYED_INCIDENT.md](report/KEYED_INCIDENT.md).
- `states/` — the campaign ledgers: the verified keyless and keyed
  (`restart1`) states, plus both aborted-attempt states kept as the record.
  `campaign-state.keyed.restart1.json` starts at `spendUsd` 2.274621 — the
  aborted attempt's spend carried forward as an explicitly approved
  exception so the $39.90 stop-threshold kept counting every dollar; the
  reconciliation to the cent is in
  [report/KEYED_REPORT.md](report/KEYED_REPORT.md).
- `report/` — the keyless and keyed campaign reports, the incident report,
  and the verbatim verifier outputs (`verify.final.txt` is the pooled
  25-run verdict).
- `run-map.json` — label → original run directory → bundle path.
- `diff-gate.txt` — the stage-2 diff-gate report (suite reveal vs. frozen
  grammar), produced before any trial ran.

## Re-running the suite verification

From the repo root (no key needed):

```bash
pnpm verify:suite evidence/phase2a/runs/* \
  --suite data/phase2a/scenario-suite.json \
  --expect-policies A,B,B2,C,D --expect-trials 5
```

Expected: schema/provenance/completeness/grading all OK, `VERIFY: PASS`,
exit 0, and a report-only prediction scorecard of 141 hit · 19 miss ·
0 not-run. This was re-run against these exact bundle copies after
assembly, with that result.
