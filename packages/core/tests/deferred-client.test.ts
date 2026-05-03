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

    const result = await parseDeferredNdjson(stream);

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
    const result = await parseDeferredNdjson(ndjsonStream);

    // syncData contient les scalaires
    expect(result.syncData.title).toBe("board");
    // deferredPromises contient une Promise pour "stats"
    expect(result.deferredPromises.stats).toBeInstanceOf(Promise);
    const resolvedStats = await result.deferredPromises.stats;
    expect(resolvedStats).toBe(99);
  });

  test("les Promises dans deferredPromises sont disponibles immédiatement (avant résolution NDJSON)", async () => {
    // Vérifie que parseDeferredNdjson retourne avant que les lignes de résolution arrivent.
    // La structure de données est disponible dès le premier chunk.
    const slowStream = toCrossJSONStream({
      title: "hello",
      data: new Promise((r) => setTimeout(() => r("slow"), 50)),
    });

    const linesFromStream: string[] = [];
    const reader = slowStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      linesFromStream.push(value);
    }

    const ndjsonStream = makeNdjsonStream(linesFromStream);
    const result = await parseDeferredNdjson(ndjsonStream);

    // La Promise doit exister dans le résultat
    expect(result.deferredPromises.data).toBeInstanceOf(Promise);
    // Et se résoudre correctement
    const val = await result.deferredPromises.data;
    expect(val).toBe("slow");
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
