import { Elysia } from "elysia";
import type { SyncAdapter, SyncChange, SyncRuntimeOptions, SyncSubscription } from "./adapter.ts";
import { memorySyncAdapter } from "./memory-adapter.ts";
import { memorySyncNotifier } from "./notifier.ts";
import { resolveSyncRuntime } from "./runtime.ts";

export type { ChangePage as SyncChangePage, SyncChange } from "./adapter.ts";

const DEFAULT_CHANGE_LIMIT = 100;
const MAX_CHANGE_LIMIT = 500;
const MAX_CURSOR_LENGTH = 128;
const SAFETY_POLL_INTERVAL_MS = 15_000;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const defaultStreamPath = "/_furin/sync";
const encoder = new TextEncoder();

interface StreamState {
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  cursor: string | undefined;
  heartbeats: Set<ReturnType<typeof setInterval>>;
  safetyPoll: ReturnType<typeof setInterval>;
  subscription: SyncSubscription;
}

const streams = new Map<SyncAdapter, Promise<StreamState>>();
const resolvedStates = new Set<StreamState>();

function encodeSseCursor(cursor: string): Uint8Array {
  return encoder.encode(
    `id: ${cursor}\nevent: furin.sync\nretry: 3000\ndata: ${JSON.stringify({ cursor })}\n\n`
  );
}

function notifyState(state: StreamState, cursor: string): void {
  if (state.cursor === cursor) {
    return;
  }
  state.cursor = cursor;
  const chunk = encodeSseCursor(cursor);
  for (const client of [...state.clients]) {
    try {
      client.enqueue(chunk);
    } catch {
      state.clients.delete(client);
    }
  }
}

async function createStreamState(options: SyncRuntimeOptions): Promise<StreamState> {
  const runtime = resolveSyncRuntime(options);
  const state = {} as StreamState;
  state.clients = new Set();
  state.cursor = await runtime.adapter.currentCursor();
  state.heartbeats = new Set();
  state.subscription = await runtime.notifier.subscribe((cursor) => notifyState(state, cursor));
  state.safetyPoll = setInterval(() => {
    runtime.adapter
      .currentCursor()
      .then((cursor) => notifyState(state, cursor))
      .catch(() => undefined);
  }, SAFETY_POLL_INTERVAL_MS);
  resolvedStates.add(state);
  return state;
}

function getStreamState(options: SyncRuntimeOptions): Promise<StreamState> {
  const existing = streams.get(options.adapter);
  if (existing) {
    return existing;
  }
  const state = createStreamState(options);
  streams.set(options.adapter, state);
  return state;
}

function parseChangeQuery(
  request: Request
): { after: string | undefined; limit: number } | { error: Response } {
  const url = new URL(request.url);
  const after = url.searchParams.get("after") ?? undefined;
  if (after !== undefined && (after.length === 0 || after.length > MAX_CURSOR_LENGTH)) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_CURSOR" }, { status: 400 }) };
  }
  const limitValue = url.searchParams.get("limit");
  if (limitValue !== null && !UNSIGNED_INTEGER_PATTERN.test(limitValue)) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_LIMIT" }, { status: 400 }) };
  }
  const limit = limitValue === null ? DEFAULT_CHANGE_LIMIT : Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGE_LIMIT) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_LIMIT" }, { status: 400 }) };
  }
  return { after, limit };
}

function clientInvalidations(change: SyncChange): string[] {
  const entries = new Set<string>();
  for (const invalidation of change.invalidations) {
    if (invalidation.kind === "tags") {
      entries.add("/:layout");
    } else {
      entries.add(
        invalidation.type === "layout" ? `${invalidation.path}:layout` : invalidation.path
      );
    }
  }
  return [...entries];
}

export function createSyncStreamPlugin(
  path?: string,
  runtimeOptions?: SyncRuntimeOptions | string
) {
  const streamPath = path ?? defaultStreamPath;
  const runtime = resolveSyncRuntime(
    typeof runtimeOptions === "string" ? undefined : runtimeOptions
  );
  return new Elysia({ name: `furin-sync-stream-${streamPath}` })
    .get(`${streamPath}/changes`, async ({ request, set }) => {
      set.headers["cache-control"] = "no-store";
      const query = parseChangeQuery(request);
      if ("error" in query) {
        return query.error;
      }
      const page = await runtime.adapter.readChanges(query);
      return {
        ...page,
        changes: page.changes.map((change) => ({
          cursor: change.cursor,
          invalidations: clientInvalidations(change),
        })),
      };
    })
    .get(streamPath, async () => {
      const state = await getStreamState(runtime);
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          if (controllerRef) {
            state.clients.delete(controllerRef);
          }
          if (heartbeat) {
            clearInterval(heartbeat);
            state.heartbeats.delete(heartbeat);
          }
        },
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
  for (const state of resolvedStates) {
    state.subscription.unsubscribe().catch(() => undefined);
    clearInterval(state.safetyPoll);
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
  resolvedStates.clear();
  memorySyncAdapter.reset();
  memorySyncNotifier.reset();
}
