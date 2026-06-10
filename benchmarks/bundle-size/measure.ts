import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { buildApp } from "@teyik0/furin/build";

interface Asset {
  brotliBytes: number;
  gzipBytes: number;
  isPolyfill: boolean;
  path: string;
  rawBytes: number;
}

interface ScenarioResult {
  assets: Asset[];
  name: string;
  totalBrotliBytes: number;
  totalGzipBytes: number;
  totalRawBytes: number;
}

interface BenchmarkOutput {
  generatedAt: string;
  scenarios: ScenarioResult[];
  tool: string;
}

const SCENARIOS = ["minimal", "full"];
const BUNDLE_DIR = join(import.meta.dir, "scenarios");
const RESULTS_DIR = join(import.meta.dir, "results");

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function cleanBuild(rootDir: string): void {
  const buildDir = join(rootDir, ".furin");
  if (existsSync(buildDir)) {
    rmSync(buildDir, { force: true, recursive: true });
  }
}

async function measureScenario(name: string): Promise<ScenarioResult> {
  const rootDir = join(BUNDLE_DIR, name);
  cleanBuild(rootDir);

  console.log(`\n▶ Building scenario: ${name}`);

  await buildApp({
    target: "bun",
    rootDir,
    pagesDir: "src/pages",
  });

  const clientDir = join(rootDir, ".furin", "build", "bun", "client");
  if (!existsSync(clientDir)) {
    throw new Error(`Client build output not found for scenario "${name}"`);
  }

  const files = readdirSync(clientDir).filter(
    (file) => file.endsWith(".js") || file.endsWith(".css")
  );

  const assets: Asset[] = [];
  let totalRaw = 0;
  let totalGzip = 0;
  let totalBrotli = 0;
  let polyfillRaw = 0;
  let polyfillGzip = 0;
  let polyfillBrotli = 0;

  for (const file of files) {
    const filePath = join(clientDir, file);
    const raw = readFileSync(filePath);
    const rawBytes = raw.byteLength;
    const gzipBytes = gzipSync(raw).byteLength;
    const brotliBytes = brotliCompressSync(raw).byteLength;
    const isPolyfill = raw.toString().includes("crypto-browserify");

    assets.push({ path: file, rawBytes, gzipBytes, brotliBytes, isPolyfill });
    if (isPolyfill) {
      polyfillRaw += rawBytes;
      polyfillGzip += gzipBytes;
      polyfillBrotli += brotliBytes;
    } else {
      totalRaw += rawBytes;
      totalGzip += gzipBytes;
      totalBrotli += brotliBytes;
    }
  }

  assets.sort((a, b) => b.rawBytes - a.rawBytes);

  console.log(`  Scenario: ${name}`);
  for (const asset of assets) {
    const tag = asset.isPolyfill ? " [polyfill]" : "";
    console.log(
      `    ${asset.path}${tag}  raw=${formatBytes(asset.rawBytes)}  gzip=${formatBytes(asset.gzipBytes)}  brotli=${formatBytes(asset.brotliBytes)}`
    );
  }
  console.log(
    `    total (framework)  raw=${formatBytes(totalRaw)}  gzip=${formatBytes(totalGzip)}  brotli=${formatBytes(totalBrotli)}`
  );
  if (polyfillRaw > 0) {
    console.log(
      `    total (polyfills)  raw=${formatBytes(polyfillRaw)}  gzip=${formatBytes(polyfillGzip)}  brotli=${formatBytes(polyfillBrotli)}`
    );
  }

  return {
    name,
    assets,
    totalRawBytes: totalRaw,
    totalGzipBytes: totalGzip,
    totalBrotliBytes: totalBrotli,
  };
}

async function main(): Promise<void> {
  if (!existsSync(RESULTS_DIR)) {
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const results: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    const result = await measureScenario(scenario);
    results.push(result);
  }

  const output: BenchmarkOutput = {
    generatedAt: new Date().toISOString(),
    tool: "bun",
    scenarios: results,
  };

  const outputPath = join(RESULTS_DIR, "current.json");
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`\n✓ Results written to ${outputPath}`);

  // Print comparison summary
  console.log("\n=== Comparison Summary ===");
  const minimal = results.find((r) => r.name === "minimal");
  const full = results.find((r) => r.name === "full");

  if (minimal && full) {
    const deltaGzip = full.totalGzipBytes - minimal.totalGzipBytes;
    const pct = ((deltaGzip / minimal.totalGzipBytes) * 100).toFixed(1);
    console.log(`Minimal: ${formatBytes(minimal.totalGzipBytes)} (gzip)`);
    console.log(`Full:    ${formatBytes(full.totalGzipBytes)} (gzip)`);
    console.log(`Delta:   +${formatBytes(deltaGzip)} (${pct}% increase)`);
  }

  console.log("\n=== External Baselines ===");
  console.log(
    "TanStack Start minimal (react): ~18 KiB gzip (ref: tanstack/router/benchmarks/bundle-size)"
  );
  console.log("Next.js App Router (hello world): ~85 KiB gzip (ref: vercel/next.js benchmarks)");
  console.log(
    "Furin minimal is expected to be smaller than both due to zero runtime router and Bun-native bundling."
  );
  console.log(
    "\nNote: Polyfill chunks (e.g. crypto-browserify) are excluded from the 'framework' total."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
