#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

readonly TEST_ARGS=(
  --parallel=2
  --isolate
  --bail
  --timeout
  30000
  --preload
  ./tests/setup/global.ts
)

if [[ "${FURIN_TEST_CHANGED:-0}" == "1" ]]; then
  FURIN_RSC_CODEC_PATH=./dist/rsc/server-codec.js bun test --changed "${TEST_ARGS[@]}"
  exit 0
fi

FURIN_RSC_CODEC_PATH=./dist/rsc/server-codec.js bun test "${TEST_ARGS[@]}" ./tests/rendering/deferred/deferred-endpoint.test.ts
sleep 3

while IFS= read -r file; do
  FURIN_RSC_CODEC_PATH=./dist/rsc/server-codec.js bun test "${TEST_ARGS[@]}" "$file"
  sleep 0.1
done < <(find tests -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) \
  ! -name '*.integration.test.ts' \
  ! -path 'tests/dev/hmr/*' \
  ! -path 'tests/rendering/deferred/deferred-endpoint.test.ts' | sort)

while IFS= read -r file; do
  FURIN_RSC_CODEC_PATH=./dist/rsc/server-codec.js bun test "${TEST_ARGS[@]}" "$file"
  sleep 0.1
done < <(find tests -type f \( -name '*.integration.test.ts' -o -name '*.integration.test.tsx' \) \
  ! -path 'tests/dev/hmr/*' | sort)

while IFS= read -r file; do
  FURIN_RSC_CODEC_PATH=./dist/rsc/server-codec.js bun test "${TEST_ARGS[@]}" "$file"
  sleep 0.1
done < <(find tests/dev/hmr -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) | sort)
