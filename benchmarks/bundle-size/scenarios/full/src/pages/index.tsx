import {
  Await,
  defer,
  type HeadOptions,
  isDeferred,
  useAsyncError,
  useAsyncValue,
} from "@teyik0/furin/client";
import { Link } from "@teyik0/furin/link";
import { route } from "./root";

export default route.page({
  loader: async () =>
    defer({
      title: "Home",
      stats: Promise.resolve({ count: 42 }),
    }),
  head: (): HeadOptions => ({
    meta: [{ name: "description", content: "Home page" }],
  }),
  component: () => {
    const value = useAsyncValue();
    const error = useAsyncError();

    if (error) {
      return <div>Error: {String(error)}</div>;
    }

    return (
      <div>
        <h1>Home</h1>
        <Await resolve={value?.stats}>{(stats) => <div>Count: {stats?.count}</div>}</Await>
        <Link to="/about">About</Link>
        <Link to="/dashboard">Dashboard</Link>
        <button
          onClick={() => {
            if (isDeferred({ __isDeferred: true })) {
              console.log("deferred");
            }
          }}
          type="button"
        >
          Check
        </button>
      </div>
    );
  },
});
