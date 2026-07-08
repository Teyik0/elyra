import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dbCredentials: { url: "task-manager.db" },
  dialect: "sqlite",
  out: "./drizzle",
  schema: "./src/db/schema.ts",
});
