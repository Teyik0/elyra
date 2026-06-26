import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { api } from "./api";

const port = Number(process.env.PORT ?? 3002);

const app = new Elysia()
  .use(await furin({ pagesDir: "./src/pages", sync: true }))
  .use(api)
  .listen(port);

console.log(`Task Manager running at http://localhost:${app.server?.port}`);
