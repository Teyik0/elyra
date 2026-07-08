import { DocPage } from "@/components/doc-page";
import Cli from "@/content/docs/cli.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  component: ({ markdownSource }) => (
    <DocPage Content={Cli} doc={DOCS_BY_PATH["/docs/cli"]} markdownSource={markdownSource} />
  ),
  head: () => ({
    meta: [{ title: "CLI — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/cli"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
});
