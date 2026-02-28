import { elysion } from "@teyik0/elysion";
import Elysia from "elysia";
import elysionHtml from "../.elysion/index.html"; // ← static import: triggers Bun module graph + HMR
import { api } from "./api";

const app = new Elysia({
  serve: {
    // Registers the Bun-processed HTML bundle.
    // Bun's HTML bundler runs on the static import above, producing:
    //   /_bun/*.js — content-hashed client chunks
    //   HMR WebSocket — for React Fast Refresh in dev
    // The server self-fetches /_bun_entry on first request to get the
    // processed template for SSR injection.
    routes: {
      "/_bun_entry": elysionHtml,
    },
  },
})
  .use(api)
  .use(
    await elysion({
      pagesDir: `${import.meta.dir}/pages`,
      staticOptions: {
        assets: `${import.meta.dir}/../public`,
        prefix: "/public",
        staticLimit: 1024,
        alwaysStatic: process.env.NODE_ENV === "production",
      },
    })
  )
  .listen(3000);

console.log(`\n Elysion Blog + Dashboard running at http://localhost:${app.server?.port}`);
console.log("\nTest accounts:");
console.log("  user@example.com (role: user)");
console.log("  admin@example.com (role: admin)");
