import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildDataEndpoint, detectStaticMode } from "../../src/router-provider";

describe("buildDataEndpoint — runtime mode (SSR/ISR/dev)", () => {
  test("uses /_furin/data?path= with the percent-encoded logical href", () => {
    expect(buildDataEndpoint("", "/blog/post", false)).toBe("/_furin/data?path=%2Fblog%2Fpost");
  });

  test("preserves the basePath prefix", () => {
    expect(buildDataEndpoint("/furin", "/docs/routing", false)).toBe(
      "/furin/_furin/data?path=%2Fdocs%2Frouting"
    );
  });

  test("encodes query strings inside the path argument", () => {
    // The runtime endpoint executes the loader with the requested query, so
    // we must round-trip search params via the `?path=` argument.
    expect(buildDataEndpoint("", "/search?q=foo bar", false)).toBe(
      "/_furin/data?path=%2Fsearch%3Fq%3Dfoo%20bar"
    );
  });
});

describe("buildDataEndpoint — static mode", () => {
  test("appends /__furin_data.ndjson to the logical pathname", () => {
    // The static export pre-writes one NDJSON file per route at this exact
    // path — see `buildStaticTarget` and `pathToOutputFile`.
    expect(buildDataEndpoint("", "/blog/post", true)).toBe("/blog/post/__furin_data.ndjson");
  });

  test("preserves the basePath prefix", () => {
    expect(buildDataEndpoint("/furin", "/docs/routing", true)).toBe(
      "/furin/docs/routing/__furin_data.ndjson"
    );
  });

  test("collapses the root path so `/` does not produce a double slash", () => {
    expect(buildDataEndpoint("", "/", true)).toBe("/__furin_data.ndjson");
    expect(buildDataEndpoint("/furin", "/", true)).toBe("/furin/__furin_data.ndjson");
  });

  test("strips trailing slashes from the pathname", () => {
    expect(buildDataEndpoint("", "/blog/post/", true)).toBe("/blog/post/__furin_data.ndjson");
  });

  test("ignores query strings — static loaders are frozen at build time", () => {
    // In static mode the NDJSON is one-per-route, computed once at build. A
    // query string cannot change the payload, so we deliberately drop it
    // rather than hit a non-existent file.
    expect(buildDataEndpoint("", "/search?q=foo", true)).toBe("/search/__furin_data.ndjson");
  });
});

describe("detectStaticMode", () => {
  let originalMeta: HTMLMetaElement | null;

  beforeEach(() => {
    originalMeta = document.querySelector<HTMLMetaElement>('meta[name="furin-mode"]');
    originalMeta?.remove();
  });

  afterEach(() => {
    document.querySelector<HTMLMetaElement>('meta[name="furin-mode"]')?.remove();
    if (originalMeta) {
      document.head.appendChild(originalMeta);
    }
  });

  test("returns false when no furin-mode meta tag is present (SSR/dev shell)", () => {
    expect(detectStaticMode()).toBe(false);
  });

  test('returns true when <meta name="furin-mode" content="static"> is present', () => {
    const meta = document.createElement("meta");
    meta.name = "furin-mode";
    meta.content = "static";
    document.head.appendChild(meta);

    expect(detectStaticMode()).toBe(true);
  });

  test("returns false for an unknown content value", () => {
    // Defensive: any non-`static` value falls through to runtime-endpoint
    // behaviour, which is the safer default for misconfigured shells.
    const meta = document.createElement("meta");
    meta.name = "furin-mode";
    meta.content = "edge";
    document.head.appendChild(meta);

    expect(detectStaticMode()).toBe(false);
  });
});
