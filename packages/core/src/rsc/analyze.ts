import { detectClientFeatures } from "./detect";
import type { ModuleAnalysis } from "./types";

const CLIENT_SUFFIX = ".client.tsx";
const SERVER_SUFFIX = ".server.tsx";

export async function analyzeModule(path: string): Promise<ModuleAnalysis> {
  const code = await Bun.file(path).text();

  // Extract exports for all files
  const rawExports = extractExports(code);

  if (path.endsWith(CLIENT_SUFFIX)) {
    return {
      path,
      type: "client",
      exports: rawExports.map((e) => ({ ...e, type: "client" as const })),
      clientFeatures: [],
    };
  }

  if (path.endsWith(SERVER_SUFFIX)) {
    return {
      path,
      type: "server",
      exports: rawExports.map((e) => ({ ...e, type: "server" as const })),
      clientFeatures: [],
    };
  }

  // Auto-detection path
  const detection = detectClientFeatures(code);
  const exportType = detection.isClient ? "client" as const : "server" as const;

  return {
    path,
    type: exportType,
    exports: rawExports.map((e) => ({ ...e, type: exportType })),
    clientFeatures: detection.features,
  };
}

function extractExports(code: string): { name: string }[] {
  const exports: { name: string }[] = [];
  let match: RegExpExecArray | null;

  // export function Name() {}
  const exportFunctionPattern = /export\s+(?:async\s+)?function\s+([A-Z][a-zA-Z0-9]*)/g;
  while ((match = exportFunctionPattern.exec(code)) !== null) {
    if (match[1]) {
      exports.push({ name: match[1] });
    }
  }

  // export const Name = ...
  const exportConstPattern = /export\s+const\s+([A-Z][a-zA-Z0-9]*)\s*=/g;
  while ((match = exportConstPattern.exec(code)) !== null) {
    if (match[1]) {
      exports.push({ name: match[1] });
    }
  }

  // export default function Name() {}
  const exportDefaultFunctionPattern = /export\s+default\s+function\s+([A-Z][a-zA-Z0-9]*)/g;
  while ((match = exportDefaultFunctionPattern.exec(code)) !== null) {
    if (match[1]) {
      exports.push({ name: match[1] });
    }
  }

  // export default (anonymous function, arrow function, or expression)
  const exportDefaultPattern = /export\s+default\s+(?!function\s+[A-Z])/g;
  const codeWithoutNamedDefault = code.replace(/export\s+default\s+function\s+[A-Z][a-zA-Z0-9]*/g, "");
  if (exportDefaultPattern.test(codeWithoutNamedDefault)) {
    exports.push({ name: "default" });
  }

  return exports;
}

export async function analyzeAllPages(
  routes: Array<{ pattern: string; pagePath?: string }>
): Promise<Map<string, ModuleAnalysis>> {
  const analyses = new Map<string, ModuleAnalysis>();

  for (const route of routes) {
    if (!route.pagePath) {
      continue;
    }

    const exists = await Bun.file(route.pagePath).exists();
    if (!exists) {
      continue;
    }

    const analysis = await analyzeModule(route.pagePath);
    analyses.set(route.pagePath, analysis);
  }

  return analyses;
}
