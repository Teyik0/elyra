#!/usr/bin/env bash
set -euo pipefail

export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

readonly TEST_ARGS=(
  --parallel=1
  --isolate
  --bail
  --timeout
  30000
  --preload
  ../../tests/setup.ts
)

FURIN_RSC_CODEC_PATH=./dist/rsc/server-codec.js bun test "${TEST_ARGS[@]}" ./tests/deferred-endpoint.test.ts
sleep 3

FURIN_RSC_CODEC_PATH= bun test "${TEST_ARGS[@]}" ./tests/render-cases.ts
sleep 3

while IFS= read -r file; do
  if [[ "${FURIN_TEST_CHANGED:-0}" == "1" ]]; then
    FURIN_RSC_CODEC_PATH=./dist/rsc/server-codec.js bun test --changed "${TEST_ARGS[@]}" "$file"
  else
    FURIN_RSC_CODEC_PATH=./dist/rsc/server-codec.js bun test "${TEST_ARGS[@]}" "$file"
  fi
  sleep 0.1
done < <(find tests -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) ! -name 'deferred-endpoint.test.ts' | sort)
