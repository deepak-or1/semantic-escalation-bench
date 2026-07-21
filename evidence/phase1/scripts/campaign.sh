#!/bin/zsh
# Frozen §6 campaign: 5 cold D + 5 cold C + 5 paired persistence + 1 warm + aggregate.
set -e
cd /Users/deepakdalai/Documents/GitHub/stateful-sports-data-agent
PNPM=$HOME/Library/pnpm/pnpm
CAMP=/private/tmp/claude-501/-Users-deepakdalai/3f37e143-3b6e-4717-b7a5-fef7152b15e1/scratchpad/campaign
mkdir -p "$CAMP"
DIRS="$CAMP/dirs.txt"
: > "$DIRS"

run_bench() { # $1 = label, remaining args = bench flags
  local label=$1; shift
  git checkout -- runs/latest
  local log="$CAMP/$label.log"
  "$PNPM" bench -- "$@" > "$log" 2>&1
  local res=$(grep "results.json :" "$log" | awk '{print $NF}')
  local dir=$(dirname "$res")
  echo "$label $dir" >> "$DIRS"
  python3 -c "
import json
r = json.load(open('$res'))
t = r['trials']
llm = sum((x.get('tokens') or {}).get('llmCalls', 0) for x in t)
scr = sum(1 for x in t if x['outcomeClass'] == 'silent-corruption')
print('$label: trials', len(t), 'passes', sum(1 for x in t if x['outcome']=='pass'),
      'llmCalls', llm, 'silent-corruption', scr,
      'purpose', r['environment'].get('runPurpose'), 'dirty', r['environment']['gitDirty'])
"
}

c_dir() { grep "^C-cold-$1 " "$DIRS" | awk '{print $2}'; }

for i in 1 2 3 4 5; do
  run_bench "D-cold-$i" --engines stagehand --purpose cold
done

for i in 1 2 3 4 5; do
  run_bench "C-cold-$i" --engines hybrid --purpose cold
done

for i in 1 2 3 4 5; do
  "$PNPM" heals:collect "$(c_dir $i)" --out "$CAMP/manifest-$i.json" > "$CAMP/heals-$i.log" 2>&1
  run_bench "C-persist-$i" --engines hybrid --seed-cache-manifest "$CAMP/manifest-$i.json" --purpose persistence
done

run_bench "C-warm-1" --engines hybrid --seed-cache-manifest "$CAMP/manifest-1.json" --purpose warm

git checkout -- runs/latest
"$PNPM" campaign:aggregate $(awk '{print $2}' "$DIRS") --out-dir "$CAMP/report" > "$CAMP/aggregate.log" 2>&1
tail -3 "$CAMP/aggregate.log"
echo "CAMPAIGN COMPLETE - report at $CAMP/report/campaign-report.md"
