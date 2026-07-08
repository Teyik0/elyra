import { DocPage } from "@/components/doc-page";
import GettingStarted from "@/content/docs/getting-started.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={GettingStarted}
      doc={DOCS_BY_PATH["/docs/getting-started"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Getting Started — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/getting-started"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
