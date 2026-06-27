import { Elysia } from "elysia";
import { getSyncStreamPath } from "./config.ts";

export interface SyncInvalidationEvent {
  invalidations: readonly string[];
}

const encoder = new TextEncoder();
const defaultStreamPath = "/_furin/sync";
interface StreamState {
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  heartbeats: Set<ReturnType<typeof setInterval>>;
  history: Array<{ chunk: Uint8Array; id: number }>;
  nextEventId: number;
}

const streams = new Map<string, StreamState>();

function getStreamState(path: string): StreamState {
  const existing = streams.get(path);
  if (existing) {
    return existing;
  }
  const state: StreamState = {
    clients: new Set(),
    heartbeats: new Set(),
    history: [],
    nextEventId: 1,
  };
  streams.set(path, state);
  return state;
}

function encodeSseEvent(id: number, event: string, data: unknown): Uint8Array {
  return encoder.encode(
    `id: ${id}\nevent: ${event}\nretry: 3000\ndata: ${JSON.stringify(data)}\n\n`
  );
}

export function publishSyncInvalidation(invalidations: readonly string[]): void {
  if (invalidations.length === 0) {
    return;
  }

  const state = getStreamState(getSyncStreamPath() ?? defaultStreamPath);
  const id = state.nextEventId++;
  const chunk = encodeSseEvent(id, "furin.invalidate", {
    invalidations,
  } satisfies SyncInvalidationEvent);
  state.history.push({ chunk, id });
  if (state.history.length > 100) {
    state.history.shift();
  }
  for (const client of [...state.clients]) {
    try {
      client.enqueue(chunk);
    } catch {
      state.clients.delete(client);
    }
  }
}

export function createSyncStreamPlugin(path?: string) {
  const streamPath = path ?? defaultStreamPath;
  return new Elysia({ name: `furin-sync-stream-${streamPath}` }).get(streamPath, ({ request }) => {
    const state = getStreamState(streamPath);
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        state.clients.add(controller);
        const lastEventId = Number.parseInt(request.headers.get("Last-Event-ID") ?? "", 10);
        const oldestEventId = state.history[0]?.id;
        const hasReplayGap =
          !Number.isNaN(lastEventId) &&
          oldestEventId !== undefined &&
          lastEventId < oldestEventId - 1;
        const replay = Number.isNaN(lastEventId)
          ? []
          : state.history.filter((entry) => entry.id > lastEventId);
        if (hasReplayGap) {
          controller.enqueue(
            encodeSseEvent(state.nextEventId - 1, "furin.invalidate", {
              invalidations: ["/:layout"],
            } satisfies SyncInvalidationEvent)
          );
        } else if (replay.length > 0) {
          for (const entry of replay) {
            controller.enqueue(entry.chunk);
          }
        } else {
          controller.enqueue(encoder.encode(": connected\nretry: 3000\n\n"));
        }
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

/** @internal — resets process-local stream subscribers between tests. */
export function __resetSyncState(): void {
  for (const state of streams.values()) {
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
}
