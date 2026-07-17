// biome-ignore-all lint/performance/noAwaitInLoops: build lock helper polls sequentially until the lock is released
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LOCK_DIR = resolve(import.meta.dir, "../../.tmp-tests/build.lock");
const STALE_LOCK_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function acquireBuildTestLock(): Promise<() => void> {
  for (;;) {
    try {
      mkdirSync(LOCK_DIR, { recursive: false });
      writeFileSync(join(LOCK_DIR, "owner"), `${process.pid}\n`);
      return () => {
        rmSync(LOCK_DIR, { force: true, recursive: true });
      };
    } catch {
      if (!existsSync(LOCK_DIR)) {
        await delay(5);
        continue;
      }

      let ageMs: number;
      try {
        ageMs = Date.now() - statSync(LOCK_DIR).mtimeMs;
      } catch {
        await delay(5);
        continue;
      }
      if (ageMs > STALE_LOCK_MS) {
        rmSync(LOCK_DIR, { force: true, recursive: true });
        continue;
      }

      await delay(10);
    }
  }
}

export async function withBuildTestLock<T>(run: () => Promise<T>): Promise<T> {
  const release = await acquireBuildTestLock();
  try {
    return await run();
  } finally {
    release();
  }
}
