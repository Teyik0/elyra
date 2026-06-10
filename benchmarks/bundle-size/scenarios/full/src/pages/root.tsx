import { createRoute, defer, type HeadOptions, type MetaDescriptor } from "@teyik0/furin/client";

export const route = createRoute({
  layout: ({ children }) => (
    <div>
      <header>Full App</header>
      <main>{children}</main>
    </div>
  ),
  loader: async () =>
    defer({
      rootData: "root",
      deferredRoot: Promise.resolve("deferred"),
    }),
  head: (): HeadOptions => ({
    meta: [
      { charSet: "utf-8" } satisfies MetaDescriptor,
      { title: "Full Benchmark" } satisfies MetaDescriptor,
    ],
    links: [{ rel: "canonical", href: "/" }],
  }),
  tags: ["root"],
  revalidate: 60,
});
