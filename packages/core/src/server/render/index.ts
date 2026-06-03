// biome-ignore-all lint/performance/noBarrelFile: intentional barrel for public API

export { type LoaderContext, streamToString } from "./assemble.ts";
export { buildElement } from "./element.tsx";
export { handleISR } from "./isr.ts";
export { type LoaderResult, runLoaders, serializeDeferredRejection } from "./loaders.ts";
export { renderRootNotFound } from "./not-found.ts";

export { prerenderSSG, warmSSGCache } from "./ssg.ts";
export {
  assertDeferredModeAllowed,
  type PreparedRender,
  prepareRender,
  type RenderResult,
  renderForPath,
  renderSSR,
  renderToHTML,
  renderToStream,
  serializeLoaderDataNdjson,
  splitBeforeBodyClose,
  withSSRRouterContext,
} from "./ssr.ts";
