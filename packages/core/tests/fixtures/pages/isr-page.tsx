import { createRoute } from "../../../src/client";
import { route as rootRoute } from "./root";

const isrRoute = createRoute({
  parent: rootRoute,
  mode: "isr",
  revalidate: 60,
  loader: async () => ({ timestamp: Date.now() }),
});

export default isrRoute.page({
  component: ({ timestamp }) => (
    <div data-testid="isr-page" data-timestamp={String(timestamp)}>
      ISR Page
    </div>
  ),
});
