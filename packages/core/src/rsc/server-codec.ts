import { renderToReadableStream } from "react-server-dom-webpack/server.edge";
import type { FlightRenderSession } from "./flight-drain.ts";

export function renderFlight(model: unknown, signal: AbortSignal | undefined): FlightRenderSession {
  let firstRenderError: unknown;
  let renderErrorReported = false;
  const onError = (error: unknown): undefined => {
    if (!renderErrorReported) {
      firstRenderError = error;
      renderErrorReported = true;
    }
  };
  const stream = renderToReadableStream(
    model,
    {},
    {
      onError,
      ...(signal === undefined ? {} : { signal }),
    }
  );
  return {
    getRenderError: () => ({ error: firstRenderError, reported: renderErrorReported }),
    stream,
  };
}
