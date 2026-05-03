import type { SerovalNode } from "seroval";
import { fromCrossJSON } from "seroval";

/**
 * Result returned by `parseDeferredNdjson`.
 */
export interface DeferredNdjsonResult {
  /**
   * Deferred promises keyed by their field name. Each Promise resolves (or
   * rejects) once the corresponding data is available. In the SSR case the
   * promises are already settled (serialised by `toCrossJSONAsync`). For
   * streaming endpoints they will settle as the server flushes resolution
   * chunks.
   */
  deferredPromises: Record<string, Promise<unknown>>;
  /** Scalar/sync values from the loader — available immediately. */
  syncData: Record<string, unknown>;
}

/**
 * Parses an NDJSON stream produced by `/_furin/data`.
 *
 * Protocol (v1 — single-line, all-resolved):
 *   Line 0 — `JSON.stringify(await toCrossJSONAsync(loaderData))`
 *
 * The CrossJSON node is deserialised with `fromCrossJSON`. Values that are
 * Promises (seroval type 12) land in `deferredPromises`; everything else
 * lands in `syncData`.
 *
 * @param stream - A `ReadableStream<Uint8Array>` from `fetch().body`.
 */
export async function parseDeferredNdjson(
  stream: ReadableStream<Uint8Array>
): Promise<DeferredNdjsonResult> {
  // ── 1. Read entire stream as text ──────────────────────────────────────────
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  // ── 2. Split into NDJSON lines ────────────────────────────────────────────
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { syncData: {}, deferredPromises: {} };
  }

  // ── 3. Line 0 — CrossJSON skeleton ────────────────────────────────────────
  // lines.length > 0 is guaranteed by the guard above — the non-null assertion is safe.
  // biome-ignore lint/style/noNonNullAssertion: guarded by `if (lines.length === 0)` above
  const node = JSON.parse(lines[0]!) as SerovalNode;
  const deserialized = fromCrossJSON(node, {}) as Record<string, unknown>;

  // ── 4. Split sync vs deferred by instanceof Promise ───────────────────────
  const syncData: Record<string, unknown> = {};
  const deferredPromises: Record<string, Promise<unknown>> = {};

  for (const [key, value] of Object.entries(deserialized)) {
    if (value instanceof Promise) {
      deferredPromises[key] = value;
    } else {
      syncData[key] = value;
    }
  }

  return { syncData, deferredPromises };
}
