import { elyra } from "elyra";
import Elysia from "elysia";

const port = Number(process.env.PORT ?? 3111);

const app = new Elysia()
  .use(
    await elyra({
      pagesDir: `${import.meta.dir}/pages`,
    })
  )
  .listen(port);

console.log(`[test-app] listening on ${app.server?.port}`);
