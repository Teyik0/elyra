import { afterEach, beforeEach } from "bun:test";
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
    disableJavaScriptFileLoading: true,
    disableJavaScriptEvaluation: true,
  },
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

// Ensure window.open exists — happy-dom sometimes omits it in isolated scopes.
if (typeof window.open === "undefined") {
  (window as Window & { open: typeof window.open }).open = () => null;
}

// Ensure window.history exists with the minimal API surface tests rely on.
if (typeof window.history === "undefined") {
  (window as Window & { history: History }).history = {
    length: 1,
    scrollRestoration: "auto",
    state: null,
    back: () => {
      /* noop */
    },
    forward: () => {
      /* noop */
    },
    go: () => {
      /* noop */
    },
    pushState: () => {
      /* noop */
    },
    replaceState: () => {
      /* noop */
    },
  } as History;
}

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

beforeEach(() => {
  // Re-apply SyntaxError patch before every test — bun --isolate may reset
  // the global scope between test files, stripping the happy-dom patch.
  patchSyntaxError();

  // Re-ensure window APIs exist in case --isolate created a fresh scope.
  if (typeof window !== "undefined" && typeof window.open === "undefined") {
    (window as Window & { open: typeof window.open }).open = () => null;
  }
  if (typeof window !== "undefined" && typeof window.history === "undefined") {
    (window as Window & { history: History }).history = {
      length: 1,
      scrollRestoration: "auto",
      state: null,
      back: () => {
        /* noop */
      },
      forward: () => {
        /* noop */
      },
      go: () => {
        /* noop */
      },
      pushState: () => {
        /* noop */
      },
      replaceState: () => {
        /* noop */
      },
    } as History;
  }

  // Ensure a valid origin for every test. happy-dom defaults to about:blank
  // with a null origin, which breaks isInternal() in <Link> and any code
  // that resolves relative URLs against window.location. We only navigate
  // when needed — assigning to `location.href` recreates `window` and any
  // patches we put on it (SyntaxError, etc.) would be wiped.
  if (
    typeof window !== "undefined" &&
    typeof window.location !== "undefined" &&
    window.location.href !== "http://localhost:3000/"
  ) {
    window.location.href = "http://localhost:3000/";
  }

  // Re-apply the SyntaxError patch *after* the potential nav: assigning to
  // `location.href` makes happy-dom navigate the detached frame, which
  // recreates `window` (and `document.defaultView`) without the patched
  // SyntaxError. Without this second pass, any test that subsequently parses
  // CSS / a selector hits "undefined is not a constructor" inside happy-dom's
  // SelectorParser — flakiness depending on test ordering and microtasks.
  patchSyntaxError();
});

afterEach(() => {
  // Reset location to a safe default so cross-test pathname pollution
  // (e.g. hash-only navigation tests that mutate window.location) does
  // not bleed into the next test. Only navigate when the URL actually
  // changed, to avoid happy-dom recreating `window` for nothing.
  if (window.location.href !== "http://localhost:3000/") {
    window.location.href = "http://localhost:3000/";
  }
  // Re-apply the patch in case the test (or happy-dom microtasks fired
  // during it) swapped the window object.
  patchSyntaxError();
});
