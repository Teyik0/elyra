// ── HTML template state (per furin instance) ────────────────────────────────

import { readFileSync } from "node:fs";
import { injectInstrumentationClient } from "../devtools/instrumentation.ts";
import {
  allStateBuckets,
  currentInstance,
  defaultInstanceBucket,
  type FurinInstance,
  instanceSlot,
} from "../instance.ts";

interface TemplateState {
  devCache: { html: string; ts: number } | null;
  prodContent: string | null;
  prodPath: string | null;
}

const instanceTemplateState = instanceSlot(
  (): TemplateState => ({ devCache: null, prodContent: null, prodPath: null })
);

const DEV_TEMPLATE_TTL_MS = 1000;

export async function getDevTemplate(origin: string): Promise<string> {
  const instance = currentInstance();
  const state = instanceTemplateState(instance);
  if (state.devCache && Date.now() - state.devCache.ts < DEV_TEMPLATE_TTL_MS) {
    return state.devCache.html;
  }
  // Each instance's HMR entry is mounted under its own prefix.
  const entryPath = `${instance.prefix}/_bun_hmr_entry`;
  const r = await fetch(`${origin}${entryPath}`);
  if (!r.ok) {
    throw new Error(`${entryPath} returned ${r.status}`);
  }
  const html = injectInstrumentationClient(await r.text(), instance.prefix);
  state.devCache = { html, ts: Date.now() };
  return html;
}

export function setProductionTemplatePath(path: string | null, instance?: FurinInstance): void {
  const state = instanceTemplateState(instance);
  state.prodPath = path;
  state.prodContent = null;
}

export function setProductionTemplateContent(content: string, instance?: FurinInstance): void {
  const state = instanceTemplateState(instance);
  state.prodPath = null;
  state.prodContent = content;
}

export function getProductionTemplate(): string | null {
  const own = readTemplate(instanceTemplateState());
  if (own !== null) {
    return own;
  }
  // Config-before-mount fallback: `setProductionTemplateContent()` called
  // before any furin() registration lands on the default bucket — treat that
  // as a process-wide default template.
  const fallback = instanceTemplateState(defaultInstanceBucket());
  return readTemplate(fallback);
}

function readTemplate(state: TemplateState): string | null {
  if (state.prodContent !== null) {
    return state.prodContent;
  }
  if (!state.prodPath) {
    return null;
  }
  try {
    state.prodContent = readFileSync(state.prodPath, "utf8");
    return state.prodContent;
  } catch {
    return null;
  }
}

/** @internal test-only — resets all template state */
export function __resetTemplateState(): void {
  for (const instance of allStateBuckets()) {
    const state = instanceTemplateState(instance);
    state.devCache = null;
    state.prodContent = null;
    state.prodPath = null;
  }
}
