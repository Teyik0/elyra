import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

const params = t.Object({ id: t.String() });

export const route = defineRoute()
  .config({ mode: "isr", params })
  .loader(async (context) => {
    const user = await (context as typeof context & { user: Promise<string> | string }).user;
    return { board: context.params.id, user };
  })
  .head(({ data }) => ({ meta: [{ title: `Board ${data.board}` }] }))
  .page(({ data }) => data.board);
