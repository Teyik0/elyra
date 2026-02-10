# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Elysion** is a React meta-framework powered by [Elysia](https://elysiajs.com/). It provides file-based routing with SSR, SSG, and ISR rendering modes, similar to Next.js but built on Elysia + Bun.

## Commands

- `bun run dev` — Run the example app with watch mode
- `bun run build` — Build the library to `dist/`
- `bun run check` — Lint with ultracite (biome-based)
- `bun run fix` — Auto-fix lint issues
- `bun run tsc` — Type-check without emitting
- `bun test` — Run tests

## Tooling

- **Runtime**: Bun only. Never use Node.js, npm, yarn, pnpm, dotenv, express, vite, or webpack.
- **Linting**: Ultracite (wraps Biome). Config in `biome.jsonc`.
- **CSS**: Tailwind v4 via `bun-plugin-tailwind` (configured in `bunfig.toml`).
- **Path alias**: `"elysion"` maps to `./src/index.ts` (see `tsconfig.json` paths).

## Architecture

The framework lives in `src/` and an example app lives in `example/`.

### Core (`src/`)

- **`index.ts`** — Main entrypoint. Exports `elysion()` which scans pages, creates route plugins, mounts static file serving via `@elysiajs/static`, and starts the Elysia server. Also re-exports `page` from `page.ts`.
- **`page.ts`** — Defines the `page(component, options?)` function that page files must use as their default export. Options include `loader`, `head`, `action`, `mode` (ssr/ssg/isr), and `revalidate`. The `PageModule` type is branded with `__brand: "elysion-react-page"`.
- **`router.ts`** — File-based router. `scanPages()` globs `**/*.tsx` in the pages directory, imports each, and resolves routes. `createRoutePlugin()` creates an Elysia plugin per route with GET (and optionally POST for actions) handlers. Contains rendering logic for SSR/SSG/ISR modes with caching.
- **`render.ts`** — (WIP) Server-side React rendering utilities.

### Rendering Modes

Mode resolution in `router.ts` (`resolveMode`):
- No loader → **SSG** (static generation)
- Has loader → **SSR** (server-side rendering)
- Has `revalidate > 0` → **ISR** (incremental static regeneration)
- Explicit `mode` option always wins

### File-based Routing Conventions

Pages go in a `pages/` directory (configurable via `pagesDir`):
- `index.tsx` → `/`
- `about.tsx` → `/about`
- `blog/index.tsx` → `/blog`
- `blog/[slug].tsx` → `/blog/:slug`
- `[...catch].tsx` → `/*` (catch-all)
- `_hidden.tsx` → ignored (underscore prefix)

### Example App (`example/`)

- `example/src/server.ts` — Creates an Elysia app, uses `elysion()` plugin, adds API routes under `/api`
- `example/src/pages/` — Page components using `page()` export convention
- `example/public/` — Static assets served at `/public`

### Page File Convention

Every page must default-export the result of `page(Component, options?)`:

```tsx
import { page } from "elysion";
export default page(MyComponent, { mode: "ssr", loader: async () => {...} });
```
