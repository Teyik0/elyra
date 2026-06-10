# Furin Benchmarks

This workspace contains deterministic benchmarks for Furin. Each benchmark category lives in its own directory and can be run independently.

## Categories

| Benchmark | Description | Status |
|-----------|-------------|--------|
| [`bundle-size`](./bundle-size/) | Client bundle size (raw / gzip / brotli) for minimal and full API surface scenarios. | ✅ Ready |
| `ssr` | Server-side rendering throughput (req/s). | 🚧 Planned |
| `client-nav` | Client-side navigation performance (navigations/s). | 🚧 Planned |

## Philosophy

- **No external comparison inline**: benchmarks measure Furin alone to avoid fragile cross-repo setups.
- **Reference baselines**: results are documented alongside known numbers for Next.js and TanStack Start (see each benchmark's README).
- **Bun-native**: all measurement scripts use Bun's built-in bundler and runtime APIs. No Vite, Webpack, or Node-only tooling.

## Run all benchmarks

```bash
bun run benchmark:bundle-size
```

## Adding a new benchmark

1. Create `benchmarks/<name>/` with a `package.json` (private).
2. Add the benchmark entry to the root `package.json` scripts.
3. Document baselines and methodology in the benchmark's `README.md`.

## References

- [TanStack Router benchmarks](https://github.com/TanStack/router/tree/main/benchmarks)
- [Next.js benchmarks](https://github.com/vercel/next.js/tree/canary/benchmarks)
