import { DocPage } from "@/components/doc-page";
import Routing from "@/content/docs/routing.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={Routing}
      doc={DOCS_BY_PATH["/docs/routing"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "File-Based Routing — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/routing"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
