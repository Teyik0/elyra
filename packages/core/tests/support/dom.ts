import { afterEach, beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";

interface RenderedDom {
  cleanup: () => void;
  container: HTMLDivElement;
  root: Root;
}

interface WaitForDomOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

interface NativeWebApis {
  fetch: typeof globalThis.fetch;
  Headers: typeof globalThis.Headers;
  ReadableStream: typeof globalThis.ReadableStream;
  Request: typeof globalThis.Request;
  Response: typeof globalThis.Response;
  TransformStream: typeof globalThis.TransformStream;
  WritableStream: typeof globalThis.WritableStream;
}

let registered = false;
let nativeWebApis: NativeWebApis | undefined;

type WindowOpen = (url?: string | URL, target?: string, features?: string) => Window | null;

function snapshotNativeWebApis(): NativeWebApis {
  return {
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    ReadableStream: globalThis.ReadableStream,
    Request: globalThis.Request,
    Response: globalThis.Response,
    TransformStream: globalThis.TransformStream,
    WritableStream: globalThis.WritableStream,
  };
}

function restoreNativeWebApis(): void {
  if (nativeWebApis === undefined) {
    return;
  }
  globalThis.fetch = nativeWebApis.fetch;
  globalThis.Headers = nativeWebApis.Headers;
  globalThis.ReadableStream = nativeWebApis.ReadableStream;
  globalThis.Request = nativeWebApis.Request;
  globalThis.Response = nativeWebApis.Response;
  globalThis.TransformStream = nativeWebApis.TransformStream;
  globalThis.WritableStream = nativeWebApis.WritableStream;
}

function patchSyntaxError(): void {
  (globalThis as unknown as Window & { SyntaxError?: typeof SyntaxError }).SyntaxError =
    SyntaxError;
  const docWithView = globalThis.document as Document & {
    defaultView?: Window & { SyntaxError?: typeof SyntaxError };
  };
  if (docWithView.defaultView && !docWithView.defaultView.SyntaxError) {
    docWithView.defaultView.SyntaxError = SyntaxError;
  }
}

function ensureWindowShims(): void {
  const windowWithOpen = window as Window & { open?: WindowOpen };
  if (typeof windowWithOpen.open === "undefined") {
    windowWithOpen.open = () => null;
  }
}

export function installDom(): void {
  if (registered) {
    return;
  }
  nativeWebApis = snapshotNativeWebApis();
  GlobalRegistrator.register({
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
    },
    url: "http://localhost:3000/",
  });
  restoreNativeWebApis();
  patchSyntaxError();
  ensureWindowShims();
  registered = true;
}

export async function uninstallDom(): Promise<void> {
  if (!registered) {
    return;
  }
  await Promise.resolve();
  await Bun.sleep(0);
  await GlobalRegistrator.unregister();
  restoreNativeWebApis();
  registered = false;
}

export function resetDomState(): void {
  if (!registered) {
    installDom();
  }
  document.documentElement.innerHTML = "<head></head><body></body>";
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
  ensureWindowShims();
}

export function useDomTests(): void {
  beforeEach(() => {
    installDom();
    resetDomState();
  });

  afterEach(async () => {
    document.body.replaceChildren();
    document.head.replaceChildren();
    await uninstallDom();
  });
}

export function renderDom(element: ReactElement): RenderedDom {
  const { flushSync } = require("react-dom") as typeof import("react-dom");
  const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  flushSync(() => {
    root.render(element);
  });

  return {
    cleanup: () => {
      flushSync(() => {
        root.unmount();
      });
      container.remove();
    },
    container,
    root,
  };
}

export function waitForDom(
  predicate: () => boolean,
  options: WaitForDomOptions | undefined
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 2000;
  const intervalMs = options?.intervalMs ?? 10;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitForDom timed out"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}
