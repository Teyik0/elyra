import { createRoute } from "@teyik0/elysion/client";
import { t } from "elysia";
import { getAllTags, queries } from "../../db";

export const route = createRoute({
  query: t.Object({
    page: t.Optional(t.Number()),
    tag: t.Optional(t.String()),
  }),
  loader: () => {
    const posts = queries.getPublishedPosts.all();
    const tags = getAllTags(posts);
    return { tags };
  },
  layout: ({ children, tags }) => (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex gap-8">
        <aside className="hidden w-64 shrink-0 lg:block">
          <div className="sticky top-8">
            <h3 className="mb-4 font-semibold text-gray-900">Tags</h3>
            <div className="space-y-2">
              <a
                className="block text-gray-600 transition-colors hover:text-indigo-600"
                href="/blog"
              >
                All Posts
              </a>
              {tags.map((tag) => (
                <a
                  className="block text-gray-600 transition-colors hover:text-indigo-600"
                  href={`/blog?tag=${encodeURIComponent(tag)}`}
                  key={tag}
                >
                  {tag}
                </a>
              ))}
            </div>
          </div>
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  ),
});
