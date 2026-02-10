import { staticPlugin } from "@elysiajs/static";
import type { StaticOptions } from "@elysiajs/static/types";
import { Elysia, type AnyElysia } from "elysia";
import { createRoutePlugin, scanPages } from "./router";

interface ElysionProps {
  pagesDir?: string;
  staticOptions: StaticOptions<string>;
}

export async function elysion({ pagesDir, staticOptions }: ElysionProps) {
  const routes = await scanPages(pagesDir ?? "./src/pages");

  const plugins: AnyElysia[] = [];

  console.log(`Configuration: ${routes.length} page(s)`);
  for (const route of routes) {
    const modeLabel = route.mode.toUpperCase();
    const hasAction = route.module.options?.action ? " + action" : "";
    console.log(`${modeLabel.padEnd(4)} ${route.pattern}${hasAction}`);

    plugins.push(createRoutePlugin(route, staticOptions));
  }

  return plugins.reduce(
    (app, plugin) => app.use(plugin),
    new Elysia().use(await staticPlugin(staticOptions))
  );
}

// biome-ignore lint/performance/noBarrelFile: library entrypoint
export { page } from "./page";
