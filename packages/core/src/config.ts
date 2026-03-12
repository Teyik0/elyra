export type { BunPlugin } from "bun";

export const BUILD_TARGETS = ["bun", "node", "vercel", "cloudflare"] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

export interface ElyraConfig {
  bun?: {
    compile?: "split" | "embed";
  };
  client?: {
    minify?: boolean;
    sourcemap?: boolean;
  };
  outDir?: string;
  pagesDir?: string;
  plugins?: Bun.BunPlugin[];
  rootDir?: string;
  serverEntry?: string;
  targets?: BuildTarget[];
}

export function defineConfig(config: ElyraConfig): ElyraConfig {
  return config;
}
