import { DocPage } from "@/components/doc-page";
import Rendering from "@/content/docs/rendering.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={Rendering}
      doc={DOCS_BY_PATH["/docs/rendering"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Rendering Modes — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/rendering"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
