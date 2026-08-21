import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { checkDiskSpace } from "../src/utils/disk";

const encoder = new TextEncoder();
const originalSpawnSync = Bun.spawnSync;

function getCommand(args: unknown): string[] {
  if (Array.isArray(args)) {
    return [...args];
  }

  if (args && typeof args === "object" && "cmd" in args) {
    const { cmd } = args as { cmd: string[] };
    return [...cmd];
  }

  throw new Error("Unexpected Bun.spawnSync arguments");
}

afterEach(() => {
  Bun.spawnSync = originalSpawnSync;
});

describe("checkDiskSpace", () => {
  it("checks the nearest existing ancestor for relative target paths", () => {
    let command: string[] = [];

    Bun.spawnSync = ((args) => {
      command = getCommand(args);
      return {
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: encoder.encode(
          "Filesystem 1K-blocks Used Available Capacity Mounted\n/dev/disk 100 0 100 0% /\n"
        ),
        success: true,
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    expect(checkDiskSpace("new-project/nested", 1024)).toBe(true);
    expect(command).toEqual(["df", "-k", resolve(process.cwd())]);
  });

  it("returns false when available space is below the required minimum", () => {
    // 50 KB available, 100 KB required
    Bun.spawnSync = ((_args) => ({
      exitCode: 0,
      stderr: new Uint8Array(),
      stdout: encoder.encode(
        "Filesystem 1K-blocks Used Available Capacity Mounted\n/dev/disk 200 150 50 75% /\n"
      ),
      success: true,
    })) as typeof Bun.spawnSync;

    expect(checkDiskSpace("/tmp", 100 * 1024)).toBe(false);
  });

  it("returns true (fail-open) when df exits with a non-zero code", () => {
    Bun.spawnSync = ((_args) => ({
      exitCode: 1,
      stderr: encoder.encode("df: /no/such: No such file or directory"),
      stdout: new Uint8Array(),
      success: false,
    })) as typeof Bun.spawnSync;

    expect(checkDiskSpace("/tmp", 1024)).toBe(true);
  });

  it("returns true (fail-open) when df output is malformed", () => {
    Bun.spawnSync = ((_args) => ({
      exitCode: 0,
      stderr: new Uint8Array(),
      stdout: encoder.encode("unexpected garbage output\n"),
      success: true,
    })) as typeof Bun.spawnSync;

    expect(checkDiskSpace("/tmp", 1024)).toBe(true);
  });
});
