import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { evlogSetMock, resetEvlogMock } from "../../setup/evlog-mock";

const { furin } = await import("../../../src/furin");
const { __clearInstanceRegistry } = await import("../../../src/server/instance");
const { __setDevMode } = await import("../../../src/server/runtime-env");

const fixturesDir = join(import.meta.dir, "../../fixtures/pages/default");

afterEach(() => {
  __clearInstanceRegistry();
  resetEvlogMock();
});

test.serial("browser log ingest is not mounted unless clientLogging is enabled", async () => {
  __setDevMode(true);

  const app = await furin({ clientLogging: false, pagesDir: fixturesDir });
  const res = await app.handle(
    new Request("http://localhost/_furin/ingest", {
      body: "[]",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  expect(res.status).toBe(404);
});

test.serial("browser log ingest accepts browser events when enabled", async () => {
  __setDevMode(true);

  const app = await furin({ clientLogging: true, pagesDir: fixturesDir });
  const res = await app.handle(
    new Request("http://localhost/_furin/ingest", {
      body: JSON.stringify([{ event: { msg: "browser log" } }]),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  expect(res.status).toBe(204);
  expect(evlogSetMock).toHaveBeenCalledWith({ msg: "browser log", service: "furin:browser" });
});

test.serial("browser log ingest rejects oversized batches", async () => {
  __setDevMode(true);

  const body = JSON.stringify([{ event: { msg: "x".repeat(65_536) } }]);
  const app = await furin({ clientLogging: true, pagesDir: fixturesDir });
  const res = await app.handle(
    new Request("http://localhost/_furin/ingest", {
      body,
      headers: {
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "content-type": "application/json",
      },
      method: "POST",
    })
  );

  expect(res.status).toBe(413);
});
