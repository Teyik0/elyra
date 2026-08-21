import { notFound } from "@teyik0/furin";
import { getBoard } from "@/api/modules/boards/service";
import { getCard } from "@/api/modules/cards/service";
import { CardDetailPage } from "@/components/card-detail-page";
import { route } from "./_route";

export default route.page({
  loader: ({ params }) => {
    const board = getBoard(params.boardId);
    const card = getCard(params.cardId);

    if (!board) {
      notFound({ message: "Board not found" });
    }
    if (!card) {
      notFound({ message: "Card not found" });
    }
    if (card.boardId !== params.boardId) {
      notFound({ message: "Card not found" });
    }

    const renderedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const formattedCreatedAt = new Date(card.createdAt).toLocaleDateString("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    return {
      boardName: board.name,
      card,
      formattedCreatedAt,
      renderedAt,
    };
  },
  component: ({ params, card, boardName, renderedAt, formattedCreatedAt }) => (
    <CardDetailPage
      boardName={boardName}
      card={card}
      formattedCreatedAt={formattedCreatedAt}
      params={params}
      renderedAt={renderedAt}
    />
  ),
  head: ({ card, boardName }) => ({
    meta: [{ title: `${card.title} | ${boardName} | Task Manager` }],
  }),
  tags: ["cards"],
});
