import { type Context, ElysiaCustomStatusResponse, StatusMap } from "elysia";
import type { StoredResponse } from "./adapter.ts";

const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);

function statusCode(status: Context["set"]["status"]): number {
  if (typeof status === "number") {
    return status;
  }
  return status === undefined ? 200 : StatusMap[status];
}

function unwrapStatusResponse(value: unknown): { status: number; value: unknown } | undefined {
  if (!(value instanceof ElysiaCustomStatusResponse)) {
    return;
  }
  return { status: value.code, value: value.response };
}

function responseHeaders(headers: Context["set"]["headers"]): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        result.append(name, String(entry));
      }
    }
  }
  return result;
}

export async function storeResponse(
  responseValue: unknown,
  set: Context["set"]
): Promise<StoredResponse> {
  if (responseValue instanceof Response) {
    const clone = responseValue.clone();
    const headers = [...clone.headers.entries()].filter(
      ([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())
    );
    return {
      body: new Uint8Array(await clone.arrayBuffer()),
      headers,
      status: clone.status,
    };
  }

  const headers = responseHeaders(set.headers);
  const statusResponse = unwrapStatusResponse(responseValue);
  const value = statusResponse?.value ?? responseValue;
  const responseStatus = statusResponse ? statusResponse.status : statusCode(set.status);
  let body: Uint8Array;
  if (value === undefined || value === null) {
    body = new Uint8Array();
  } else if (typeof value === "string") {
    headers.set("content-type", headers.get("content-type") ?? "text/plain;charset=utf-8");
    body = new TextEncoder().encode(value);
  } else {
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    body = new TextEncoder().encode(JSON.stringify(value));
  }
  return {
    body,
    headers: [...headers.entries()],
    status: responseStatus,
  };
}

export function replayResponse(stored: StoredResponse): Response {
  const body =
    stored.status === 204 || stored.status === 205 || stored.status === 304
      ? null
      : stored.body.slice();
  return new Response(body, {
    headers: new Headers(stored.headers.map(([name, value]) => [name, value] as [string, string])),
    status: stored.status,
  });
}
