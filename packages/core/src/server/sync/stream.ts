import { Elysia } from "elysia";

export interface SyncInvalidationEvent {
  invalidations: readonly string[];
}

const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const history: Array<{ chunk: Uint8Array; id: number }> = [];
let nextEventId = 1;

function encodeSseEvent(id: number, event: string, data: unknown): Uint8Array {
  return encoder.encode(
    `id: ${id}\nevent: ${event}\nretry: 3000\ndata: ${JSON.stringify(data)}\n\n`
  );
}

export function publishSyncInvalidation(invalidations: readonly string[]): void {
  if (invalidations.length === 0) {
    return;
  }

  const id = nextEventId++;
  const chunk = encodeSseEvent(id, "furin.invalidate", {
    invalidations,
  } satisfies SyncInvalidationEvent);
  history.push({ chunk, id });
  if (history.length > 100) {
    history.shift();
  }
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
  return new Elysia({ name: `furin-sync-stream-${streamPath}` }).get(streamPath, ({ request }) => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        clients.add(controller);
        const lastEventId = Number.parseInt(request.headers.get("Last-Event-ID") ?? "", 10);
        const replay = Number.isNaN(lastEventId)
          ? []
          : history.filter((entry) => entry.id > lastEventId);
        if (replay.length > 0) {
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
            clients.delete(controller);
            if (heartbeat) {
              clearInterval(heartbeat);
            }
          }
        }, 15_000);
      },
      cancel() {
        if (controllerRef) {
          clients.delete(controllerRef);
        }
        if (heartbeat) {
          clearInterval(heartbeat);
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
  history.length = 0;
  nextEventId = 1;
}
