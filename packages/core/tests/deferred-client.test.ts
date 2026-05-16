import { describe, expect, test } from "bun:test";
import { toCrossJSON, toCrossJSONAsync } from "seroval";
import { parseDeferredNdjson } from "../src/deferred-ndjson";

// ── parseDeferredNdjson tests ────────────────────────────────────────────────
//
// parseDeferredNdjson(stream: ReadableStream<Uint8Array>):
//   Promise<{ syncData: Record<string, unknown>; deferredPromises: Record<string, Promise<unknown>> }>
//
// Comportement:
// - Ligne 0 : squelette CrossJSON — contient syncData + placeholders pour les Promises
// - Lignes suivantes : résolutions des Promises déférées (CrossJSON)
//
// On simule le format émis par toCrossJSONStream({ syncField: "x", stats: Promise.resolve(42) })

function makeNdjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(enc.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

describe("parseDeferredNdjson()", () => {
  test("parse un stream NDJSON avec seulement des données synchrones", async () => {
    // Simule toCrossJSONStream({ title: "hello" }) → 1 ligne (pas de Promises)
    const syncValue = { title: "hello", count: 42 };
    const crossJson = toCrossJSON(syncValue);
    const stream = makeNdjsonStream([JSON.stringify(crossJson)]);

    const result = await parseDeferredNdjson(stream, undefined);

    expect(result.syncData).toEqual({ title: "hello", count: 42 });
    expect(Object.keys(result.deferredPromises)).toHaveLength(0);
  });

  test("parse un stream NDJSON avec une Promise déférée", async () => {
    // Simule toCrossJSONStream({ title: "board", stats: Promise.resolve(99) })
    const statsPromise = Promise.resolve(99);
    const ndjsonLines: string[] = [];
    const stream = toCrossJSONStream({ title: "board", stats: statsPromise });
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      ndjsonLines.push(value);
    }

    const ndjsonStream = makeNdjsonStream(ndjsonLines);
    const result = await parseDeferredNdjson(ndjsonStream, undefined);

    // syncData contient les scalaires
    expect(result.syncData.title).toBe("board");
    // deferredPromises contient une Promise pour "stats"
    expect(result.deferredPromises.stats).toBeInstanceOf(Promise);
    const resolvedStats = await result.deferredPromises.stats;
    expect(resolvedStats).toBe(99);
  });

  test("retourne dès la ligne initiale et résout les Promises avec les lignes suivantes", async () => {
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const parsePromise = parseDeferredNdjson(stream, undefined);
    controller.enqueue(
      enc.encode(
        `${JSON.stringify(toCrossJSON({ title: "hello", __furinDeferredKeys: ["data"] }))}\n`
      )
    );

    const result = await parsePromise;
    expect(result.syncData).toEqual({ title: "hello" });
    const dataPromise = result.deferredPromises.data;
    expect(dataPromise).toBeInstanceOf(Promise);
    if (!dataPromise) {
      throw new Error("Expected deferred data Promise");
    }

    let settled = false;
    dataPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    controller.enqueue(
      enc.encode(
        `${JSON.stringify({ key: "data", action: "resolve", value: toCrossJSON("slow") })}\n`
      )
    );
    controller.close();

    expect(await dataPromise).toBe("slow");
  });
});

// Helper — wraps toCrossJSONAsync into a single-line NDJSON ReadableStream
function toCrossJSONStream(value: unknown): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      try {
        const result = await toCrossJSONAsync(value as Record<string, unknown>);
        controller.enqueue(JSON.stringify(result));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
