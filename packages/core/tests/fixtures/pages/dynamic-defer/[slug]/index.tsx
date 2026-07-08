import { defer } from "../../../../../src/client";
import { route } from "./_route";

export default route.page({
  component: ({ slug }) => <div data-testid="dynamic-defer-page">{slug}</div>,
  loader: ({ params }) =>
    defer({
      post: Promise.resolve({ title: `Post for ${String(params.slug)}` }),
      slug: String(params.slug),
    }),
});
