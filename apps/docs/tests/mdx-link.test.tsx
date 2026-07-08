import { describe, expect, test } from "bun:test";
import { RouterContext } from "@teyik0/furin/link";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MdxLink } from "../src/components/doc-page";

describe("MdxLink", () => {
  test("renders a native <a> for external URLs", () => {
    const html = renderToStaticMarkup(
      createElement(MdxLink, { href: "https://example.com" }, "External")
    );
    expect(html).toBe(
      '<a href="https://example.com" rel="noopener noreferrer" target="_blank">External</a>'
    );
  });

  test("renders a Furin <Link> for internal absolute paths", () => {
    const html = renderToStaticMarkup(createElement(MdxLink, { href: "/docs/routing" }, "Routing"));
    // Link during SSR renders as <a> with the href
    expect(html).toContain('href="/docs/routing"');
    expect(html).toContain('data-furin-link="true"');
    expect(html).toContain(">Routing</a>");
  });

  test("renders a native <a> for protocol-relative URLs", () => {
    const html = renderToStaticMarkup(
      createElement(MdxLink, { href: "//cdn.example.com/file.js" }, "CDN")
    );
    expect(html).toBe(
      '<a href="//cdn.example.com/file.js" rel="noopener noreferrer" target="_blank">CDN</a>'
    );
  });

  test("renders a native <a> for mailto links", () => {
    const html = renderToStaticMarkup(
      createElement(MdxLink, { href: "mailto:test@example.com" }, "Email")
    );
    expect(html).toBe(
      '<a href="mailto:test@example.com" rel="noopener noreferrer" target="_blank">Email</a>'
    );
  });

  test("renders a native <a> for tel links", () => {
    const html = renderToStaticMarkup(createElement(MdxLink, { href: "tel:+1234567890" }, "Call"));
    expect(html).toBe(
      '<a href="tel:+1234567890" rel="noopener noreferrer" target="_blank">Call</a>'
    );
  });

  test("does not override basePath computed by Link", () => {
    const html = renderToStaticMarkup(
      createElement(
        RouterContext.Provider,
        {
          value: {
            basePath: "/docs",
            currentHref: "/",
            defaultPreload: "intent",
            defaultPreloadDelay: 50,
            defaultPreloadStaleTime: 30_000,
            invalidatePrefetch: () => {
              /* noop */
            },
            isNavigating: false,
            navigate: () => Promise.resolve(),
            prefetch: () => {
              /* noop */
            },
            refresh: () => Promise.resolve(),
          },
        },
        createElement(MdxLink, { href: "/routing" }, "Routing")
      )
    );
    expect(html).toContain('href="/docs/routing"');
    expect(html).toContain('data-furin-link="true"');
    expect(html).toContain(">Routing</a>");
  });
});
