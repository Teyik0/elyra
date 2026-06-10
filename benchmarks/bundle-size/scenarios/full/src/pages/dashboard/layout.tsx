import { createRoute } from "@teyik0/furin/client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  parent: rootRoute,
  layout: ({ children }) => (
    <div>
      <aside>Dashboard nav</aside>
      <section>{children}</section>
    </div>
  ),
  loader: async () => ({ section: "dashboard" }),
  tags: ["dashboard"],
});
