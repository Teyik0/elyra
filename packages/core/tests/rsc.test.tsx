import { expect, test } from "bun:test";

const TESTS_DIR_SUFFIX_RE = /\/tests$/;

test("RSC public API scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { Elysia } from "elysia";
import { CompositeComponent, createCompositeComponent, renderServerComponent } from "furin/rsc";
import { renderToReadableStream } from "react-dom/server";
import { createRoute, defer } from "./src/client.ts";
import { serializeLoaderDataNdjson } from "./src/server/render/ssr.ts";
import { createDataEndpoint, createRoutePlugin } from "./src/server/router/plugin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { parseDeferredNdjson } from "./src/shared/deferred-ndjson.ts";
import { parseRouteFrameLines, serializeRouteFrames } from "./src/shared/route-frame.ts";

__setDevMode(false);

function createRscRoute() {
  const route = createRoute({
    loader: async () => ({ article: await renderServerComponent(<h1>Flight article</h1>) }),
  });
  const page = route.page({ component: ({ article }) => <main>{article}</main> });
  const resolved = {
    mode: "ssr",
    page,
    path: "/rsc.tsx",
    pattern: "/rsc",
    routeChain: [route],
    segmentBoundaries: [],
  };
  const root = {
    path: "/root.tsx",
    route: {
      __type: "FURIN_ROUTE",
      layout: ({ children }) => (
        <html lang="en">
          <body>{children}</body>
        </html>
      ),
    },
  };
  return { resolved, root };
}

let article = await renderServerComponent(<h1>Composite RSC</h1>);
let stream = await renderToReadableStream(<main>{article}</main>);
let html = await new Response(stream).text();
expect(html).toBe("<main><h1>Composite RSC</h1></main>");

article = await renderServerComponent(<h1>Transported RSC</h1>);
let payload = await serializeLoaderDataNdjson({ article }, undefined);
let response = new Response(payload);
let parsedNdjson = await parseDeferredNdjson(response.body, undefined);
stream = await renderToReadableStream(<main>{parsedNdjson.syncData.article}</main>);
expect(await new Response(stream).text()).toBe("<main><h1>Transported RSC</h1></main>");

article = await renderServerComponent(<h1>Buffered Flight article</h1>);
payload = await serializeLoaderDataNdjson(
  { content: { article } },
  { slow: Promise.resolve("done") }
);
response = new Response(payload);
parsedNdjson = await parseDeferredNdjson(response.body, undefined);
stream = await renderToReadableStream(parsedNdjson.syncData.content.article);
expect(await new Response(stream).text()).toBe("<h1>Buffered Flight article</h1>");
expect(await parsedNdjson.deferredPromises.slow).toBe("done");

const firstLine = serializeRouteFrames({ title: "ready" }, undefined).trimEnd();
let parsedFrames = await parseRouteFrameLines(firstLine, () =>
  Promise.reject(new Error("stream failed"))
);
expect(parsedFrames.syncData.title).toBe("ready");
await expect(parsedFrames.completion).rejects.toThrow("stream failed");

article = await renderServerComponent(<h1>Cyclic Flight article</h1>);
const data = { article };
data.self = data;
const lines = serializeRouteFrames(data, undefined).trimEnd().split("\\n");
const cyclicFirstLine = lines.shift();
if (cyclicFirstLine === undefined) {
  throw new Error("route frame payload was empty");
}
parsedFrames = await parseRouteFrameLines(cyclicFirstLine, async () => lines.shift());
expect(parsedFrames.syncData.self).toBe(parsedFrames.syncData);
stream = await renderToReadableStream(parsedFrames.syncData.article);
expect(await new Response(stream).text()).toBe("<h1>Cyclic Flight article</h1>");

let routeFixture = createRscRoute();
let app = new Elysia().use(createRoutePlugin(routeFixture.resolved, routeFixture.root));
html = await app.handle(new Request("http://localhost/rsc")).then((res) => res.text());
expect(html).toContain("Flight article");
expect(html).toContain('id="__FURIN_ROUTE_FRAMES__"');

routeFixture = createRscRoute();
app = new Elysia().use(createDataEndpoint([routeFixture.resolved]));
response = await app.handle(new Request("http://localhost/_furin/data?path=%2Frsc"));
parsedNdjson = await parseDeferredNdjson(response.body, undefined);
stream = await renderToReadableStream(parsedNdjson.syncData.article);
expect(await new Response(stream).text()).toBe("<h1>Flight article</h1>");

let resolveSlow;
const slow = new Promise((resolve) => {
  resolveSlow = resolve;
});
const route = createRoute({
  loader: async () =>
    defer({
      content: { article: await renderServerComponent(<h1>Nested Flight article</h1>) },
      slow,
    }),
});
const page = route.page({ component: () => null });
const resolved = {
  mode: "ssr",
  page,
  path: "/nested-rsc.tsx",
  pattern: "/nested-rsc",
  routeChain: [route],
  segmentBoundaries: [],
};
app = new Elysia().use(createDataEndpoint([resolved]));
response = await app.handle(new Request("http://localhost/_furin/data?path=%2Fnested-rsc"));

expect(response.headers.get("content-type")).toBe("application/x-furin-route");
const parsedRace = await Promise.race([
  parseDeferredNdjson(response.body, undefined),
  Bun.sleep(100).then(() => {
    throw new Error("route frame parser waited for deferred data");
  }),
]);
stream = await renderToReadableStream(parsedRace.syncData.content.article);
expect(await new Response(stream).text()).toBe("<h1>Nested Flight article</h1>");
resolveSlow("done");
expect(await parsedRace.deferredPromises.slow).toBe("done");

const deferredRscRoute = createRoute({
  loader: async () =>
    defer({
      readyArticle: await renderServerComponent(<h1>Ready Flight article</h1>),
      slowArticle: Promise.resolve(await renderServerComponent(<h1>Deferred Flight article</h1>)),
    }),
});
const deferredRscResolved = {
  mode: "ssr",
  page: deferredRscRoute.page({ component: () => null }),
  path: "/deferred-rsc.tsx",
  pattern: "/deferred-rsc",
  routeChain: [deferredRscRoute],
  segmentBoundaries: [],
};
app = new Elysia().use(createDataEndpoint([deferredRscResolved]));
response = await app.handle(new Request("http://localhost/_furin/data?path=%2Fdeferred-rsc"));
parsedNdjson = await parseDeferredNdjson(response.body, undefined);
stream = await renderToReadableStream(parsedNdjson.syncData.readyArticle);
expect(await new Response(stream).text()).toBe("<h1>Ready Flight article</h1>");
stream = await renderToReadableStream(await parsedNdjson.deferredPromises.slowArticle);
expect(await new Response(stream).text()).toBe("<h1>Deferred Flight article</h1>");

const Card = await createCompositeComponent(({ children, footer }) => (
  <article>
    {children}
    <footer>{footer("Loaded")}</footer>
  </article>
));

stream = await renderToReadableStream(
  <CompositeComponent footer={(label) => <button type="button">{label}</button>} src={Card}>
    <h2>Profile</h2>
  </CompositeComponent>
);
html = await new Response(stream).text();
expect(html).toBe(
  '<article><h2>Profile</h2><footer><button type="button">Loaded</button></footer></article>'
);

const Toolbar = await createCompositeComponent(({ Action }) => (
  <nav>
    <Action label="Save" />
  </nav>
));

stream = await renderToReadableStream(
  <CompositeComponent
    Action={({ label }) => <button type="button">{label}</button>}
    src={Toolbar}
  />
);
html = await new Response(stream).text();
expect(html).toBe('<nav><button type="button">Save</button></nav>');
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    env: { ...process.env, FURIN_RSC_CODEC_PATH: "" },
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `RSC subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
