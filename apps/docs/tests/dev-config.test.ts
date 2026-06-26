import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

const docsDir = dirname(import.meta.dir);

describe("docs dev configuration", () => {
  test("resolves every Bun static plugin", async () => {
    const config = Bun.TOML.parse(await Bun.file(join(docsDir, "bunfig.toml")).text()) as {
      serve: { static: { plugins: string[] } };
    };

    for (const plugin of config.serve.static.plugins) {
      expect(() => Bun.resolveSync(plugin, docsDir)).not.toThrow();
    }
  });
});
