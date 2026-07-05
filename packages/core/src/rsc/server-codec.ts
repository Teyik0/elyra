import { renderToReadableStream } from "react-server-dom-webpack/server.edge";

export function renderFlight(
  model: unknown,
  signal: AbortSignal | undefined
): ReadableStream<Uint8Array> {
  return renderToReadableStream(model, {}, signal === undefined ? undefined : { signal });
}
