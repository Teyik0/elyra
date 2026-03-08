// ── Dev template ─────────────────────────────────────────────────────────────

let _devTemplatePromise: Promise<string> | null = null;

export function getDevTemplate(origin: string): Promise<string> {
  _devTemplatePromise ??= fetch(`${origin}/_bun_hmr_entry`)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`/_bun_hmr_entry returned ${r.status}`);
      }
      return r.text();
    })
    .catch((err) => {
      _devTemplatePromise = null;
      throw err;
    });
  return _devTemplatePromise;
}

// ── Prod template ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateIndexHtml } from "../build";

let _prodTemplate: string | null = null;

/**
 * Returns the production HTML template.
 * Reads the Bun.build()-processed `.elyra/client/index.html` (which contains
 * content-hashed JS/CSS asset tags) and caches it in memory.
 * Falls back to the raw `generateIndexHtml()` shell when the file is absent
 * (e.g. in unit tests that run without a prior `bun run build`).
 */
export function readProdTemplate(outDir = ".elyra"): string {
  if (_prodTemplate !== null) {
    return _prodTemplate;
  }
  const path = join(process.cwd(), outDir, "client", "index.html");
  if (existsSync(path)) {
    _prodTemplate = readFileSync(path, "utf8");
    return _prodTemplate;
  }
  return generateIndexHtml();
}

/** @internal test-only — clears the cached prod template so tests are isolated. */
export function resetProdTemplate(): void {
  _prodTemplate = null;
}
