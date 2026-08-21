import { DocPage } from "@/components/doc-page";
import Plugins from "@/content/docs/plugins.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={Plugins}
      doc={DOCS_BY_PATH["/docs/plugins"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Plugins — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/plugins"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
