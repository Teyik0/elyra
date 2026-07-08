import { asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { boards, cards } from "@/db/schema";
import {
  createCard as createCardFromCardsService,
  getCardsForBoard as getCardsForBoardFromCardsService,
} from "../cards/service";

export type { Board, BoardData, Card, ColumnType } from "@/db/schema";

import type { Board, BoardData, Card } from "@/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Seed (only if empty)
// ---------------------------------------------------------------------------

const seedCount = db.select({ n: count() }).from(boards).get();
if ((seedCount?.n ?? 0) === 0) {
  const now = new Date().toISOString();
  const b1 = uid();
  const b2 = uid();

  db.insert(boards)
    .values([
      { createdAt: now, id: b1, name: "Project Alpha" },
      { createdAt: now, id: b2, name: "Personal Tasks" },
    ])
    .run();

  db.insert(cards)
    .values([
      {
        boardId: b1,
        column: "backlog",
        createdAt: now,
        description: "The dashboard chart flickers on resize — investigate root cause.",
        id: uid(),
        position: 0,
        title: "Look into render bug in dashboard",
      },
      {
        boardId: b1,
        column: "backlog",
        createdAt: now,
        description: "Review and document all access control policies.",
        id: uid(),
        position: 1,
        title: "SOX compliance checklist",
      },
      {
        boardId: b1,
        column: "backlog",
        createdAt: now,
        description: "Evaluate performance gains of switching from Node to Bun.",
        id: uid(),
        position: 2,
        title: "[SPIKE] Migrate to Bun runtime",
      },
      {
        boardId: b1,
        column: "todo",
        createdAt: now,
        description: "Define REST endpoints and OpenAPI spec for v2.",
        id: uid(),
        position: 0,
        title: "Design API schema",
      },
      {
        boardId: b1,
        column: "todo",
        createdAt: now,
        description: "Wire evlog adapters to Datadog and configure alerts.",
        id: uid(),
        position: 1,
        title: "Set up observability",
      },
      {
        boardId: b1,
        column: "todo",
        createdAt: now,
        description: "Write up the June 3rd incident and action items.",
        id: uid(),
        position: 2,
        title: "Postmortem for outage",
      },
      {
        boardId: b1,
        column: "doing",
        createdAt: now,
        description: "Create reusable drag-and-drop board with framer-motion.",
        id: uid(),
        position: 0,
        title: "Build Kanban UI",
      },
      {
        boardId: b1,
        column: "doing",
        createdAt: now,
        description: "Ensure scheduled tasks emit structured events.",
        id: uid(),
        position: 1,
        title: "Add logging to CRON jobs",
      },
      {
        boardId: b1,
        column: "done",
        createdAt: now,
        description: "Initialize Bun + Elysia + Furin monorepo.",
        id: uid(),
        position: 0,
        title: "Project scaffolding",
      },
      {
        boardId: b1,
        column: "done",
        createdAt: now,
        description: "Lambda listener metrics now visible in Datadog.",
        id: uid(),
        position: 1,
        title: "Set up DD dashboards",
      },
      {
        boardId: b2,
        column: "backlog",
        createdAt: now,
        description: "Learn about Bun.serve, Bun.build and the native test runner.",
        id: uid(),
        position: 0,
        title: "Read Bun docs",
      },
      {
        boardId: b2,
        column: "backlog",
        createdAt: now,
        description: "Understand ISR, SSR and nested layout patterns.",
        id: uid(),
        position: 1,
        title: "Explore Furin routing",
      },
      {
        boardId: b2,
        column: "todo",
        createdAt: now,
        description: "Cover all API endpoints with Bun test.",
        id: uid(),
        position: 0,
        title: "Write integration tests",
      },
      {
        boardId: b2,
        column: "doing",
        createdAt: now,
        description: "Replace prop-drilling with Zustand stores.",
        id: uid(),
        position: 0,
        title: "Refactor context providers",
      },
      {
        boardId: b2,
        column: "done",
        createdAt: now,
        description: "Milk, eggs, coffee, and sourdough bread.",
        id: uid(),
        position: 0,
        title: "Buy groceries",
      },
    ])
    .run();
}

// ---------------------------------------------------------------------------
// Boards queries
// ---------------------------------------------------------------------------

export function getBoards(): Board[] {
  return db.select().from(boards).orderBy(asc(boards.createdAt)).all();
}

export function getBoard(id: string): Board | undefined {
  return db.select().from(boards).where(eq(boards.id, id)).get() ?? undefined;
}

export function createBoard(name: string): Board {
  const board: Board = { createdAt: new Date().toISOString(), id: uid(), name };
  db.insert(boards).values(board).run();
  return board;
}

export function deleteBoard(id: string): boolean {
  const result = db.delete(boards).where(eq(boards.id, id)).returning({ id: boards.id }).all();
  return result.length > 0;
}

export function getBoardData(boardId: string): BoardData | undefined {
  const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
  if (!board) {
    return;
  }
  const boardCards = db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(asc(cards.position))
    .all();
  return { board, cards: boardCards };
}

export const createCard = createCardFromCardsService;
export const getCardsForBoard = getCardsForBoardFromCardsService;

// ---------------------------------------------------------------------------
// Board stats
// ---------------------------------------------------------------------------

export interface BoardStats {
  byColumn: { backlog: number; todo: number; doing: number; done: number };
  completionRate: number;
  total: number;
}

/**
 * Pure aggregator — derives `BoardStats` from an already-loaded card list.
 * Use this when the caller already holds the cards (e.g. the SSR loader
 * that just called `getBoardData`) to avoid a redundant DB roundtrip.
 */
export function computeBoardStats(boardCards: Card[]): BoardStats {
  const byColumn = { backlog: 0, doing: 0, done: 0, todo: 0 };
  for (const card of boardCards) {
    byColumn[card.column as keyof typeof byColumn]++;
  }

  const total = boardCards.length;
  const completionRate = total > 0 ? Math.round((byColumn.done / total) * 100) : 0;

  return { byColumn, completionRate, total };
}

export function getBoardStats(boardId: string): BoardStats | undefined {
  const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
  if (!board) {
    return;
  }

  const boardCards = db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(asc(cards.position))
    .all();

  return computeBoardStats(boardCards);
}

export async function getBoardStatsDeferred(boardId: string): Promise<BoardStats | undefined> {
  await new Promise<void>((resolve) => setTimeout(resolve, 800));
  return getBoardStats(boardId);
}
