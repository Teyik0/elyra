import { notFound } from "@teyik0/furin";
import { useCallback, useRef, useState } from "react";
import type { BoardStats } from "@/api/modules/boards/service";
import { computeBoardStats, getBoardData } from "@/api/modules/boards/service";
import { apiClient } from "@/lib/api";
import { Kanban, type KanbanCard } from "../../../components/ui/kanban";
import { route } from "../_route";

// ---------------------------------------------------------------------------
// Client-side stats refetch via Eden treaty — used after a card mutation to
// pull fresh counts.  Never rejects: resolves to null on error.
//
// (Initial stats are computed server-side in the loader and shipped through
// the SSR payload — no client fetch on first paint, no double work.)
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
// StatsBar — receives stats directly as a prop.  Stats are computed in the
// loader (server-side, single round-trip, no double fetch on hydration).
// ---------------------------------------------------------------------------

const COLUMN_COLORS = {
  backlog: "text-slate-400",
  todo: "text-blue-400",
  doing: "text-amber-400",
  done: "text-emerald-400",
} as const;

function StatsBar({ stats }: { stats: BoardStats }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-5 border-white/5 border-b bg-white/1 px-6">
      {/* SSR badge — stats arrived in the loader payload, no client fetch on first paint */}
      <div className="flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/8 px-2.5 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
        <span className="font-medium text-blue-300 text-xs">SSR</span>
      </div>

      <span className="h-3 w-px bg-white/8" />

      {/* Per-column counts */}
      {(["backlog", "todo", "doing", "done"] as const).map((col) => (
        <div className="flex items-center gap-1.5" key={col}>
          <span className="text-slate-600 text-xs capitalize">{col}</span>
          <span className={`font-bold text-xs ${COLUMN_COLORS[col]}`}>{stats.byColumn[col]}</span>
        </div>
      ))}

      <span className="h-3 w-px bg-white/8" />

      {/* Completion */}
      <span className="font-medium text-emerald-400 text-xs">{stats.completionRate}% done</span>

      {/* Subtle label */}
      <span className="ml-auto text-slate-700 text-xs">
        via{" "}
        <code className="rounded bg-white/5 px-1 font-mono text-violet-400 text-xs">loader</code>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default route.page({
  loader: ({ params }) => {
    const data = getBoardData(params.boardId);
    if (!data) {
      notFound({ message: "Board not found" });
    }
    // Stats are computed server-side from the cards we already loaded —
    // no second DB roundtrip — and shipped through __FURIN_DATA__.
    // No client fetch on first paint, no double-fetch on hydration.
    const initialStats = computeBoardStats(data.cards);
    const renderedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return {
      board: data.board,
      initialCards: data.cards as KanbanCard[],
      initialStats,
      renderedAt,
    };
  },
  head: ({ board }) => ({
    meta: [{ title: `${board.name} | Task Manager` }],
  }),
  component: ({ board, initialCards, initialStats, renderedAt, params }) => {
    const [stats, setStats] = useState<BoardStats>(initialStats);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [prevBoardId, setPrevBoardId] = useState(params.boardId);
    // Monotonic request token — bumped on board change AND at the start of
    // every mutation refetch.  Stale in-flight refetches (started against a
    // previous board, or before another mutation kicked off) compare their
    // captured token to the current one and discard their result if it has
    // moved on.  Prevents a "Board A's stats land on Board B" race after fast
    // SPA navigation — and a "stale mutation overwrites fresh mutation" race.
    const refetchTokenRef = useRef(0);
    if (prevBoardId !== params.boardId) {
      setPrevBoardId(params.boardId);
      setStats(initialStats);
      setIsRefreshing(false);
      refetchTokenRef.current += 1;
    }

    const onMutation = useCallback(async () => {
      refetchTokenRef.current += 1;
      const myToken = refetchTokenRef.current;
      setIsRefreshing(true);
      try {
        const fresh = await refetchBoardStats(params.boardId);
        // Discard the result if the user has navigated away or another
        // mutation has fired in the meantime — the latest token wins.
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
    }, [params.boardId]);

    return (
      <div className="flex h-screen flex-col">
        {/* Board header */}
        <header className="flex h-14.5 shrink-0 items-center justify-between border-white/5 border-b bg-white/2 px-6 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-violet-600 to-indigo-600 font-bold text-sm text-white shadow-md">
              {board.name.charAt(0).toUpperCase()}
            </div>
            <h1 className="font-semibold text-lg text-white">{board.name}</h1>
          </div>

          {/* SSR badge */}
          <div className="flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/8 px-3.5 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            <span className="font-medium text-blue-300 text-xs">
              SSR &middot; rendered at {renderedAt}
            </span>
          </div>
        </header>

        {/* Stats strip — initial render uses server-computed stats; on each
            mutation we briefly show the skeleton while refetching. */}
        {isRefreshing ? <StatsBarSkeleton /> : <StatsBar stats={stats} />}

        {/* Kanban board — key forces remount when board changes so useState resets */}
        <div className="flex-1 overflow-hidden">
          <Kanban
            boardId={params.boardId}
            initialCards={initialCards}
            key={params.boardId}
            onMutation={onMutation}
          />
        </div>
      </div>
    );
  },
});
