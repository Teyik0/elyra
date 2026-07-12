import { test } from "bun:test";
import { join as joinPath } from "node:path";

const script = `
const { mock } = await import("bun:test");
mock.module("evlog/elysia", () => ({
  evlog: () => (app) => app,
  useLogger: () => ({ set() {} }),
}));

const { join } = await import("node:path");
const { renderRootNotFound } = await import("./packages/core/src/server/render/index.ts");
const {
  __resetTemplateState,
  setProductionTemplateContent,
} = await import("./packages/core/src/server/render/template.ts");
const { scanPages } = await import("./packages/core/src/server/router/index.ts");
const { __setDevMode } = await import("./packages/core/src/server/runtime-env.ts");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

__setDevMode(false);
const fixturesDir = join(process.cwd(), "packages/core/tests/fixtures/pages/default");

__resetTemplateState();
setProductionTemplateContent("<!DOCTYPE html><html><body>PROD</body></html>");
let result = await scanPages(fixturesDir);
let response = await renderRootNotFound(result.root, undefined);
assert(response.status === 404, "production template response status");
let body = await response.text();
assert(body.includes("PROD"), "production template body");

__resetTemplateState();
result = await scanPages(fixturesDir);
response = await renderRootNotFound(result.root, undefined);
assert(response.status === 404, "generated template response status");
body = await response.text();
assert(body.includes("__FURIN_DATA__"), "generated template body");

__resetTemplateState();
result = await scanPages(fixturesDir);
const rootWithBrokenNotFound = {
  ...result.root,
  notFound: () => {
    throw new Error("not-found-boom");
  },
};
response = await renderRootNotFound(rootWithBrokenNotFound, undefined);
assert(response.status === 404, "broken not-found fallback status");
body = await response.text();
assert(body.includes("404"), "broken not-found fallback body");
`;

test("renderRootNotFound scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--preload", "./packages/core/tests/setup/global.ts", "-e", script],
    cwd: joinPath(import.meta.dir, "../../../../.."),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `renderRootNotFound subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }
});
