import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { boardPlugin } from "./api/modules/boards";
import { cardPlugin } from "./api/modules/cards";

const port = Number(process.env.PORT ?? 3002);

const app = new Elysia()
  // Furin must be mounted before API routes so its global revalidation hook
  // can forward X-Furin-Revalidate headers for API-triggered mutations.
  .use(await furin({ pagesDir: "./src/pages" }))
  .use(new Elysia({ prefix: "/api" }).use(boardPlugin).use(cardPlugin))
  .listen(port);

console.log(`Task Manager running at http://localhost:${app.server?.port}`);
