import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "./root";

const syncLoaderErrorRoute = createRoute({
  mode: "ssr",
  parent: rootRoute,
});

export default syncLoaderErrorRoute.page({
  component: () => <div>unreachable</div>,
  loader: () => {
    throw new Error("synchronous loader failure");
  },
});
