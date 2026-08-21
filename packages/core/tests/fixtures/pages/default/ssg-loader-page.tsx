import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "./root";

/**
 * SSG fixture WITH a loader — used by the dev SSG loader-cache tests.
 * The loader captures `Date.now()` so a cache hit (same timestamp) vs
 * miss (advanced timestamp) is directly observable in the rendered HTML.
 */
const ssgLoaderRoute = createRoute({
  loader: () => Promise.resolve({ timestamp: Date.now() }),
  mode: "ssg",
  parent: rootRoute,
});

export default ssgLoaderRoute.page({
  component: ({ timestamp }) => (
    <div data-testid="ssg-loader-page" data-timestamp={String(timestamp)}>
      SSG Loader Page
    </div>
  ),
});
