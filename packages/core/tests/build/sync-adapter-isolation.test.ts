import { describe, expect, test } from "bun:test";

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
  test("keeps core and browser bundles free of optional backend code", async () => {
    const [core, browser] = await Promise.all([
      bundle("core", "bun"),
      bundle("browser", "browser"),
    ]);
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
});
