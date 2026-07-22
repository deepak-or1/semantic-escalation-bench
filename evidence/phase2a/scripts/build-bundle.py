#!/usr/bin/env python3
"""Assemble the Phase-2A evidence bundle from the local runs/ tree.

This is the script that built evidence/phase2a/ on 2026-07-21, kept as
provenance. It is not runnable from a fresh clone (runs/ is gitignored and
machine-local); everything it copied is committed, checksummed in
../checksums.txt, and re-verifiable via:

    pnpm verify:suite evidence/phase2a/runs/* \
      --suite data/phase2a/scenario-suite.json \
      --expect-policies A,B,B2,C,D --expect-trials 5

Per run it preserves results.json (the verifier's sole gated input, carrying
per-trial outcomes, tokens, and the provenance stamps), plus manifest.json,
results.md, and failures.jsonl byte-for-byte. Full per-trial artifact
directories (screenshots, event logs, raw extractions) stay machine-local:
~120 MB of binary artifacts against ~1.5 MB of records, and nothing the
frozen verifier gates on lives there.
"""
import hashlib
import json
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
P2A = REPO / "runs" / "phase2a"
OUT = REPO / "evidence" / "phase2a"

RUN_FILES = ["results.json", "manifest.json", "results.md", "failures.jsonl"]

STATES = {
    "campaign-state.keyless.json": "the verified keyless ledger (15 entries)",
    "campaign-state.keyed.restart1.json": "the verified keyed ledger (10 entries)",
    "campaign-state.keyed.attempt1-aborted-transport-contamination.json":
        "aborted keyed attempt 1 (transport contamination; excluded)",
    "campaign-state.keyless.attempt1-dirty-provenance.json":
        "aborted keyless attempt 1 (gitDirty provenance; excluded)",
}

REPORTS = [
    "KEYLESS_REPORT.md", "KEYED_REPORT.md", "KEYED_INCIDENT.md",
    "verify.final.txt", "verify.keyless.attempt1.txt", "verify.keyless.attempt2.txt",
]


def load_entries(state_name):
    state = json.loads((P2A / state_name).read_text())
    return [e for e in state["entries"] if e.get("status") == "complete"]


def copy_run(src_dir, dest_dir):
    dest_dir.mkdir(parents=True, exist_ok=True)
    for name in RUN_FILES:
        src = Path(src_dir) / name
        if src.exists():
            shutil.copy2(src, dest_dir / name)


def main():
    run_map = {}

    for e in load_entries("campaign-state.keyless.json"):
        label = f"keyless-s{e['sweep']}-{e['policy']}"
        copy_run(e["dir"], OUT / "runs" / label)
        run_map[label] = {"dir": e["dir"], "bundle": f"runs/{label}", "ledger": "keyless"}

    for e in load_entries("campaign-state.keyed.restart1.json"):
        label = f"keyed-s{e['sweep']}-{e['policy']}"
        copy_run(e["dir"], OUT / "runs" / label)
        run_map[label] = {"dir": e["dir"], "bundle": f"runs/{label}", "ledger": "keyed-restart1"}

    for e in load_entries("campaign-state.keyed.attempt1-aborted-transport-contamination.json"):
        label = f"aborted-s{e['sweep']}-{e['policy']}"
        copy_run(e["dir"], OUT / "runs-aborted-attempt1" / label)
        run_map[label] = {
            "dir": e["dir"], "bundle": f"runs-aborted-attempt1/{label}",
            "ledger": "keyed-attempt1-aborted",
            "note": "transport-contaminated attempt; never pooled",
        }

    (OUT / "states").mkdir(parents=True, exist_ok=True)
    for name in STATES:
        shutil.copy2(P2A / name, OUT / "states" / name)

    (OUT / "report").mkdir(parents=True, exist_ok=True)
    for name in REPORTS:
        shutil.copy2(P2A / name, OUT / "report" / name)

    (OUT / "run-map.json").write_text(json.dumps(run_map, indent=2) + "\n")

    lines = []
    for f in sorted(OUT.rglob("*")):
        if f.is_file() and f.name != "checksums.txt":
            digest = hashlib.sha256(f.read_bytes()).hexdigest()
            lines.append(f"{digest}  {f.relative_to(OUT)}")
    (OUT / "checksums.txt").write_text("\n".join(lines) + "\n")
    print(f"bundled {len(run_map)} runs; {len(lines)} files checksummed")


if __name__ == "__main__":
    main()
