#!/bin/bash
# 1. Wispr Flow: rest of the English corpora (~3.7 h, machine must stay untouched).
# 2. Codictate models: catch up from depth 400 to depth 950 (~11.6 h, no focus needed).
#    950 exhausts es_419 (905), da_dk (927) and hu_hu (902); only English stops short,
#    at the depth Flow already measured. That is the head-to-head comparison depth.
# Re-running this script after a Ctrl-C is safe: finished work is skipped, not repeated.
BENCH="$(cd "$(dirname "$0")/.." && pwd)"
CODICTATE="$BENCH/../codictate"

cd "$BENCH" && bun run benchmark -- \
  --name 2026-09-v4-english-tail \
  --description "Wispr Flow, English clips 2201 to end of both corpora" \
  --datasets test-clean,test-other \
  --to 2936 2>&1 | tee logs/v4-english-tail.log

cd "$CODICTATE" && bun run benchmark -- \
  --name 2026-09-v4-multilingual-catchup \
  --description "Clips 401-950, 13 multilingual models, matching the Flow comparison depth" \
  --models large-v3-q5_0,large-v3,large-v3-turbo,large-v3-turbo-q5_0,large-v3-turbo-q8_0,parakeet-tdt-0.6b-v3,large-v1,large-v2,large-v2-q5_0,large-v2-q8_0,medium,medium-q5_0,medium-q8_0 \
  --splits test-clean,test-other \
  --languages es_419,da_dk,hu_hu \
  --to 950 2>&1 | tee "$BENCH/logs/v4-multilingual-catchup.log"

bun run benchmark -- \
  --name 2026-09-v4-hviske-catchup \
  --description "Clips 401 to end of da_dk, 5 Danish-pinned hviske models" \
  --models hviske-v5-tiny-f16,hviske-v5-tiny-q8_0,hviske-v5-tiny-q6_k,hviske-v5-tiny-q5_0,hviske-v5-tiny-q4_k \
  --splits none \
  --languages da_dk \
  --to 927 2>&1 | tee "$BENCH/logs/v4-hviske-catchup.log"
