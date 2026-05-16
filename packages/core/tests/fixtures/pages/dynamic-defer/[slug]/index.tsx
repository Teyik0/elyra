import { defer } from "../../../../../src/client";
import { route } from "./_route";

export default route.page({
  loader: ({ params }) =>
    defer({
      slug: String(params.slug),
      post: Promise.resolve({ title: `Post for ${String(params.slug)}` }),
    }),
  component: ({ slug }) => <div data-testid="dynamic-defer-page">{slug}</div>,
});
