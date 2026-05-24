import type { Context } from "elysia";
import { consumePendingInvalidations, revalidatePath } from "../render/cache.ts";
import { autoInvalidateRegistry } from "./registry.ts";
import type { InvalidationInput, InvalidationRule } from "./types.ts";

const SUCCESS_STATUS_FALLBACK = 200;

function toRules(input: InvalidationInput): readonly InvalidationRule[] {
  return Array.isArray(input) ? input : [input as InvalidationRule];
}

function statusFromResponseValue(responseValue: unknown): number | undefined {
  if (responseValue instanceof Response) {
    return responseValue.status;
  }
  if (responseValue && typeof responseValue === "object" && "status" in responseValue) {
    const status = (responseValue as { status?: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  if (responseValue && typeof responseValue === "object" && "code" in responseValue) {
    const code = (responseValue as { code?: unknown }).code;
    if (typeof code === "number") {
      return code;
    }
  }
  return;
}

export function isSuccessfulMutationResponse(
  ctx: Pick<Context, "set"> & {
    responseValue?: unknown;
    response?: unknown;
  }
): boolean {
  const status =
    statusFromResponseValue(ctx.responseValue) ??
    statusFromResponseValue(ctx.response) ??
    (typeof ctx.set.status === "number" ? ctx.set.status : SUCCESS_STATUS_FALLBACK);
  return status >= 200 && status < 400;
}

export function appendPendingInvalidationHeader(set: Context["set"]): void {
  const pending = consumePendingInvalidations();
  if (pending.length === 0) {
    return;
  }

  const headerName = "x-furin-revalidate";
  const existing = set.headers[headerName];
  set.headers[headerName] =
    typeof existing === "string" && existing.length > 0
      ? `${existing},${pending.join(",")}`
      : pending.join(",");
}

export function revalidateTag(tags: string | readonly string[]): boolean {
  const tagList = typeof tags === "string" ? [tags] : [...tags];
  let deleted = false;
  for (const path of autoInvalidateRegistry.pathsForTags(tagList)) {
    deleted = revalidatePath(path, "page") || deleted;
  }
  return deleted;
}

export function runInvalidationRules(input: InvalidationInput): boolean {
  let deleted = false;
  for (const rule of toRules(input)) {
    if ("path" in rule && rule.path) {
      deleted = revalidatePath(rule.path, rule.type) || deleted;
    }
    if (rule.tags && rule.tags.length > 0) {
      deleted = revalidateTag(rule.tags) || deleted;
    }
  }
  return deleted;
}
