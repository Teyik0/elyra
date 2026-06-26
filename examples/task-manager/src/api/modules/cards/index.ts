import { furinSync } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { columnType } from "../shared";
import { createCard, deleteCard, getCard, updateCard } from "./service";

export const cardPlugin = new Elysia()
  .use(furinSync())
  .get("/cards/:id", ({ params, status }) => {
    const card = getCard(params.id);
    if (!card) {
      return status("Not Found", "Not found");
    }
    return card;
  })
  .post(
    "/boards/:boardId/cards",
    ({ params, body }) => createCard(params.boardId, body.title, body.column),
    {
      body: t.Object({
        title: t.String({ minLength: 1 }),
        column: columnType,
      }),
      sync: { invalidate: { tags: ["cards"] } },
    }
  )
  .post(
    "/cards/:id",
    ({ params, body, status, redirect }) => {
      const existing = getCard(params.id);
      if (!existing) {
        return status("Not Found", "Not found");
      }
      const card = updateCard(params.id, body);
      if (!card) {
        return status("Not Found", "Not found");
      }
      return redirect(`/board/${card.boardId}`);
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.String()),
      }),
      sync: { invalidate: { tags: ["cards"] } },
    }
  )
  .patch(
    "/cards/:id",
    ({ params, body, status }) => {
      const existing = getCard(params.id);
      if (!existing) {
        return status("Not Found", "Not found");
      }
      const card = updateCard(params.id, body);
      if (!card) {
        return status("Not Found", "Not found");
      }
      return card;
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.String()),
        column: t.Optional(columnType),
        position: t.Optional(t.Number()),
      }),
      sync: { invalidate: { tags: ["cards"] } },
    }
  )
  .delete(
    "/cards/:id",
    ({ params, status }) => {
      const card = getCard(params.id);
      if (!card) {
        return status("Not Found", "Not found");
      }
      const ok = deleteCard(params.id);
      if (!ok) {
        return status("Not Found", "Not found");
      }
      return { ok: true };
    },
    {
      sync: { invalidate: { tags: ["cards"] } },
    }
  );
