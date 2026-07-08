import { DocPage } from "@/components/doc-page";
import Caching from "@/content/docs/caching.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={Caching}
      doc={DOCS_BY_PATH["/docs/caching"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Caching — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/caching"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
