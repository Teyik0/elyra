import { DocPage } from "@/components/doc-page";
import Deployment from "@/content/docs/deployment.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={Deployment}
      doc={DOCS_BY_PATH["/docs/deployment"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Deployment — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/deployment"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
