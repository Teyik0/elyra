import { furinInvalidate } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { createBoard, deleteBoard, getBoardData, getBoardStats, getBoards } from "./service";

// Shared invalidation rules for every board mutation (POST / DELETE).
// Path + layout invalidations make the refresh robust regardless of which
// pages happen to be registered in the auto-invalidate registry at mutation
// time. The board list lives on `/` and is also surfaced as a sidebar under the
// `/board` layout — both need to re-render after a mutation.
const BOARD_MUTATION_INVALIDATIONS = [
  { tags: ["boards"] as const },
  { path: "/", type: "page" as const },
  { path: "/board", type: "layout" as const },
];

export const boardPlugin = new Elysia()
  .use(furinInvalidate())
  .get("/boards", () => getBoards())
  .post("/boards", ({ body }) => createBoard(body.name), {
    body: t.Object({ name: t.String({ minLength: 1 }) }),
    invalidate: BOARD_MUTATION_INVALIDATIONS,
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
      invalidate: BOARD_MUTATION_INVALIDATIONS,
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
