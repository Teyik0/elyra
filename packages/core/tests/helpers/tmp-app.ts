import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FIXTURES_ROOT = resolve(import.meta.dir, "../fixtures");
const TMP_ROOT = resolve(import.meta.dir, "../../.tmp-tests");

export interface TmpApp {
  cleanup: () => void;
  path: string;
}

function ensureTmpRoot(): void {
  if (!existsSync(TMP_ROOT)) {
    mkdirSync(TMP_ROOT, { recursive: true });
  }
}

function assertWithinAppPath(appPath: string, relativePath: string): string {
  const resolved = resolve(appPath, relativePath);
  const normalizedApp = resolve(appPath);
  if (resolved !== normalizedApp && !resolved.startsWith(`${normalizedApp}/`)) {
    throw new Error(`Path traversal detected: "${relativePath}" escapes app root`);
  }
  return resolved;
}

export function createTmpApp(fixtureName: string): TmpApp {
  ensureTmpRoot();

  const source = join(FIXTURES_ROOT, fixtureName);
  const path = mkdtempSync(join(TMP_ROOT, `${fixtureName}-`));
  cpSync(source, path, { recursive: true });

  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function writeAppFile(appPath: string, relativePath: string, contents: string): void {
  const resolvedPath = assertWithinAppPath(appPath, relativePath);
  const directory = resolve(resolvedPath, "..");
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolvedPath, contents);
}

export function removeAppPath(appPath: string, relativePath: string): void {
  const resolvedPath = assertWithinAppPath(appPath, relativePath);
  rmSync(resolvedPath, { recursive: true, force: true });
}
