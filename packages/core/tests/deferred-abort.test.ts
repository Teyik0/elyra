import { describe, expect, test } from "bun:test";
import { toCrossJSON } from "seroval";
import { parseDeferredNdjson } from "../src/deferred-ndjson";

const enc = new TextEncoder();

function ndjsonLine(obj: unknown): Uint8Array {
  return enc.encode(`${JSON.stringify(obj)}\n`);
}

interface ControlledStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  stream: ReadableStream<Uint8Array>;
}

function makeControlledStream(initialBytes: Uint8Array): ControlledStream {
  let captured: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      captured = c;
      c.enqueue(initialBytes);
    },
  });
  if (!captured) {
    throw new Error("controller not captured");
  }
  return { stream, controller: captured };
}

describe("parseDeferredNdjson — error paths", () => {
  test("première ligne NDJSON malformée → rejette avec une erreur explicite", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("{not valid json}\n"));
        c.close();
      },
    });

    await expect(parseDeferredNdjson(stream, undefined)).rejects.toThrow();
  });

  test("ligne de résolution NDJSON malformée → la promise correspondante rejette, les autres ne fuient pas", async () => {
    const initial = ndjsonLine(toCrossJSON({ title: "x", __furinDeferredKeys: ["a"] }));
    const { stream, controller } = makeControlledStream(initial);

    const result = await parseDeferredNdjson(stream, undefined);
    const pA = result.deferredPromises.a as Promise<unknown>;

    controller.enqueue(enc.encode("not-valid-json\n"));
    controller.close();

    const err = await pA.then(() => null).catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect(err).toBeInstanceOf(SyntaxError);
  });

  test("stream coupé au milieu (done avant tous les chunks) → resolvers restants rejettent", async () => {
    const initial = ndjsonLine(toCrossJSON({ title: "x", __furinDeferredKeys: ["a", "b"] }));
    const { stream, controller } = makeControlledStream(initial);

    const result = await parseDeferredNdjson(stream, undefined);
    const pA = result.deferredPromises.a as Promise<unknown>;
    const pB = result.deferredPromises.b as Promise<unknown>;

    // Resolve "a", then close the stream without "b".
    controller.enqueue(ndjsonLine({ key: "a", action: "resolve", value: toCrossJSON(1) }));
    controller.close();

    expect(await pA).toBe(1);

    // "b" never arrives. With the current implementation, the resolver is
    // dropped by readDeferredLines (it returns on empty line) without an
    // error — so the promise stays pending forever. Surface this as a
    // dedicated rejection so consumers don't hang.
    const errB = await Promise.race([
      pB.then(() => "resolved" as const).catch((e: unknown) => e),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(errB).not.toBe("pending");
    expect(errB).not.toBe("resolved");
  });
});

describe("parseDeferredNdjson — AbortSignal", () => {
  test("signal qui s'abort pendant l'attente → promises pendantes rejettent avec AbortError", async () => {
    const initial = ndjsonLine(toCrossJSON({ title: "x", __furinDeferredKeys: ["a", "b"] }));
    const { stream } = makeControlledStream(initial);

    const abort = new AbortController();
    const result = await parseDeferredNdjson(stream, abort.signal);

    const pA = result.deferredPromises.a as Promise<unknown>;
    const pB = result.deferredPromises.b as Promise<unknown>;
    expect(pA).toBeInstanceOf(Promise);
    expect(pB).toBeInstanceOf(Promise);

    abort.abort();

    const errA = await pA.then(() => null).catch((e: unknown) => e);
    const errB = await pB.then(() => null).catch((e: unknown) => e);

    expect(errA).toBeDefined();
    expect(errB).toBeDefined();
    expect((errA as { name?: string }).name).toBe("AbortError");
    expect((errB as { name?: string }).name).toBe("AbortError");
  });

  test("signal déjà aborted avant l'appel → promises pendantes rejettent immédiatement", async () => {
    const initial = ndjsonLine(toCrossJSON({ title: "x", __furinDeferredKeys: ["a"] }));
    const { stream } = makeControlledStream(initial);

    const abort = new AbortController();
    abort.abort();

    const result = await parseDeferredNdjson(stream, abort.signal);
    const pA = result.deferredPromises.a as Promise<unknown>;
    expect(pA).toBeInstanceOf(Promise);

    const err = await pA.then(() => null).catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect((err as { name?: string }).name).toBe("AbortError");
  });

  test("signal undefined → fonctionne comme avant, promises résolues par chunks", async () => {
    const initial = ndjsonLine(toCrossJSON({ title: "x", __furinDeferredKeys: ["a"] }));
    const { stream, controller } = makeControlledStream(initial);

    const result = await parseDeferredNdjson(stream, undefined);
    const pA = result.deferredPromises.a as Promise<unknown>;

    controller.enqueue(ndjsonLine({ key: "a", action: "resolve", value: toCrossJSON(42) }));
    controller.close();

    expect(await pA).toBe(42);
  });

  test("chunks arrivés avant abort sont préservés, seuls les pending rejettent", async () => {
    const initial = ndjsonLine(toCrossJSON({ title: "x", __furinDeferredKeys: ["a", "b"] }));
    const { stream, controller } = makeControlledStream(initial);

    const abort = new AbortController();
    const result = await parseDeferredNdjson(stream, abort.signal);
    const pA = result.deferredPromises.a as Promise<unknown>;
    const pB = result.deferredPromises.b as Promise<unknown>;

    // Resolve "a" before abort.
    controller.enqueue(ndjsonLine({ key: "a", action: "resolve", value: toCrossJSON("done") }));

    // Give the parser a microtask to consume "a".
    await new Promise((r) => setTimeout(r, 5));

    abort.abort();

    expect(await pA).toBe("done");
    const errB = await pB.then(() => null).catch((e: unknown) => e);
    expect((errB as { name?: string }).name).toBe("AbortError");
  });
});
