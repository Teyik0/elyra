import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TmpFilePaths {
  [name: string]: string;
}

export type TmpFileSource = string | ((paths: TmpFilePaths) => string);

export interface TmpFileSources {
  [name: string]: TmpFileSource;
}

export function requireTmpPath(paths: TmpFilePaths, name: string): string {
  const path = paths[name];
  if (!path) {
    throw new Error(`Missing temp path for ${name}`);
  }
  return path;
}

export function withTmpFiles(
  tmpDir: string,
  files: TmpFileSources,
  fn: (paths: TmpFilePaths) => Promise<void>
): Promise<void> {
  mkdirSync(tmpDir, { recursive: true });
  const prefix = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const paths: TmpFilePaths = Object.fromEntries(
    Object.keys(files).map((name) => {
      const path = join(tmpDir, `${prefix}-${name}`);
      return [name, path];
    })
  );

  for (const [name, source] of Object.entries(files)) {
    writeFileSync(
      requireTmpPath(paths, name),
      typeof source === "function" ? source(paths) : source
    );
  }

  // Remove only the files created by this invocation so concurrent test runs
  // do not race against each other by deleting the shared temp directory.
  return fn(paths).finally(() => {
    for (const filePath of Object.values(paths)) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        /* cleanup failure is non-critical */
      }
    }
  });
}

export function withTmpPage(
  tmpDir: string,
  source: string,
  fn: (path: string) => Promise<void>
): Promise<void> {
  return withTmpFiles(tmpDir, { "page.tsx": source }, async (paths) =>
    fn(requireTmpPath(paths, "page.tsx"))
  );
}
