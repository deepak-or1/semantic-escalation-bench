# Phase-1 keyless-tier evidence (relocated from `runs/latest/`)

These three files are the Phase-1 keyless benchmark results quoted in the
top-level README (baseline 18/24, hybrid deterministic tier 20/24). They
were originally committed as `runs/latest/{results.json,results.md,failures.jsonl}`
at commit `a7c9cf5` ("Freeze evidence v4: keyless benchmark regenerated at
3a9a24c; gates pass") and are preserved here **byte-for-byte** (verified by
SHA-256 against `git show a7c9cf5:runs/latest/<file>` at relocation time).

## Why they moved

`runs/latest/` is a live mirror: the benchmark runner rewrites it after
**every** run. Keeping the mirror's files tracked in git was compatible with
Phase 1's one-run-at-a-time workflow (run, then commit the mirror), but it is
structurally incompatible with the Phase-2A campaign provenance rule:

- The frozen Phase-2A verifier (`scripts/verify-suite.ts`) requires every
  admissible run to record `gitDirty: false`.
- The frozen runner mirrors each completed run into `runs/latest/`.
- A campaign chains 15 runs in one process, so run 1's mirror write modified
  the three tracked files and every subsequent run (2–15) truthfully recorded
  `gitDirty: true` — failing verification for the whole grid.

Untracking the mirror (`runs/` is now fully ignored apart from `.gitkeep`)
resolves this without touching any frozen code: the runner still mirrors to
`runs/latest/` on disk, and the campaign no longer dirties the tree. The
first (provenance-failed) keyless grid's artifacts are preserved on disk as
recorded history; its judged outcomes are compared against the clean rerun in
the Phase-2A keyless report.
