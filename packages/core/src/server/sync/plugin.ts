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

function hasIdempotencyKey(ctx: IdempotencyContext): boolean {
  const fromCtxHeaders = ctx.headers["idempotency-key"];
  if (typeof fromCtxHeaders === "string" && fromCtxHeaders.length > 0) {
    return true;
  }
  const fromRequest = ctx.request.headers.get("Idempotency-Key");
  return Boolean(fromRequest);
}

export function furinSync() {
  return new Elysia({ name: "furin-sync" }).macro({
    sync(input: SyncInput) {
      const invalidate = invalidationInputFromSync(input);
      return {
        beforeHandle(ctx) {
          if (!isMutationMethod(ctx.request.method) || hasIdempotencyKey(ctx)) {
            return;
          }
          return new Response("Missing Idempotency-Key header", {
            status: 428,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        },
        afterHandle(ctx: AnyHandlerContext) {
          if (!isSuccessfulMutationResponse(ctx)) {
            return;
          }

          runInvalidationRules(invalidate);
          const pending = appendPendingInvalidationHeader(ctx.set);
          if (pending.length === 0) {
            return;
          }

          ctx.set.headers["x-furin-sync"] = "1";
          publishSyncInvalidation(pending);
        },
      };
    },
  });
}
