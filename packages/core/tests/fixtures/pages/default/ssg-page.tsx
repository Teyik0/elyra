import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "./root";

const ssgRoute = createRoute({
  mode: "ssg",
  parent: rootRoute,
});

export default ssgRoute.page({
  component: () => <div data-testid="ssg-page">SSG Page</div>,
  head: () => ({
    links: [{ href: "/test.css", rel: "stylesheet" }],
    meta: [{ title: "SSG Test Page" }, { content: "Test description", name: "description" }],
  }),
});
