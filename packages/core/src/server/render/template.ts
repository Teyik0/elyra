// ── Dev template ─────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";

let _prodTemplatePath: string | null = null;
let _prodTemplateContent: string | null = null;

/** Dev template cache — avoids a loopback HTTP fetch on every SSR request. */
let _devTemplateCache: { html: string; ts: number } | null = null;
const DEV_TEMPLATE_TTL_MS = 1000;

export async function getDevTemplate(origin: string): Promise<string> {
  if (_devTemplateCache && Date.now() - _devTemplateCache.ts < DEV_TEMPLATE_TTL_MS) {
    return _devTemplateCache.html;
  }
  const r = await fetch(`${origin}/_bun_hmr_entry`);
  if (!r.ok) {
    throw new Error(`/_bun_hmr_entry returned ${r.status}`);
  }
  const html = await r.text();
  _devTemplateCache = { html, ts: Date.now() };
  return html;
}

export function setProductionTemplatePath(path: string | null): void {
  _prodTemplatePath = path;
  _prodTemplateContent = null;
}

export function setProductionTemplateContent(content: string): void {
  _prodTemplatePath = null;
  _prodTemplateContent = content;
}

export function getProductionTemplate(): string | null {
  if (_prodTemplateContent !== null) {
    return _prodTemplateContent;
  }
  if (!_prodTemplatePath) {
    return null;
  }
  try {
    _prodTemplateContent = readFileSync(_prodTemplatePath, "utf8");
    return _prodTemplateContent;
  } catch {
    return null;
  }
}

/** @internal test-only — resets all template state */
export function __resetTemplateState(): void {
  _prodTemplatePath = null;
  _prodTemplateContent = null;
  _devTemplateCache = null;
}
