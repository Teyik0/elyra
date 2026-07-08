import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom overrides some native Web APIs with incomplete polyfills.
// Save the real Bun implementations so we can restore them after registration.
const nativeFetch = globalThis.fetch;
const nativeHeaders = globalThis.Headers;
const nativeRequest = globalThis.Request;
const nativeResponse = globalThis.Response;
const nativeTransformStream = globalThis.TransformStream;
const nativeReadableStream = globalThis.ReadableStream;
const nativeWritableStream = globalThis.WritableStream;

// Disable external resource loading: tests don't serve CSS/JS, and happy-dom
// 20.9.0 has a bug where the CSSParser asks for `this.window.SyntaxError`
// after a frame navigation — that property exists on `globalThis` (where we
// patch it below) but not on the freshly recreated detached frame's window,
// so any background <link rel="stylesheet"> parsing tips the test over with
// "undefined is not a constructor". Disabling the loaders makes the failure
// path unreachable.
GlobalRegistrator.register({
  settings: {
    disableCSSFileLoading: true,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
  },
  url: "http://localhost:3000/",
});

// happy-dom@20.9.0 omits window.SyntaxError, breaking CSS selector parsing
// inside its querySelector engine. Must be set AFTER register() because
// GlobalRegistrator replaces globalThis with its own window object.
function patchSyntaxError(): void {
  (globalThis as Window & { SyntaxError?: typeof SyntaxError }).SyntaxError = SyntaxError;
  const win = globalThis as Window & { SyntaxError?: typeof SyntaxError };
  if (!win.SyntaxError) {
    win.SyntaxError = SyntaxError;
  }
  const docWithView = globalThis.document as Document & {
    defaultView?: Window & { SyntaxError?: typeof SyntaxError };
  };
  if (docWithView.defaultView && !docWithView.defaultView.SyntaxError) {
    docWithView.defaultView.SyntaxError = SyntaxError;
  }
}

patchSyntaxError();

// Ensure window.open / window.history exist with the minimal API surface the
// tests rely on — happy-dom sometimes omits them in isolated scopes, and
// assigning `window.location.href` recreates `window`, dropping any shims that
// were attached to the previous instance. Idempotent: only fills gaps.
function ensureWindowShims(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (typeof window.open === "undefined") {
    (window as Window & { open: typeof window.open }).open = () => null;
  }
  if (typeof window.history === "undefined") {
    (window as Window & { history: History }).history = {
      back: () => {
        /* noop */
      },
      forward: () => {
        /* noop */
      },
      go: () => {
        /* noop */
      },
      length: 1,
      pushState: () => {
        /* noop */
      },
      replaceState: () => {
        /* noop */
      },
      scrollRestoration: "auto",
      state: null,
    } as History;
  }
}

ensureWindowShims();

// Restore native Web APIs — happy-dom's polyfills break Bun's server-side
// fetch (Parse Error on local URLs), TransformStream (no getWriter), and
// Response (Bun.serve doesn't recognise happy-dom's Response instances).
if (nativeFetch) {
  globalThis.fetch = nativeFetch;
}
if (nativeHeaders) {
  globalThis.Headers = nativeHeaders;
}
if (nativeRequest) {
  globalThis.Request = nativeRequest;
}
if (nativeResponse) {
  globalThis.Response = nativeResponse;
}
if (nativeTransformStream) {
  globalThis.TransformStream = nativeTransformStream;
}
if (nativeReadableStream) {
  globalThis.ReadableStream = nativeReadableStream;
}
if (nativeWritableStream) {
  globalThis.WritableStream = nativeWritableStream;
}
