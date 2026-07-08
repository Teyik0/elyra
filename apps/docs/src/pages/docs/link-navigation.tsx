import { DocPage } from "@/components/doc-page";
import LinkNavigation from "@/content/docs/link-navigation.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage
      Content={LinkNavigation}
      doc={DOCS_BY_PATH["/docs/link-navigation"]}
      markdownSource={markdownSource}
    />
  ),
  head: () => ({
    meta: [{ title: "Link & Navigation — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/link-navigation"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
