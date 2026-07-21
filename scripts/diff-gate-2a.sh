#!/usr/bin/env bash
#
# Phase-2A diff gate (PROTOCOL_2A §6). Between two refs it fails (exit 1) if any
# changed path is outside the stage-2 allowlist, and — for docs/PROTOCOL_2A.md —
# if any byte OUTSIDE the frozen appendix markers changed. The gate EXCLUDES its
# own report path from the change calculation, so committing the report and
# rerunning yields byte-identical output (§6 step 4). No timestamps: the output
# is deterministic.
#
#   scripts/diff-gate-2a.sh <base-ref> [head-ref, default HEAD]
#
set -euo pipefail

BASE_REF="${1:-}"
HEAD_REF="${2:-HEAD}"

if [ -z "$BASE_REF" ]; then
  echo "usage: scripts/diff-gate-2a.sh <base-ref> [head-ref, default HEAD]" >&2
  exit 2
fi

# Run from the repo root so every path below is repo-relative (git's own frame).
cd "$(git rev-parse --show-toplevel)"

REPORT_PATH="evidence/phase2a/diff-gate.txt"
SUITE_FILE="data/phase2a/scenario-suite.json"
PROTOCOL_FILE="docs/PROTOCOL_2A.md"
MARKER_START="<!-- PHASE2A-APPENDIX-START -->"
MARKER_END="<!-- PHASE2A-APPENDIX-END -->"

in_allowlist() {
  case "$1" in
    "$SUITE_FILE" | "$PROTOCOL_FILE" | "$REPORT_PATH") return 0 ;;
    *) return 1 ;;
  esac
}

sha256_of() { # reads stdin, prints the hex digest only
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

# Bytes OUTSIDE the appendix region: keep the two marker lines and everything
# around them, drop only the content strictly between them (which is allowed to
# change at stage 2). A missing marker leaves inapp=0, so the whole file is
# compared — marker tampering is caught.
outside_appendix() { # arg: ref
  git show "$1:$PROTOCOL_FILE" 2>/dev/null | awk -v s="$MARKER_START" -v e="$MARKER_END" '
    $0 == s { print; inapp = 1; next }
    $0 == e { inapp = 0; print; next }
    inapp { next }
    { print }
  '
}

# Changed paths between the refs, with the gate's OWN report path removed from the
# calculation, sorted deterministically.
changed="$(git diff --name-only "$BASE_REF" "$HEAD_REF" | grep -vFx "$REPORT_PATH" | LC_ALL=C sort || true)"

allowlist_verdict="PASS"
out_of_allowlist=""
if [ -n "$changed" ]; then
  while IFS= read -r pathline; do
    [ -z "$pathline" ] && continue
    if ! in_allowlist "$pathline"; then
      allowlist_verdict="FAIL"
      out_of_allowlist="${out_of_allowlist}${pathline}"$'\n'
    fi
  done <<< "$changed"
fi

# Appendix-marker check: compare the outside-marker bytes at both refs, but only
# when the protocol file exists at both (else its add/remove is already an
# allowlist concern). PASS when identical.
appendix_verdict="PASS"
if git cat-file -e "$BASE_REF:$PROTOCOL_FILE" 2>/dev/null && git cat-file -e "$HEAD_REF:$PROTOCOL_FILE" 2>/dev/null; then
  base_outside="$(outside_appendix "$BASE_REF" | sha256_of)"
  head_outside="$(outside_appendix "$HEAD_REF" | sha256_of)"
  if [ "$base_outside" != "$head_outside" ]; then
    appendix_verdict="FAIL"
  fi
fi

# sha256 of the suite file at HEAD (its committed bytes), or "-" when absent.
suite_sha="-"
if git cat-file -e "$HEAD_REF:$SUITE_FILE" 2>/dev/null; then
  suite_sha="$(git show "$HEAD_REF:$SUITE_FILE" | sha256_of)"
fi

verdict="PASS"
if [ "$allowlist_verdict" = "FAIL" ] || [ "$appendix_verdict" = "FAIL" ]; then
  verdict="FAIL"
fi

# ── Deterministic report (no timestamps) ─────────────────────────────────────
echo "diff-gate-2a"
echo "base=$BASE_REF"
echo "head=$HEAD_REF"
echo "changed (report excluded):"
if [ -n "$changed" ]; then
  while IFS= read -r pathline; do
    [ -z "$pathline" ] && continue
    echo "  $pathline"
  done <<< "$changed"
else
  echo "  (none)"
fi
echo "allowlist: $allowlist_verdict"
if [ "$allowlist_verdict" = "FAIL" ]; then
  printf '%s' "$out_of_allowlist" | LC_ALL=C sort | while IFS= read -r p; do
    [ -z "$p" ] && continue
    echo "  out-of-allowlist: $p"
  done
fi
echo "appendix-markers: $appendix_verdict"
echo "suite-sha256: $suite_sha"
echo "verdict: $verdict"

[ "$verdict" = "PASS" ]
