import type { ReactNode } from "react";
import { resume } from "react-dom/server.edge";
import type { PostponedState } from "react-dom/static";
import { prerender } from "react-dom/static.edge";

export interface PprCacheEntry {
  buildId: string;
  postponedState: unknown;
  publicRouteStream: Uint8Array;
  shell: Uint8Array;
  status: number;
}

export interface PrerenderPprOptions {
  abortAfterMs: number;
  buildId: string;
  publicRouteStream: Uint8Array;
  status: number;
}

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function prerenderPpr(
  element: ReactNode,
  options: PrerenderPprOptions
): Promise<PprCacheEntry> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("furin-ppr-shell-ready"), options.abortAfterMs);
  try {
    const result = await prerender(element, {
      signal: controller.signal,
      onError(error) {
        if (!controller.signal.aborted) {
          throw error;
        }
      },
    });
    if (result.postponed === null) {
      throw new Error(
        "[furin] requestLoader requires an explicit Suspense boundary that remains pending during public prerender."
      );
    }
    return {
      buildId: options.buildId,
      postponedState: result.postponed,
      publicRouteStream: options.publicRouteStream.slice(),
      shell: await readBytes(result.prelude),
      status: options.status,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function resumePpr(
  element: ReactNode,
  postponedState: unknown,
  signal: AbortSignal | undefined
): Promise<Uint8Array> {
  const stream = await resume(
    element,
    postponedState as PostponedState,
    signal === undefined ? undefined : { signal }
  );
  return readBytes(stream);
}
