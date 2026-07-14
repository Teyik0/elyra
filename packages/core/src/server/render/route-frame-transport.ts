import { toCrossJSON } from "seroval";
import {
  serializeRouteFrame,
  serializeRouteFrames,
  serializeRouteFrameValue,
} from "../../shared/route-frame.ts";
import { serializeDeferredRejection } from "./loaders.ts";

export async function serializeDeferredRouteFrame(
  key: string,
  promise: Promise<unknown>,
  idPrefix: string
): Promise<string> {
  try {
    const { rscFrames, value } = serializeRouteFrameValue(await promise, idPrefix);
    return (
      serializeRouteFrame({
        key,
        type: "defer-resolve",
        value,
      }) + rscFrames
    );
  } catch (error) {
    return serializeRouteFrame({
      key,
      type: "defer-reject",
      value: toCrossJSON(await serializeDeferredRejection(error)),
    });
  }
}

export function createDeferredRouteFrameStream(
  syncData: Record<string, unknown>,
  deferredPromises: Record<string, Promise<unknown>>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(
        encoder.encode(serializeRouteFrames(syncData, Object.keys(deferredPromises)))
      );
      await Promise.all(
        Object.entries(deferredPromises).map(async ([key, promise], index) => {
          controller.enqueue(
            encoder.encode(await serializeDeferredRouteFrame(key, promise, `defer-${index}`))
          );
        })
      );
      controller.close();
    },
  });
}
