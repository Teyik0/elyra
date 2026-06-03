import { type AfterHandler, Elysia } from "elysia";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "./runtime.ts";
import type { InvalidationInput } from "./types.ts";

type AnyAfterHandleContext = Parameters<AfterHandler>[0];

export function furinInvalidate() {
  return new Elysia({ name: "furin-invalidate" }).macro({
    invalidate(rules: InvalidationInput) {
      return {
        afterHandle(ctx: AnyAfterHandleContext) {
          if (!isSuccessfulMutationResponse(ctx)) {
            return;
          }
          runInvalidationRules(rules);
          appendPendingInvalidationHeader(ctx.set);
        },
      };
    },
  });
}
