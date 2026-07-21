#!/usr/bin/env python3
"""Sol's per-sweep admissibility checklist, mechanized.

Input: either a two-column dirs.txt (label run-dir, the original campaign
working-area format) or the bundle's run-map.json (labels + bundle-relative
run paths, resolved against the map file's own directory). From the repo root:

    python3 evidence/phase1/scripts/verify-sweeps.py evidence/phase1/run-map.json
"""
import json, os, sys

EXPECT = {
    "gitCommit": "a7c9cf5",
    "promptsHash": "5c07ce1fbc35",
    "lockfileHash": "b6f0dd3ad619",
    "model": "anthropic/claude-haiku-4-5",
}
PURPOSE = {"D-cold": "cold", "C-cold": "cold", "C-persist": "persistence", "C-warm": "warm"}
ENGINE = {"D-cold": "stagehand", "C-cold": "hybrid", "C-persist": "hybrid", "C-warm": "hybrid"}

failures = []
def check(label, name, ok, detail=""):
    if not ok:
        failures.append(f"{label}: {name} {detail}")

src = sys.argv[1] if len(sys.argv) > 1 else "dirs.txt"
if src.endswith(".json"):
    base = os.path.dirname(os.path.abspath(src))
    sweeps = [(e["label"], os.path.join(base, os.path.dirname(e["bundlePath"])))
              for e in json.load(open(src))]
else:
    sweeps = [tuple(line.split()) for line in open(src)]

for label, d in sweeps:
    kind = label.rsplit("-", 1)[0]
    r = json.load(open(d + "/results.json"))
    env, trials = r["environment"], r["trials"]

    check(label, "trials==24", len(trials) == 24, f"got {len(trials)}")
    check(label, "purpose", env.get("runPurpose") == PURPOSE[kind], f"got {env.get('runPurpose')}")
    check(label, "gitCommit", env["gitCommit"].startswith(EXPECT["gitCommit"]), env["gitCommit"][:7])
    check(label, "gitDirty==False", env["gitDirty"] is False)
    check(label, "promptsHash", env["promptsHash"].startswith(EXPECT["promptsHash"]))
    check(label, "lockfileHash", env["lockfileHash"].startswith(EXPECT["lockfileHash"]))
    check(label, "model", env.get("stagehandModel") == EXPECT["model"], str(env.get("stagehandModel")))
    check(label, "no-browserbase", env.get("browserbase") is False)
    check(label, "repair-enabled", env.get("disableRepair") is False)
    want_seeded = kind in ("C-persist", "C-warm")
    seeded = env.get("seedCacheMode") not in (None, "none")
    check(label, "seedCacheMode", seeded == want_seeded, f"got {env.get('seedCacheMode')}")
    if want_seeded:
        check(label, "seedCacheHash-recorded", bool(env.get("seedCacheHash")))

    check(label, "single-engine", all(t["engine"] == ENGINE[kind] for t in trials))
    for t in trials:
        tok = t.get("tokens")
        if tok and tok.get("llmCalls", 0) > 0:
            both = isinstance(tok.get("inputTokens"), (int, float)) and isinstance(tok.get("outputTokens"), (int, float))
            check(label, "token-sides", both, f"{t['scenarioId']} {tok}")
        if t["outcomeClass"] == "recovered":
            check(label, "recovered-has-healedSteps", bool(t.get("healedSteps")), t["scenarioId"])
    sv = [t for t in trials if t["scenarioId"] == "schema-violation"]
    check(label, "schema-violation-present", len(sv) == 1)
    if sv:
        check(label, "schema-violation-safe-refusal",
              sv[0]["outcome"] == "pass" and sv[0]["outcomeClass"] == "safe-failure",
              f"outcome={sv[0]['outcome']} class={sv[0]['outcomeClass']}")
    scr = sum(1 for t in trials if t["outcomeClass"] == "silent-corruption")
    fb = sum(len(t.get("deterministicFallbacks") or []) for t in trials)
    heals = sum(1 for t in trials if t.get("healedSteps"))
    llm = sum((t.get("tokens") or {}).get("llmCalls", 0) for t in trials)
    print(f"{label}: trials={len(trials)} judged-correct={sum(1 for t in trials if t['outcome']=='pass')} "
          f"scr-observed={scr} llmCalls={llm} healedTrials={heals} detFB-firings={fb}")

print()
if failures:
    print("ADMISSIBILITY FAILURES:")
    for f in failures: print(" -", f)
    sys.exit(1)
print("ALL ADMISSIBILITY CHECKS PASS for", len(sweeps), "completed sweeps")
