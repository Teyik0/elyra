import { Elysia } from "elysia";
import type { SyncChange } from "./adapter.ts";
import { getSyncStreamPath } from "./config.ts";
import { memorySyncAdapter } from "./memory-adapter.ts";

export type { ChangePage as SyncChangePage, SyncChange } from "./adapter.ts";

const DEFAULT_CHANGE_LIMIT = 100;
const MAX_CHANGE_LIMIT = 500;
const CURSOR_PATTERN = /^\d+$/;
const defaultStreamPath = "/_furin/sync";
const encoder = new TextEncoder();

interface StreamState {
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  heartbeats: Set<ReturnType<typeof setInterval>>;
  unsubscribe: (() => void) | undefined;
}

const streams = new Map<string, StreamState>();

function encodeSseChange(change: SyncChange): Uint8Array {
  return encoder.encode(
    `id: ${change.cursor}\nevent: furin.sync\nretry: 3000\ndata: ${JSON.stringify({ cursor: change.cursor })}\n\n`
  );
}

function getStreamState(path: string): StreamState {
  const existing = streams.get(path);
  if (existing) {
    return existing;
  }
  const state: StreamState = {
    clients: new Set(),
    heartbeats: new Set(),
    unsubscribe: undefined,
  };
  state.unsubscribe = memorySyncAdapter.subscribe(path, (change) => {
    const chunk = encodeSseChange(change);
    for (const client of [...state.clients]) {
      try {
        client.enqueue(chunk);
      } catch {
        state.clients.delete(client);
      }
    }
  });
  streams.set(path, state);
  return state;
}

function parseChangeQuery(
  request: Request
): { after: string | undefined; limit: number } | { error: Response } {
  const url = new URL(request.url);
  const after = url.searchParams.get("after") ?? undefined;
  if (after !== undefined && !CURSOR_PATTERN.test(after)) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_CURSOR" }, { status: 400 }) };
  }
  const limitValue = url.searchParams.get("limit");
  if (limitValue !== null && !CURSOR_PATTERN.test(limitValue)) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_LIMIT" }, { status: 400 }) };
  }
  const limit = limitValue === null ? DEFAULT_CHANGE_LIMIT : Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGE_LIMIT) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_LIMIT" }, { status: 400 }) };
  }
  return { after, limit };
}

export function publishSyncInvalidation(invalidations: readonly string[]): void {
  if (invalidations.length === 0) {
    return;
  }
  memorySyncAdapter.appendChanges({
    invalidations,
    path: getSyncStreamPath() ?? defaultStreamPath,
  });
}

export function createSyncStreamPlugin(path?: string) {
  const streamPath = path ?? defaultStreamPath;
  return new Elysia({ name: `furin-sync-stream-${streamPath}` })
    .get(`${streamPath}/changes`, ({ request }) => {
      const query = parseChangeQuery(request);
      if ("error" in query) {
        return query.error;
      }
      return memorySyncAdapter.readChanges({ ...query, path: streamPath });
    })
    .get(streamPath, () => {
      const state = getStreamState(streamPath);
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          state.clients.add(controller);
          controller.enqueue(encoder.encode(": connected\nretry: 3000\n\n"));
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              state.clients.delete(controller);
              if (heartbeat) {
                clearInterval(heartbeat);
                state.heartbeats.delete(heartbeat);
              }
            }
          }, 15_000);
          state.heartbeats.add(heartbeat);
        },
        cancel() {
          if (controllerRef) {
            state.clients.delete(controllerRef);
          }
          if (heartbeat) {
            clearInterval(heartbeat);
            state.heartbeats.delete(heartbeat);
          }
        },
      });

      return new Response(stream, {
        headers: {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    });
}

/** @internal — resets process-local sync state between tests. */
export function __resetSyncState(): void {
  for (const state of streams.values()) {
    state.unsubscribe?.();
    for (const heartbeat of state.heartbeats) {
      clearInterval(heartbeat);
    }
    for (const client of state.clients) {
      try {
        client.close();
      } catch {
        // already closed
      }
    }
  }
  streams.clear();
  memorySyncAdapter.reset();
}
