import { furinInvalidate } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { createBoard, deleteBoard, getBoardData, getBoardStats, getBoards } from "./service";

export const boardPlugin = new Elysia()
  .use(furinInvalidate())
  .get("/boards", () => getBoards())
  .post("/boards", ({ body }) => createBoard(body.name), {
    body: t.Object({ name: t.String({ minLength: 1 }) }),
    // Path + layout invalidations make the refresh robust regardless of which
    // pages happen to be registered in the auto-invalidate registry at mutation
    // time. The board list lives on `/` and is also surfaced as a sidebar
    // under the `/board` layout — both need to re-render after a mutation.
    invalidate: [
      { tags: ["boards"] },
      { path: "/", type: "page" },
      { path: "/board", type: "layout" },
    ],
  })
  .delete(
    "/boards/:boardId",
    ({ params, status }) => {
      const ok = deleteBoard(params.boardId);
      if (!ok) {
        return status("Not Found", "Not found");
      }
      return { ok: true };
    },
    {
      invalidate: [
        { tags: ["boards"] },
        { path: "/", type: "page" },
        { path: "/board", type: "layout" },
      ],
    }
  )
  .get("/boards/:boardId", ({ params, status }) => {
    const data = getBoardData(params.boardId);
    if (!data) {
      return status("Not Found", "Not found");
    }
    return data;
  })
  .get("/boards/:boardId/stats", async ({ params, status }) => {
    // Artificial delay — makes the Suspense streaming boundary visible in the UI
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    const stats = getBoardStats(params.boardId);
    if (!stats) {
      return status("Not Found", "Not found");
    }
    return stats;
  });
