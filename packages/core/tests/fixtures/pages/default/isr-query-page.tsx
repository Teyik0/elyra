import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "./root";

const isrQueryRoute = createRoute({
  loader: ({ query }) => ({
    tenant: String((query as { tenant?: unknown }).tenant ?? ""),
    timestamp: Date.now(),
  }),
  mode: "isr",
  parent: rootRoute,
  revalidate: 60,
});

export default isrQueryRoute.page({
  component: ({ tenant, timestamp }) => (
    <div data-tenant={tenant} data-testid="isr-query-page" data-timestamp={String(timestamp)}>
      {tenant}
    </div>
  ),
});
