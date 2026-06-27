import { type AfterHandler, Elysia } from "elysia";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "../auto-invalidate/runtime.ts";
import type { InvalidationInput } from "../auto-invalidate/types.ts";
import { publishSyncInvalidation } from "./stream.ts";

export type SyncInput =
  | InvalidationInput
  | {
      invalidate: InvalidationInput;
    };

type AnyHandlerContext = Parameters<AfterHandler>[0];
interface IdempotencyContext {
  headers: {
    "idempotency-key"?: string | undefined;
  };
  request: Request;
}

function invalidationInputFromSync(input: SyncInput): InvalidationInput {
  if (input && typeof input === "object" && "invalidate" in input) {
    return input.invalidate;
  }
  return input;
}

function isMutationMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function getIdempotencyKey(ctx: IdempotencyContext): string | undefined {
  const fromCtxHeaders = ctx.headers["idempotency-key"];
  if (typeof fromCtxHeaders === "string" && fromCtxHeaders.length > 0) {
    return fromCtxHeaders;
  }
  const fromRequest = ctx.request.headers.get("Idempotency-Key");
  return fromRequest || undefined;
}

export function furinSync() {
  const idempotencyKeys = new Set<string>();
  const requestKeys = new WeakMap<Request, string>();
  return new Elysia({ name: "furin-sync" }).macro({
    sync(input: SyncInput) {
      const invalidate = invalidationInputFromSync(input);
      return {
        beforeHandle(ctx) {
          if (!isMutationMethod(ctx.request.method)) {
            return;
          }
          const key = getIdempotencyKey(ctx);
          if (!key) {
            return new Response("Missing Idempotency-Key header", {
              status: 428,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          const requestKey = `${ctx.request.method}:${new URL(ctx.request.url).pathname}:${key}`;
          if (idempotencyKeys.has(requestKey)) {
            return new Response("Duplicate Idempotency-Key header", {
              status: 409,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          idempotencyKeys.add(requestKey);
          requestKeys.set(ctx.request, requestKey);
          if (idempotencyKeys.size > 1000) {
            const oldest = idempotencyKeys.values().next().value;
            if (typeof oldest === "string") {
              idempotencyKeys.delete(oldest);
            }
          }
        },
        afterHandle(ctx: AnyHandlerContext) {
          if (!isSuccessfulMutationResponse(ctx)) {
            const requestKey = requestKeys.get(ctx.request);
            if (requestKey) {
              idempotencyKeys.delete(requestKey);
              requestKeys.delete(ctx.request);
            }
            return;
          }
          requestKeys.delete(ctx.request);

          runInvalidationRules(invalidate);
          const pending = appendPendingInvalidationHeader(ctx.set);
          if (pending.length === 0) {
            return;
          }

          ctx.set.headers["x-furin-sync"] = "1";
          publishSyncInvalidation(pending);
        },
        error({ request }) {
          const requestKey = requestKeys.get(request);
          if (requestKey) {
            idempotencyKeys.delete(requestKey);
            requestKeys.delete(request);
          }
        },
      };
    },
  });
}
