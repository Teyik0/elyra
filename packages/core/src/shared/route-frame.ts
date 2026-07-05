import type { SerovalNode } from "seroval";
import { fromCrossJSON, toCrossJSON } from "seroval";
import {
  getRscSourceState,
  isRscSource,
  type RscSourceKind,
  restoreRscSource,
} from "../rsc/shared.tsx";

const FRAME_VERSION = 2;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const RSC_DESCRIPTOR = "__furinRsc";

interface RouteFrameEnvelope {
  __furinRouteFrame: typeof FRAME_VERSION;
  frame: RouteFrame;
}

export type RouteFrame =
  | { type: "data"; value: SerovalNode }
  | { type: "defer-resolve"; key: string; value: SerovalNode }
  | { type: "defer-reject"; key: string; value: SerovalNode }
  | { type: "rsc-start"; id: string; kind: RscSourceKind }
  | { type: "rsc-chunk"; id: string; value: string }
  | { type: "rsc-end"; id: string }
  | { type: "rsc-error"; id: string; digest: string };

interface CollectedRscSource {
  bytes: Uint8Array;
  id: string;
  kind: RscSourceKind;
}

interface RscDescriptor {
  __furinRsc: string;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function extractRscSources(
  value: unknown,
  sources: CollectedRscSource[],
  seen: WeakMap<object, unknown>
): unknown {
  if (isRscSource(value)) {
    const state = getRscSourceState(value);
    if (state === undefined) {
      return value;
    }
    const id = `rsc-${sources.length}`;
    sources.push({ id, kind: state.kind, bytes: state.bytes });
    return { [RSC_DESCRIPTOR]: id } satisfies RscDescriptor;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const previous = seen.get(value);
  if (previous !== undefined) {
    return previous;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const entry of value) {
      result.push(extractRscSources(entry, sources, seen));
    }
    return result;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: { [key: string]: unknown } = {};
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) {
    result[key] = extractRscSources(entry, sources, seen);
  }
  return result;
}

function bytesToFrameValues(bytes: Uint8Array): string[] {
  let text: string | undefined;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    const chunks: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(offset + 64 * 1024, text.length);
      const lastCodeUnit = text.charCodeAt(end - 1);
      if (lastCodeUnit >= 0xd8_00 && lastCodeUnit <= 0xdb_ff) {
        end -= 1;
      }
      chunks.push(`utf8:${text.slice(offset, end)}`);
      offset = end;
    }
    return chunks.length > 0 ? chunks : ["utf8:"];
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 48 * 1024) {
    let binary = "";
    for (const byte of bytes.subarray(offset, offset + 48 * 1024)) {
      binary += String.fromCharCode(byte);
    }
    chunks.push(`base64:${btoa(binary)}`);
  }
  return chunks.length > 0 ? chunks : ["base64:"];
}

function frameValueToBytes(value: string): Uint8Array {
  if (value.startsWith("utf8:")) {
    return new TextEncoder().encode(value.slice(5));
  }
  if (!value.startsWith("base64:")) {
    throw new Error("[furin] malformed RSC route frame encoding");
  }
  const binary = atob(value.slice(7));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeFrame(frame: RouteFrame): string {
  const envelope: RouteFrameEnvelope = { __furinRouteFrame: FRAME_VERSION, frame };
  const line = JSON.stringify(envelope);
  if (new TextEncoder().encode(line).byteLength > MAX_FRAME_BYTES) {
    throw new Error(`[furin] route frame exceeds the ${MAX_FRAME_BYTES}-byte limit`);
  }
  return `${line}\n`;
}

export function serializeRouteFrame(frame: RouteFrame): string {
  return encodeFrame(frame);
}

export function serializeRouteFrames(data: object): string {
  const sources: CollectedRscSource[] = [];
  const serializable = extractRscSources(data, sources, new WeakMap());
  const lines = [encodeFrame({ type: "data", value: toCrossJSON(serializable) })];
  for (const source of sources) {
    lines.push(encodeFrame({ type: "rsc-start", id: source.id, kind: source.kind }));
    for (const value of bytesToFrameValues(source.bytes)) {
      lines.push(encodeFrame({ type: "rsc-chunk", id: source.id, value }));
    }
    lines.push(encodeFrame({ type: "rsc-end", id: source.id }));
  }
  const payload = lines.join("");
  if (new TextEncoder().encode(payload).byteLength > MAX_STREAM_BYTES) {
    throw new Error(`[furin] route frame stream exceeds the ${MAX_STREAM_BYTES}-byte limit`);
  }
  return payload;
}

export function isRouteFrameLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { __furinRouteFrame?: unknown };
    return parsed.__furinRouteFrame === FRAME_VERSION;
  } catch {
    return false;
  }
}

