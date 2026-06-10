# Bundle Size Benchmarks

Deterministic bundle-size fixtures for **Furin**.

## Scenarios

| Scenario | Description |
|----------|-------------|
| `minimal` | Smallest possible app: `root` layout + index page that renders `hello world`. |
| `full` | Same route shape plus a broad harness that imports and exercises the entire public API surface (`createRoute`, `defer`, `Link`, `Await`, `useAsyncValue`, `notFound`, `staticParams`, nested layouts, etc.). |

## Metrics

Primary metrics measure all emitted client JS/CSS chunks and are reported as **raw / gzip / brotli** bytes.

- **Gzip** is the primary tracking signal for PR deltas and historical charting.
- **Brotli** is provided for context (many CDNs serve brotli-compressed assets).

> **Polyfill exclusion:** The `crypto-browserify` polyfill (~156 KiB gzip) is currently emitted by Bun when bundling `evlog`’s dynamic `import("node:crypto")`. It is **excluded** from the framework total so the benchmark reflects only the Furin runtime + React surface.

## Local Run

```bash
bun run benchmark:bundle-size
```

This writes:

- `benchmarks/bundle-size/results/current.json`

## Design Notes

- Scenarios use file-based routing as the default app style.
- Full-surface coverage is manually maintained (no strict export-coverage gate).
- The measurement script uses `Bun.build()` directly (no Vite/Webpack) so the numbers reflect exactly what Furin ships in production.

## External Baselines

| Framework | Minimal (gzip) | Source |
|-----------|----------------|--------|
| **TanStack Start** (react) | ~18 KiB | [tanstack/router/benchmarks/bundle-size](https://github.com/TanStack/router/tree/main/benchmarks/bundle-size) |
| **Next.js App Router** | ~85 KiB | [vercel/next.js benchmarks](https://github.com/vercel/next.js/tree/canary/benchmarks) |

Furin targets a smaller footprint than both thanks to:

1. Zero runtime router (routes are resolved at build time and compiled into a static map).
2. Bun-native bundler (no extra JS-based bundler overhead in the runtime).
3. Minimal hydration entry (only the exact page + layout components are shipped, no framework-level indirection layers).

## CI Reporting

Planned: push-to-main workflow that publishes historical chart data to GitHub Pages via `github-action-benchmark`.

## Manual Update Policy

When Furin public hooks/components evolve, update the corresponding `full` scenario harness to keep the benchmark representative.
