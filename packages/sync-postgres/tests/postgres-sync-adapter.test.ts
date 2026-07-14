import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { testSyncAdapterConformance } from "../../core/tests/helpers/sync-adapter-conformance";
import { postgresSyncAdapter } from "../src";

const databaseUrl = process.env.FURIN_SYNC_POSTGRES_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;

describeWithPostgres("PostgresSyncAdapter", () => {
  const sql = new SQL(databaseUrl as string);
  const namespace = "postgres-conformance";
  const adapter = postgresSyncAdapter({ namespace, sql });

  beforeAll(async () => {
    const migration = await Bun.file(
      new URL("../migrations/0001_sync.sql", import.meta.url)
    ).text();
    await sql.unsafe(migration);
  });

  beforeEach(async () => {
    await sql`DELETE FROM furin_sync.changes WHERE namespace IN (${namespace}, 'other-namespace')`;
    await sql`DELETE FROM furin_sync.streams WHERE namespace IN (${namespace}, 'other-namespace')`;
    await sql`DELETE FROM furin_sync.mutations WHERE namespace IN (${namespace}, 'other-namespace')`;
  });

  afterAll(async () => {
    await sql.close();
  });

  testSyncAdapterConformance(() => adapter);

  test("atomically persists replay response and invalidations", async () => {
    const mutation = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(mutation.kind).toBe("execute");
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }

    const result = await adapter.completeMutation({
      invalidations: [{ kind: "path", path: "/projects", type: "page" }],
      lease: mutation.lease,
      response: {
        body: new TextEncoder().encode("created"),
        headers: [["content-type", "text/plain"]],
        status: 201,
      },
    });
    expect(result).toEqual({ cursor: "1", kind: "committed" });

    const replay = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(replay).toEqual({
      kind: "replay",
      response: {
        body: new TextEncoder().encode("created"),
        headers: [["content-type", "text/plain"]],
        status: 201,
      },
    });
    expect(await adapter.readChanges({ after: "0", limit: 10 })).toEqual({
      changes: [
        {
          cursor: "1",
          invalidations: [{ kind: "path", path: "/projects", type: "page" }],
        },
      ],
      cursor: "1",
      hasMore: false,
      reset: false,
    });
  });

  test("allows one owner and rejects a previous owner after lease takeover", async () => {
    const first = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    expect(
      await adapter.beginMutation({
        fingerprint: "fingerprint",
        key: "mutation",
        principal: "user",
      })
    ).toEqual({ kind: "conflict", reason: "in-progress" });

    await sql`
      UPDATE furin_sync.mutations
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE namespace = ${namespace}
    `;
    expect(
      await adapter.beginMutation({
        fingerprint: "other-fingerprint",
        key: "mutation",
        principal: "user",
      })
    ).toEqual({ kind: "conflict", reason: "payload-mismatch" });
    const replacement = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(replacement.kind).toBe("execute");
    expect(await adapter.renewMutation(first.lease)).toBe("lost");
    expect(
      await adapter.completeMutation({
        invalidations: [],
        lease: first.lease,
        response: { body: new Uint8Array(), headers: [], status: 204 },
      })
    ).toEqual({ kind: "lost" });
  });

  test("keeps namespaces isolated", async () => {
    const other = postgresSyncAdapter({ namespace: "other-namespace", sql });
    const mutation = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(mutation.kind).toBe("execute");
    expect(await other.currentCursor()).toBe("0");
    expect(
      await other.beginMutation({
        fingerprint: "fingerprint",
        key: "mutation",
        principal: "user",
      })
    ).toMatchObject({ kind: "execute" });
  });

  test("orders concurrent completions from separate replicas", async () => {
    const replica = postgresSyncAdapter({ namespace, sql });
    const reservations = await Promise.all([
      adapter.beginMutation({ fingerprint: "one", key: "one", principal: "user" }),
      replica.beginMutation({ fingerprint: "two", key: "two", principal: "user" }),
    ]);
    const [first, second] = reservations;
    if (first?.kind !== "execute" || second?.kind !== "execute") {
      throw new Error("Expected two executable mutations");
    }
    const completed = await Promise.all([
      adapter.completeMutation({
        invalidations: [{ kind: "path", path: "/one", type: "page" }],
        lease: first.lease,
        response: { body: new Uint8Array(), headers: [], status: 204 },
      }),
      replica.completeMutation({
        invalidations: [{ kind: "path", path: "/two", type: "page" }],
        lease: second.lease,
        response: { body: new Uint8Array(), headers: [], status: 204 },
      }),
    ]);
    expect(
      completed.flatMap((result) => (result.kind === "committed" ? [result.cursor] : [])).sort()
    ).toEqual(["1", "2"]);
    expect((await adapter.readChanges({ after: "0", limit: 10 })).changes).toHaveLength(2);
  });
});
