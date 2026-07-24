import { AsyncLocalStorage } from "node:async_hooks";
import { appendDevtoolsEvent } from "./hub.ts";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface DevtoolsRequestContext {
  operationId: string | null;
  requestId: string;
}

const requestContext = new AsyncLocalStorage<DevtoolsRequestContext>();

export function currentDevtoolsRequest(): DevtoolsRequestContext | undefined {
  return requestContext.getStore();
}

export function runWithDevtoolsRequest<T>(request: Request, fn: () => T): T {
  const rawOperationId = request.headers.get("x-furin-devtools-operation-id");
  const context: DevtoolsRequestContext = {
    operationId:
      rawOperationId && OPERATION_ID_PATTERN.test(rawOperationId) ? rawOperationId : null,
    requestId: crypto.randomUUID(),
  };
  const startedAt = performance.now();
  const path = new URL(request.url).pathname;
  appendDevtoolsEvent({
    method: request.method,
    operationId: context.operationId,
    path,
    requestId: context.requestId,
    timestamp: Date.now(),
    type: "request.started",
  });

  return requestContext.run(context, () => {
    const result = fn();
    if (!(result instanceof Promise)) {
      appendFinished(result, context, path, startedAt);
      return result;
    }
    return result.then(
      (value) => {
        appendFinished(value, context, path, startedAt);
        return value;
      },
      (error: unknown) => {
        appendFinished(undefined, context, path, startedAt, 500);
        throw error;
      }
    ) as T;
  });
}

function appendFinished(
  value: unknown,
  context: DevtoolsRequestContext,
  path: string,
  startedAt: number,
  failedStatus?: number
): void {
  appendDevtoolsEvent({
    durationMs: performance.now() - startedAt,
    operationId: context.operationId,
    path,
    requestId: context.requestId,
    status: failedStatus ?? (value instanceof Response ? value.status : 200),
    timestamp: Date.now(),
    type: "request.finished",
  });
}
