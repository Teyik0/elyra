import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignoreExportsUsedInFile: true,
  workspaces: {
    ".": {
      // doctor.config.ts is consumed by the react-doctor CLI (not imported by
      // app code); list it as an entry so its `react-doctor/api` type import
      // also marks the dependency as used.
      entry: ["doctor.config.ts"],
      // @biomejs/biome is used via biome.jsonc but not directly imported in JS/TS
      // @commitlint/cli is the CLI runner; commitlint plugin detects config-conventional
      ignoreDependencies: ["@biomejs/biome", "@commitlint/cli"],
    },
    "apps/docs": {
      // Furin uses file-based routing: all files in pages/ are entry points
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      // Tailwind v4 plugins loaded via CSS @import/@plugin directives, not JS imports
      ignoreDependencies: ["tailwindcss", "tw-animate-css", "@tailwindcss/typography"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "apps/scaffolder": {
      // templates/ contains EJS files referencing deps of generated projects, not the scaffolder itself
      ignore: ["templates/**"],
    },
    "examples/task-manager": {
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      ignoreDependencies: ["tailwindcss"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "examples/weather": {
      entry: ["src/server.ts", "furin.config.ts", "src/pages/**/*.{ts,tsx}"],
      ignoreDependencies: ["tailwindcss"],
      project: ["src/**/*.{ts,tsx}"],
    },
    "packages/core": {
      project: ["src/**/*.{ts,tsx}"],
    },
  },
};

export default config;
