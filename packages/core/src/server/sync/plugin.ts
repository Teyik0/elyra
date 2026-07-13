import { Elysia } from "elysia";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "../auto-invalidate/runtime.ts";
import type { InvalidationInput } from "../auto-invalidate/types.ts";
import { createMutationFingerprint, sha256Hex } from "./fingerprint.ts";
import { memorySyncAdapter } from "./memory-adapter.ts";
import { replayResponse, storeResponse } from "./response.ts";
import { publishSyncInvalidation } from "./stream.ts";

export type SyncRouteOption =
  | false
  | InvalidationInput
  | {
      invalidate: InvalidationInput;
    };

/** @deprecated Use SyncRouteOption. */
export type SyncInput = Exclude<SyncRouteOption, false>;

interface RouteSyncMetadata {
  disabled: boolean;
  invalidate?: InvalidationInput;
}

interface ActiveMutation {
  mutationId: string;
}

interface MutationContext {
  body?: unknown;
  headers: {
    "idempotency-key"?: string | undefined;
  };
  request: Request;
}

const routeMetadata = new WeakMap<Request, RouteSyncMetadata>();
const activeMutations = new WeakMap<Request, ActiveMutation>();

function invalidationInputFromSync(input: Exclude<SyncRouteOption, false>): InvalidationInput {
  if (input && typeof input === "object" && "invalidate" in input) {
    return input.invalidate;
  }
  return input;
}

function isMutationMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function getIdempotencyKey(ctx: MutationContext): string | undefined {
  const fromCtxHeaders = ctx.headers["idempotency-key"];
  if (typeof fromCtxHeaders === "string" && fromCtxHeaders.length > 0) {
    return fromCtxHeaders;
  }
  const fromRequest = ctx.request.headers.get("Idempotency-Key");
  return fromRequest || undefined;
}

function getPrincipalScope(request: Request): string {
  const authorization = request.headers.get("authorization");
  const credentials = authorization
    ? JSON.stringify(["authorization", authorization])
    : JSON.stringify(["cookie", request.headers.get("cookie") ?? ""]);
  return sha256Hex(credentials);
}

function supportsReplayBody(request: Request): boolean {
  const contentType = request.headers.get("content-type")?.toLowerCase();
  const mediaType = contentType?.split(";", 1)[0]?.trim();
  return (
    contentType === undefined ||
    mediaType === "application/json" ||
    (mediaType?.startsWith("application/") === true && mediaType.endsWith("+json")) ||
    contentType.startsWith("application/x-www-form-urlencoded") ||
    contentType.startsWith("text/")
  );
}

function conflictResponse(reason: "in-progress" | "payload-mismatch"): Response {
  const inProgress = reason === "in-progress";
  return Response.json(
    {
      code: inProgress ? "FURIN_MUTATION_IN_PROGRESS" : "FURIN_IDEMPOTENCY_MISMATCH",
      message: inProgress
        ? "A mutation with this Idempotency-Key is still running."
        : "The Idempotency-Key was already used with a different request.",
    },
    {
      headers: inProgress ? { "retry-after": "1" } : undefined,
      status: 409,
    }
  );
}

async function beginMutation(ctx: MutationContext): Promise<Response | undefined> {
  if (!isMutationMethod(ctx.request.method) || routeMetadata.get(ctx.request)?.disabled) {
    return;
  }
  const idempotencyKey = getIdempotencyKey(ctx);
  if (!idempotencyKey) {
    return new Response("Missing Idempotency-Key header", {
      headers: { "content-type": "text/plain; charset=utf-8" },
      status: 428,
    });
  }
  if (!supportsReplayBody(ctx.request)) {
    return Response.json(
      {
        code: "FURIN_UNSUPPORTED_SYNC_BODY",
        message: "This request body cannot be replayed. Set sync: false on the route.",
      },
      { status: 415 }
    );
  }

  const url = new URL(ctx.request.url);
  const principal = getPrincipalScope(ctx.request);
  const key = `${ctx.request.method}:${url.pathname}:${idempotencyKey}`;
  const fingerprint = createMutationFingerprint({ body: ctx.body, request: ctx.request });
  const result = await memorySyncAdapter.beginMutation({ fingerprint, key, principal });
  if (result.kind === "replay") {
    return replayResponse(result.response);
  }
  if (result.kind === "conflict") {
    return conflictResponse(result.reason);
  }
  if (result.kind === "unavailable") {
    return Response.json(
      {
        code: "FURIN_SYNC_CAPACITY_EXCEEDED",
        message: "The mutation replay store is temporarily full.",
      },
      { headers: { "retry-after": "1" }, status: 503 }
    );
  }
  activeMutations.set(ctx.request, { mutationId: result.mutationId });
}

async function abortMutation(request: Request): Promise<void> {
  const active = activeMutations.get(request);
  if (!active) {
    return;
  }
  activeMutations.delete(request);
  await memorySyncAdapter.abortMutation(active);
}

export function furinSync() {
  return new Elysia({ name: "furin-sync" })
    .macro({
      sync(input: SyncRouteOption) {
        return {
          transform({ request }) {
            routeMetadata.set(
              request,
              input === false
                ? { disabled: true }
                : { disabled: false, invalidate: invalidationInputFromSync(input) }
            );
          },
        };
      },
    })
    .onBeforeHandle({ as: "global" }, beginMutation)
    .onAfterHandle({ as: "global" }, async (ctx) => {
      const active = activeMutations.get(ctx.request);
      if (!active) {
        return;
      }
      if (!isSuccessfulMutationResponse(ctx)) {
        await abortMutation(ctx.request);
        return;
      }

      const invalidate = routeMetadata.get(ctx.request)?.invalidate;
      if (invalidate) {
        runInvalidationRules(invalidate);
      }
      const pending = appendPendingInvalidationHeader(ctx.set);
      if (pending.length > 0) {
        ctx.set.headers["x-furin-sync"] = "1";
      }
      const response = await storeResponse(ctx.responseValue, ctx.set);
      await memorySyncAdapter.commitMutation({ ...active, response });
      activeMutations.delete(ctx.request);

      if (pending.length > 0) {
        // Notify every mounted app's sync stream — a mutation on a shared API
        // may invalidate pages rendered by any of them.
        publishSyncInvalidation(pending);
      }
    })
    .onError({ as: "global" }, ({ request }) => abortMutation(request));
}
