import { createRoute } from "../../../src/client";
import { route as rootRoute } from "./root";

const ssgRoute = createRoute({
  parent: rootRoute,
  mode: "ssg",
});

export default ssgRoute.page({
  head: () => ({
    meta: [{ title: "SSG Test Page" }, { name: "description", content: "Test description" }],
    links: [{ rel: "stylesheet", href: "/test.css" }],
  }),
  component: () => <div data-testid="ssg-page">SSG Page</div>,
});
