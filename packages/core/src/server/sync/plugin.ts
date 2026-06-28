import { Elysia } from "elysia";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "../auto-invalidate/runtime.ts";
import type { InvalidationInput } from "../auto-invalidate/types.ts";
import { getSyncStreamPath } from "./config.ts";
import { createMutationFingerprint } from "./fingerprint.ts";
import { memorySyncAdapter } from "./memory-adapter.ts";
import { replayResponse, storeResponse } from "./response.ts";

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

async function getPrincipalScope(request: Request): Promise<string> {
  const authorization = request.headers.get("authorization");
  const credentials = authorization
    ? JSON.stringify(["authorization", authorization])
    : JSON.stringify(["cookie", request.headers.get("cookie") ?? ""]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credentials));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
      status: 409,
      headers: inProgress ? { "retry-after": "1" } : undefined,
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
      status: 428,
      headers: { "content-type": "text/plain; charset=utf-8" },
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
  const principal = await getPrincipalScope(ctx.request);
  const key = `${ctx.request.method}:${url.pathname}:${idempotencyKey}`;
  const fingerprint = await createMutationFingerprint({ body: ctx.body, request: ctx.request });
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
        await memorySyncAdapter.appendChanges({
          invalidations: pending,
          path: getSyncStreamPath() ?? "/_furin/sync",
        });
      }
    })
    .onError({ as: "global" }, ({ request }) => abortMutation(request));
}
