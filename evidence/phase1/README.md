# Phase-1 evidence bundle

Portable, tracked evidence for the Phase-1 keyed campaign reported in
[docs/PHASE1_RESULTS.md](../../docs/PHASE1_RESULTS.md). Everything here was
mirrored from the audited campaign package on 2026-07-20; `checksums.txt`
covers every file.

- `runs/<label>/results.json` — the 16 campaign runs (5 D-cold, 5 C-cold,
  5 C-persist paired per sweep, 1 C-warm). Each file self-attests gitCommit,
  gitDirty, promptsHash, lockfileHash, runPurpose, and per-trial tokens.
- `manifests/manifest-{1..5}.json` — the five seed-cache manifests,
  **byte-identical to the originals** (their sha256 values are provenance:
  each persistence run's recorded `seedCacheHash` recomputes from these exact
  bytes). They contain machine-local absolute `cacheFile` paths by design —
  do not rewrite them; use `manifests/portable-map.json`, which maps every
  entry to its content-addressed payload under `caches/<sha256>.json`.
- `caches/` — content-addressed healed-cache payloads. (All 15 manifest
  entries share one payload: the campaign was deterministic enough that every
  healed trial in every sweep produced a byte-identical action cache.)
- `report/` — the aggregate campaign report (JSON + Markdown).
- `citations/` — the EVIDENCE.md re-verification journal (27 sweep records +
  3 dated addenda: one recovered citation, two raw-HTML confirmations), its
  summary, and `citation-map.json`, which maps each of the 28 EVIDENCE.md
  citations (document order) to its journal record key and any addenda —
  the journal's own keys are opaque hashes. The one URL cited twice
  (olostep, ordinals 12–13) has two distinct records, disambiguated by
  quote.
- `scripts/` — the campaign driver as executed, and the per-run
  admissibility verifier (its checks are as executed; an input reader for
  `run-map.json` was added when this bundle was assembled so it runs
  portably).
- `run-map.json` — label → original run directory → bundle path.

## Re-running the admissibility checks

From the repo root:

```
python3 evidence/phase1/scripts/verify-sweeps.py evidence/phase1/run-map.json
```

Expected: one line per sweep (16) and `ALL ADMISSIBILITY CHECKS PASS`.

## Re-running the aggregation

The aggregator needs only each run directory's `results.json`. Cell ordering
in the output follows input order, so feed the runs in campaign order (the
order in `run-map.json`) for a byte-comparable report:

```
pnpm campaign:aggregate $(python3 -c "import json; print(' '.join('evidence/phase1/runs/' + r['label'] for r in json.load(open('evidence/phase1/run-map.json'))))") --out-dir /tmp/phase1-check
```

The regenerated report matches all cells, configuration totals, warnings
and smoke status; only `createdAt` and `sources` differ — `sources` records
the input paths, which here are the bundle's `runs/` directories rather
than the original absolute campaign paths. (A glob like `runs/*` yields the
same cells and totals in alphabetical order — content-identical, not
byte-identical.) The report's one warning (multiple `seedCacheHash`
values) is protocol-required behavior: five paired persistence manifests plus
unseeded cold runs necessarily span multiple hashes; the aggregator
discloses rather than suppresses this.
