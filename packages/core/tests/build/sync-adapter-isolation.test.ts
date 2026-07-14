import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtures = new URL("../fixtures/sync-bundles/", import.meta.url);
const postgresMarker = "pg_advisory_xact_lock";
const redisMarker = "redis.call";
const redisNotifierMarker = ":notify";
const migrationMarker = "CREATE SCHEMA IF NOT EXISTS furin_sync";

interface PackageManifest {
  dependencies?: object;
  peerDependencies?: object;
}

async function bundle(name: string, target: "browser" | "bun"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [new URL(`${name}.ts`, fixtures).pathname],
    packages: "bundle",
    root: resolve(import.meta.dir, "../.."),
    target,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Could not bundle ${name} fixture`);
  }
  const output = result.outputs[0];
  if (!output) {
    throw new Error(`No output emitted for ${name} fixture`);
  }
  return output.text();
}

async function manifest(path: string): Promise<PackageManifest> {
  return (await Bun.file(new URL(path, import.meta.url)).json()) as PackageManifest;
}

function dependencyNames(manifestValue: PackageManifest): string[] {
  return [
    ...Object.keys(manifestValue.dependencies ?? {}),
    ...Object.keys(manifestValue.peerDependencies ?? {}),
  ];
}

describe("sync adapter bundle isolation", () => {
  test("loads the built sync entrypoint without exposing test internals", async () => {
    const sync = await import("../../dist/server/sync/index.js");
    expect(sync.MemorySyncAdapter).toBeFunction();
    expect(sync.furinSync).toBeFunction();
    expect("__resetSyncState" in sync).toBe(false);
  });

  test("keeps core and browser bundles free of optional backend code", async () => {
    const core = await bundle("core", "bun");
    const browser = await bundle("browser", "browser");
    for (const output of [core, browser]) {
      expect(output).not.toContain(postgresMarker);
      expect(output).not.toContain(redisMarker);
      expect(output).not.toContain(migrationMarker);
    }
  });

  test("bundles PostgreSQL and Redis independently", async () => {
    const [postgres, redis, hybrid] = await Promise.all([
      bundle("postgres", "bun"),
      bundle("redis", "bun"),
      bundle("hybrid", "bun"),
    ]);
    expect(postgres).toContain(postgresMarker);
    expect(postgres).not.toContain(redisMarker);
    expect(redis).toContain(redisMarker);
    expect(redis).not.toContain(postgresMarker);
    expect(hybrid).toContain(postgresMarker);
    expect(hybrid).toContain(redisNotifierMarker);
    expect(hybrid).not.toContain(redisMarker);
  });

  test("does not introduce adapter dependencies through package manifests", async () => {
    const [core, postgres, redis] = await Promise.all([
      manifest("../../package.json"),
      manifest("../../../sync-postgres/package.json"),
      manifest("../../../sync-redis/package.json"),
    ]);
    expect(dependencyNames(core)).not.toContain("@teyik0/furin-sync-postgres");
    expect(dependencyNames(core)).not.toContain("@teyik0/furin-sync-redis");
    expect(dependencyNames(postgres)).not.toContain("@teyik0/furin-sync-redis");
    expect(dependencyNames(redis)).not.toContain("@teyik0/furin-sync-postgres");
  });

  test("bundles packed public packages without resolving absent adapters", async () => {
    const root = resolve(import.meta.dir, "../../../..");
    const temporaryRoot = mkdtempSync(join(tmpdir(), "furin-sync-packages-"));
    const packed = join(temporaryRoot, "packed");
    mkdirSync(packed);
    try {
      const core = pack(join(root, "packages/core"), packed);
      const postgres = pack(join(root, "packages/sync-postgres"), packed);
      const redis = pack(join(root, "packages/sync-redis"), packed);

      const scenarios: Array<{
        absent: string[];
        entry: string;
        markers: string[];
        packages: PackedPackages;
      }> = [
        {
          absent: [postgresMarker, redisMarker, migrationMarker],
          entry: 'import { MemorySyncAdapter } from "./node_modules/@teyik0/furin/dist/server/sync/index.js"; console.log(MemorySyncAdapter);',
          markers: [],
          packages: { core },
        },
        {
          absent: [redisMarker],
          entry: 'import { postgresSyncAdapter } from "./node_modules/@teyik0/furin-sync-postgres/dist/index.js"; console.log(postgresSyncAdapter);',
          markers: [postgresMarker],
          packages: { core, postgres },
        },
        {
          absent: [postgresMarker],
          entry: 'import { redisSyncAdapter } from "./node_modules/@teyik0/furin-sync-redis/dist/index.js"; console.log(redisSyncAdapter);',
          markers: [redisMarker],
          packages: { core, redis },
        },
        {
          absent: [redisMarker],
          entry: 'import { postgresSyncAdapter } from "./node_modules/@teyik0/furin-sync-postgres/dist/index.js"; import { RedisSyncNotifier } from "./node_modules/@teyik0/furin-sync-redis/dist/index.js"; console.log(postgresSyncAdapter, RedisSyncNotifier);',
          markers: [postgresMarker, redisNotifierMarker],
          packages: { core, postgres, redis },
        },
      ];

      for (const [index, scenario] of scenarios.entries()) {
        const fixture = installFixture(
          join(temporaryRoot, `consumer-${index}`),
          scenario.packages
        );
        writeFileSync(join(fixture, "entry.ts"), scenario.entry);
        const result = await Bun.build({
          entrypoints: [join(fixture, "entry.ts")],
          external: ["elysia"],
          packages: "bundle",
          target: "bun",
        });
        expect(result.success).toBe(true);
        const output = await result.outputs[0]?.text();
        if (output === undefined) {
          throw new Error(`No bundle emitted for packed scenario ${index}`);
        }
        for (const marker of scenario.markers) {
          expect(output).toContain(marker);
        }
        for (const marker of scenario.absent) {
          expect(output).not.toContain(marker);
        }
        for (const adapter of [
          "@teyik0/furin-sync-postgres",
          "@teyik0/furin-sync-redis",
        ]) {
          const isInstalled =
            adapter === "@teyik0/furin-sync-postgres"
              ? scenario.packages.postgres !== undefined
              : scenario.packages.redis !== undefined;
          expect(canResolvePackage(fixture, adapter)).toBe(isInstalled);
        }
      }
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }, 30_000);
});

interface PackedPackages {
  core: string;
  postgres?: string;
  redis?: string;
}

function pack(packageDirectory: string, destination: string): string {
  const before = new Set(readdirSync(destination));
  const result = Bun.spawnSync({
    cmd: ["bun", "pm", "pack", "--destination", destination],
    cwd: packageDirectory,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  const archive = readdirSync(destination).find((entry) => !before.has(entry));
  if (archive === undefined) {
    throw new Error(`No package archive created for ${packageDirectory}`);
  }
  return join(destination, archive);
}

function installFixture(directory: string, packages: PackedPackages): string {
  mkdirSync(directory, { recursive: true });
  installPackedPackage(directory, "@teyik0/furin", packages.core);
  if (packages.postgres !== undefined) {
    installPackedPackage(directory, "@teyik0/furin-sync-postgres", packages.postgres);
  }
  if (packages.redis !== undefined) {
    installPackedPackage(directory, "@teyik0/furin-sync-redis", packages.redis);
  }
  return directory;
}

function installPackedPackage(directory: string, name: string, archive: string): void {
  const destination = join(directory, "node_modules", ...name.split("/"));
  mkdirSync(destination, { recursive: true });
  const result = Bun.spawnSync({
    cmd: ["tar", "-xzf", archive, "--strip-components=1", "-C", destination],
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

function canResolvePackage(directory: string, specifier: string): boolean {
  return (
    Bun.spawnSync({
      cmd: ["bun", "-e", `import.meta.resolve(${JSON.stringify(specifier)})`],
      cwd: directory,
      stderr: "pipe",
      stdout: "pipe",
    }).exitCode === 0
  );
}
