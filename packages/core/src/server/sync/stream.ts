import { Elysia } from "elysia";

export interface SyncInvalidationEvent {
  invalidations: readonly string[];
}

const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function publishSyncInvalidation(invalidations: readonly string[]): void {
  if (invalidations.length === 0 || clients.size === 0) {
    return;
  }

  const chunk = encodeSseEvent("furin.invalidate", {
    invalidations,
  } satisfies SyncInvalidationEvent);
  for (const client of [...clients]) {
    try {
      client.enqueue(chunk);
    } catch {
      clients.delete(client);
    }
  }
}

export function createSyncStreamPlugin(path?: string) {
  const streamPath = path ?? "/_furin/sync";
  return new Elysia({ name: `furin-sync-stream-${streamPath}` }).get(streamPath, ({ set }) => {
    set.headers["cache-control"] = "no-cache, no-transform";
    set.headers.connection = "keep-alive";
    set.headers["content-type"] = "text/event-stream; charset=utf-8";

    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        clients.add(controller);
        controller.enqueue(encoder.encode(": connected\n\n"));
      },
      cancel() {
        if (controllerRef) {
          clients.delete(controllerRef);
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
  for (const client of [...clients]) {
    try {
      client.close();
    } catch {
      // already closed
    }
  }
  clients.clear();
}