function hydrateRscDescriptors(value: unknown, sources: Map<string, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (isPlainObject(value) && typeof (value as { __furinRsc?: unknown }).__furinRsc === "string") {
    const id = (value as RscDescriptor).__furinRsc;
    const source = sources.get(id);
    if (source === undefined) {
      throw new Error(`[furin] RSC route frame "${id}" is missing`);
    }
    return source;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => hydrateRscDescriptors(entry, sources));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  for (const [key, entry] of Object.entries(value)) {
    Reflect.set(value, key, hydrateRscDescriptors(entry, sources));
  }
  return value;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one bounded state machine validates every versioned frame variant
export async function parseRouteFrameLines(
  firstLine: string,
  readLine: () => Promise<string | undefined>
): Promise<{
  deferredPromises: { [key: string]: Promise<unknown> };
  syncData: { [key: string]: unknown };
}> {
  const lines = [firstLine];
  for (;;) {
    const line = await readLine();
    if (line === undefined) {
      break;
    }
    lines.push(line);
  }
  const byteLength = new TextEncoder().encode(lines.join("\n")).byteLength;
  if (byteLength > MAX_STREAM_BYTES) {
    throw new Error(`[furin] route frame stream exceeds the ${MAX_STREAM_BYTES}-byte limit`);
  }

  let dataNode: SerovalNode | undefined;
  const pending = new Map<string, { chunks: Uint8Array[]; kind: RscSourceKind }>();
  const sources = new Map<string, unknown>();
  const deferredPromises: { [key: string]: Promise<unknown> } = {};

  for (const line of lines) {
    const envelope = JSON.parse(line) as RouteFrameEnvelope;
    if (envelope.__furinRouteFrame !== FRAME_VERSION) {
      throw new Error("[furin] unsupported route frame version");
    }
    const frame = envelope.frame;
    if (frame.type === "data") {
      dataNode = frame.value;
    } else if (frame.type === "rsc-start") {
      pending.set(frame.id, { chunks: [], kind: frame.kind });
    } else if (frame.type === "rsc-chunk") {
      const source = pending.get(frame.id);
      if (source === undefined) {
        throw new Error(`[furin] RSC chunk received before start for "${frame.id}"`);
      }
      source.chunks.push(frameValueToBytes(frame.value));
    } else if (frame.type === "rsc-end") {
      const source = pending.get(frame.id);
      if (source === undefined) {
        throw new Error(`[furin] RSC end received before start for "${frame.id}"`);
      }
      const length = source.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of source.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      sources.set(frame.id, restoreRscSource(source.kind, bytes));
      pending.delete(frame.id);
    } else if (frame.type === "rsc-error") {
      throw new Error(`[furin] RSC stream failed (${frame.digest})`);
    } else if (frame.type === "defer-resolve") {
      deferredPromises[frame.key] = Promise.resolve(fromCrossJSON(frame.value, {}));
    } else if (frame.type === "defer-reject") {
      const rejected = Promise.reject(fromCrossJSON(frame.value, {}));
      rejected.catch(() => undefined);
      deferredPromises[frame.key] = rejected;
    }
  }

  if (dataNode === undefined) {
    throw new Error("[furin] route frame stream has no data frame");
  }
  if (pending.size > 0) {
    throw new Error("[furin] route frame stream ended before an RSC source completed");
  }
  const data = hydrateRscDescriptors(fromCrossJSON(dataNode, {}), sources);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("[furin] route data frame must decode to an object");
  }
  return { syncData: data as { [key: string]: unknown }, deferredPromises };
}
