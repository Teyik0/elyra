import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_PATH = join(import.meta.dirname, "../../../scripts/measure-client-bundle.ts");

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { force: true, recursive: true });
    tempDir = undefined;
  }
});

describe("measure-client-bundle", () => {
  test("ignores external JS and CSS URLs before measuring local assets", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "furin-measure-client-"));
    writeFileSync(join(tempDir, "app.js"), "console.log('local');");
    writeFileSync(
      join(tempDir, "index.html"),
      [
        '<link rel="stylesheet" href="https://cdn.example.com/theme.css">',
        '<script src="//cdn.example.com/runtime.js"></script>',
        '<script src="./app.js"></script>',
      ].join("\n")
    );

    const proc = Bun.spawn({
      cmd: ["bun", SCRIPT_PATH, join(tempDir, "index.html")],
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("./app.js");
    expect(stdout).not.toContain("cdn.example.com");
  });
});
