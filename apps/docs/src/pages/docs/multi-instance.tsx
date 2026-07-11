import { DocPage } from "@/components/doc-page";
import MultiInstance from "@/content/docs/multi-instance.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Multi-Instance & Micro-Frontends — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/multi-instance"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={MultiInstance}
      doc={DOCS_BY_PATH["/docs/multi-instance"]}
      markdownSource={markdownSource}
    />
  ),
});
