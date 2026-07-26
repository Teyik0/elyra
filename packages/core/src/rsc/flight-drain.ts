import { createFurinRscRenderError, type RscRenderOperation } from "./render-error.ts";

const MAX_FLIGHT_BYTES = 4 * 1024 * 1024;

interface FlightRenderErrorState {
  error: unknown;
  reported: boolean;
}

export interface FlightRenderSession {
  getRenderError: () => FlightRenderErrorState;
  stream: ReadableStream<Uint8Array>;
}

async function readFlightBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: stream chunks must be read sequentially.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_FLIGHT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `[furin/rsc] Flight payload exceeds the ${MAX_FLIGHT_BYTES}-byte safety limit.`
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function drainFlight(
  session: FlightRenderSession,
  operation: RscRenderOperation
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await readFlightBytes(session.stream);
  } catch (streamError) {
    const renderError = session.getRenderError();
    if (renderError.reported) {
      throw createFurinRscRenderError(renderError.error, operation);
    }
    throw streamError;
  }
  const renderError = session.getRenderError();
  if (renderError.reported) {
    throw createFurinRscRenderError(renderError.error, operation);
  }
  return bytes;
}
