import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { api } from "./api";
import { taskManagerSync } from "./sync";

const port = Number(process.env.PORT ?? 3002);

const app = new Elysia()
  .use(await furin({ pagesDir: "./src/pages", sync: taskManagerSync }))
  .use(api)
  .listen(port);

console.log(`Task Manager running at http://localhost:${app.server?.port}`);
