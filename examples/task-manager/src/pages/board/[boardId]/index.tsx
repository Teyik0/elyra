import { notFound } from "@teyik0/furin";
import { Await, defer } from "@teyik0/furin/client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { BoardStats } from "@/api/modules/boards/service";
import { getBoardData, getBoardStatsDeferred } from "@/api/modules/boards/service";
import { apiClient } from "@/lib/api";
import { Kanban, type KanbanCard } from "../../../components/ui/kanban";
import { route } from "../_route";

// ---------------------------------------------------------------------------
// Client-side stats refetch via Eden treaty — used after a card mutation to
// pull fresh counts.  Never rejects: resolves to null on error.
//
// (Initial stats are streamed through defer/Await on first paint. Mutations
// still refresh through the API to preserve the existing live-update flow.)
// ---------------------------------------------------------------------------

async function refetchBoardStats(boardId: string): Promise<BoardStats | null> {
  try {
    const { data, error } = await apiClient.api.boards({ boardId }).stats.get();
    if (error) {
      return null;
    }
    return data as BoardStats;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// StatsBar skeleton — flushed in the very first HTML chunk
// ---------------------------------------------------------------------------

function StatsBarSkeleton() {
  return (
    <div className="flex h-9 shrink-0 animate-pulse items-center gap-5 border-white/5 border-b bg-white/1 px-6">
      <div className="h-5 w-20 rounded-full bg-white/8" />
      <div className="h-3 w-px bg-white/8" />
      <div className="flex gap-5">
        {Array.from({ length: 4 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          <div className="h-3 w-14 rounded bg-white/8" key={i} />
        ))}
      </div>
      <div className="h-3 w-px bg-white/8" />
      <div className="h-3 w-20 rounded bg-white/8" />
      <div className="ml-auto h-3 w-32 rounded bg-white/8" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatsBar — receives stats directly as a prop.
// ---------------------------------------------------------------------------

const COLUMN_COLORS = {
  backlog: "text-zinc-400",
  todo: "text-blue-400",
  doing: "text-amber-400",
  done: "text-emerald-400",
} as const;

function StatsBar({ stats }: { stats: BoardStats }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-5 border-white/5 border-b bg-white/1 px-6">
      <div className="flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/8 px-2.5 py-1">
        <span className="size-1.5 rounded-full bg-blue-400" />
        <span className="font-medium text-blue-300 text-xs">SSR</span>
      </div>

      <span className="h-3 w-px bg-white/8" />

      {(["backlog", "todo", "doing", "done"] as const).map((col) => (
        <div className="flex items-center gap-1.5" key={col}>
          <span className="text-xs text-zinc-600 capitalize">{col}</span>
          <span className={`font-bold text-xs ${COLUMN_COLORS[col]}`}>{stats.byColumn[col]}</span>
        </div>
      ))}

      <span className="h-3 w-px bg-white/8" />

      <span className="font-medium text-emerald-400 text-xs">{stats.completionRate}% done</span>

      <span className="ml-auto text-xs text-zinc-700">
        via{" "}
        <code className="rounded bg-white/5 px-1 font-mono text-violet-400 text-xs">loader</code>
      </span>
    </div>
  );
}

export default route.page({
  loader: ({ params }) => {
    const data = getBoardData(params.boardId);
    if (!data) {
      notFound({ message: "Board not found" });
    }

    return defer({
      board: data.board,
      initialCards: data.cards as KanbanCard[],
      initialStats: getBoardStatsDeferred(params.boardId),
      renderedAt: new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    });
  },
  head: ({ board }) => ({
    meta: [{ title: `${board.name} | Task Manager` }],
  }),
  component: ({ board, initialCards, initialStats, renderedAt, params }) => (
    <BoardPageContent
      boardId={params.boardId}
      boardName={board.name}
      initialCards={initialCards}
      initialStats={initialStats}
      key={params.boardId}
      renderedAt={renderedAt}
    />
  ),
});

function BoardPageContent({
  boardId,
  boardName,
  initialCards,
  initialStats,
  renderedAt,
}: {
  boardId: string;
  boardName: string;
  initialCards: KanbanCard[];
  initialStats: Promise<BoardStats | undefined>;
  renderedAt: string;
}) {
  const [stats, setStats] = useState<BoardStats | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refetchTokenRef = useRef(0);

  const onMutation = useCallback(async () => {
    refetchTokenRef.current += 1;
    const myToken = refetchTokenRef.current;
    setIsRefreshing(true);
    try {
      const fresh = await refetchBoardStats(boardId);
      if (myToken !== refetchTokenRef.current) {
        return;
      }
      if (fresh) {
        setStats(fresh);
      }
    } finally {
      if (myToken === refetchTokenRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [boardId]);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14.5 shrink-0 items-center justify-between border-white/5 border-b bg-white/2 px-6 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-linear-to-br from-violet-600 to-purple-600 font-bold text-sm text-white shadow-md">
            {boardName.charAt(0).toUpperCase()}
          </div>
          <h1 className="font-semibold text-lg text-white">{boardName}</h1>
        </div>

        <div className="flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/8 px-3.5 py-1.5">
          <span className="size-1.5 rounded-full bg-blue-400" />
          <span className="font-medium text-blue-300 text-xs">
            SSR &middot; rendered at {renderedAt}
          </span>
        </div>
      </header>

      <StatsBarSection
        initialStats={initialStats}
        isRefreshing={isRefreshing}
        onResolve={setStats}
        stats={stats}
      />

      <div className="flex-1 overflow-hidden">
        <Kanban
          boardId={boardId}
          initialCards={initialCards}
          key={boardId}
          onMutation={onMutation}
        />
      </div>
    </div>
  );
}

function ResolvedInitialStatsBar({
  onResolve,
  stats,
}: {
  onResolve: (stats: BoardStats) => void;
  stats: BoardStats;
}) {
  useEffect(() => {
    onResolve(stats);
  }, [onResolve, stats]);

  return <StatsBar stats={stats} />;
}

function StatsBarSection({
  isRefreshing,
  stats,
  initialStats,
  onResolve,
}: {
  isRefreshing: boolean;
  stats: BoardStats | null;
  initialStats: Promise<BoardStats | undefined>;
  onResolve: (stats: BoardStats) => void;
}) {
  if (isRefreshing) {
    return <StatsBarSkeleton />;
  }

  if (stats) {
    return <StatsBar stats={stats} />;
  }

  return (
    <Suspense fallback={<StatsBarSkeleton />}>
      <Await errorElement={<StatsBarUnavailable />} resolve={initialStats}>
        {(resolvedInitialStats: BoardStats | undefined) => {
          if (resolvedInitialStats) {
            return <ResolvedInitialStatsBar onResolve={onResolve} stats={resolvedInitialStats} />;
          }
          return <StatsBarUnavailable />;
        }}
      </Await>
    </Suspense>
  );
}

function StatsBarUnavailable() {
  return (
    <div className="flex h-9 shrink-0 items-center border-white/5 border-b bg-white/1 px-6">
      <p className="text-xs text-zinc-500">Board stats are temporarily unavailable.</p>
    </div>
  );
}
