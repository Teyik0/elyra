import { furin } from "@teyik0/furin";
import Elysia from "elysia";

const app = new Elysia()
  .use(
    await furin({
      pagesDir: `${import.meta.dir}/pages`,
    })
  )
  .listen(3112);

console.log(`[full] listening on ${app.server?.port}`);
