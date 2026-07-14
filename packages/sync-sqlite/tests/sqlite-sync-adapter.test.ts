import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSyncAdapterConformance } from "../../core/tests/helpers/sync-adapter-conformance";
import { migrateSqliteSync, sqliteSyncAdapter } from "../src";

const database = new Database(":memory:");
migrateSqliteSync(database);
afterAll(() => database.close());
afterEach(() => setSystemTime());
let conformanceNamespace = 0;

testSyncAdapterConformance(() => {
  conformanceNamespace += 1;
  return sqliteSyncAdapter({
    database,
    namespace: `conformance-${conformanceNamespace}`,
  });
});

test("declares its host-local deployment boundary", () => {
  expect(sqliteSyncAdapter({ database, namespace: "scope" }).scope).toBe("host-local");
});

test("persists and replays a completed mutation", async () => {
  const adapter = sqliteSyncAdapter({ database, namespace: "replay" });
  const mutation = await adapter.beginMutation({
    fingerprint: "body",
    key: "create-card",
    principal: "user",
  });
  expect(mutation.kind).toBe("execute");
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }
  const response = {
    body: new TextEncoder().encode("created"),
    headers: [["content-type", "text/plain"]] as const,
    status: 201,
  };
  await adapter.completeMutation({ invalidations: [], lease: mutation.lease, response });

  expect(
    await adapter.beginMutation({
      fingerprint: "body",
      key: "create-card",
      principal: "user",
    })
  ).toEqual({ kind: "replay", response });
});

test("commits the replay response and invalidation under one cursor", async () => {
  const adapter = sqliteSyncAdapter({ database, namespace: "journal" });
  const mutation = await adapter.beginMutation({
    fingerprint: "body",
    key: "update-card",
    principal: "user",
  });
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }
  const completed = await adapter.completeMutation({
    invalidations: [{ kind: "path", path: "/cards", type: "page" }],
    lease: mutation.lease,
    response: { body: new Uint8Array(), headers: [], status: 204 },
  });

  expect(completed).toEqual({ cursor: "1", kind: "committed" });
  expect(await adapter.readChanges({ after: "0", limit: 10 })).toMatchObject({
    changes: [
      {
        cursor: "1",
        invalidations: [{ kind: "path", path: "/cards", type: "page" }],
      },
    ],
    cursor: "1",
    reset: false,
  });
});

test("rejects another payload and releases an aborted lease", async () => {
  const adapter = sqliteSyncAdapter({ database, namespace: "abort" });
  const mutation = await adapter.beginMutation({
    fingerprint: "first",
    key: "update-card",
    principal: "user",
  });
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }
  expect(
    await adapter.beginMutation({
      fingerprint: "second",
      key: "update-card",
      principal: "user",
    })
  ).toEqual({ kind: "conflict", reason: "payload-mismatch" });

  await adapter.abortMutation(mutation.lease);
  expect(
    await adapter.beginMutation({
      fingerprint: "first",
      key: "update-card",
      principal: "user",
    })
  ).toMatchObject({ kind: "execute" });
});

test("keeps the fingerprint through lease takeover and releases it after retention", async () => {
  setSystemTime(new Date(1000));
  const adapter = sqliteSyncAdapter({ database, namespace: "takeover" });
  const first = await adapter.beginMutation({
    fingerprint: "first",
    key: "update-card",
    principal: "user",
  });
  if (first.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }

  setSystemTime(new Date(1000 + first.lease.leaseMs + 1));
  expect(
    await adapter.beginMutation({
      fingerprint: "second",
      key: "update-card",
      principal: "user",
    })
  ).toEqual({ kind: "conflict", reason: "payload-mismatch" });
  const replacement = await adapter.beginMutation({
    fingerprint: "first",
    key: "update-card",
    principal: "user",
  });
  expect(replacement).toMatchObject({ kind: "execute" });
  if (replacement.kind !== "execute") {
    throw new Error("Expected a replacement mutation");
  }
  const response = { body: new Uint8Array(), headers: [], status: 204 } as const;
  expect(
    await adapter.completeMutation({ invalidations: [], lease: first.lease, response })
  ).toEqual({ kind: "lost" });
  expect(
    await adapter.completeMutation({ invalidations: [], lease: replacement.lease, response })
  ).toEqual({ cursor: undefined, kind: "committed" });

  setSystemTime(new Date(1000 + replacement.lease.leaseMs + 24 * 60 * 60 * 1000 + 2));
  expect(
    await adapter.beginMutation({
      fingerprint: "second",
      key: "update-card",
      principal: "user",
    })
  ).toMatchObject({ kind: "execute" });
});

test("coordinates reservations across two connections to one WAL file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-sync-sqlite-"));
  const filename = join(directory, "sync.db");
  const firstDatabase = new Database(filename, { create: true });
  const secondDatabase = new Database(filename, { create: true });
  try {
    firstDatabase.run("PRAGMA journal_mode = WAL");
    secondDatabase.run("PRAGMA journal_mode = WAL");
    migrateSqliteSync(firstDatabase);
    const firstAdapter = sqliteSyncAdapter({ database: firstDatabase, namespace: "shared" });
    const secondAdapter = sqliteSyncAdapter({ database: secondDatabase, namespace: "shared" });
    const mutation = await firstAdapter.beginMutation({
      fingerprint: "body",
      key: "create-card",
      principal: "user",
    });
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }

    expect(
      await secondAdapter.beginMutation({
        fingerprint: "body",
        key: "create-card",
        principal: "user",
      })
    ).toEqual({ kind: "conflict", reason: "in-progress" });
    await firstAdapter.abortMutation(mutation.lease);
    expect(
      await secondAdapter.beginMutation({
        fingerprint: "body",
        key: "create-card",
        principal: "user",
      })
    ).toMatchObject({ kind: "execute" });
  } finally {
    secondDatabase.close();
    firstDatabase.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("renews a live lease and rejects it after the renewed deadline", async () => {
  setSystemTime(new Date(1000));
  const adapter = sqliteSyncAdapter({ database, namespace: "renew" });
  const mutation = await adapter.beginMutation({
    fingerprint: "body",
    key: "update-card",
    principal: "user",
  });
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }

  setSystemTime(new Date(1000 + mutation.lease.leaseMs - 1));
  expect(await adapter.renewMutation(mutation.lease)).toBe("renewed");
  setSystemTime(new Date(1000 + 2 * mutation.lease.leaseMs));
  expect(await adapter.renewMutation(mutation.lease)).toBe("lost");
});

test("requests a reset when retained history no longer covers the cursor", async () => {
  const adapter = sqliteSyncAdapter({ database, namespace: "retention" });
  for (let index = 0; index < 1001; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: cursor order is the behavior under test.
    const mutation = await adapter.beginMutation({
      fingerprint: `body-${index}`,
      key: `mutation-${index}`,
      principal: "user",
    });
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    await adapter.completeMutation({
      invalidations: [{ kind: "path", path: `/page-${index}`, type: "page" }],
      lease: mutation.lease,
      response: { body: new Uint8Array(), headers: [], status: 204 },
    });
  }

  expect(await adapter.readChanges({ after: "0", limit: 10 })).toMatchObject({
    changes: [],
    cursor: "1001",
    reset: true,
  });
});
