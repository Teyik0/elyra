import { route as rootRoute } from "../root";

export default rootRoute.page({
  component: () => <article>Blog post page</article>,
  staticParams: () => [{ slug: "hello-world" }],
});
