import { createFromReadableStream } from "react-server-dom-webpack/client.edge";

export function decodeFlight(stream: ReadableStream<Uint8Array>): Promise<unknown> {
  return createFromReadableStream(stream, {
    serverConsumerManifest: {
      moduleLoading: null,
      moduleMap: {},
      serverModuleMap: {},
    },
  });
}
