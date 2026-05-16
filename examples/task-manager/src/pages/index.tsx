import { Link } from "@teyik0/furin/link";
import { useState } from "react";
import type { Board } from "@/api/modules/boards/service";
import { getBoards } from "@/api/modules/boards/service";
import { apiClient } from "@/lib/api";
import { route } from "./root";

const AVATAR_COLORS = [
  "from-violet-500 to-indigo-500",
  "from-blue-500 to-cyan-500",
  "from-emerald-500 to-teal-500",
  "from-rose-500 to-pink-500",
  "from-amber-500 to-orange-500",
  "from-fuchsia-500 to-purple-500",
];

function avatarColor(id: string): string {
  const idx = id.charCodeAt(0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx] ?? (AVATAR_COLORS[0] as string);
}

export default route.page({
  mode: "isr",
  revalidate: 10,
  loader: () => {
    const rawBoards = getBoards();
    const generatedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const boards = rawBoards.map((board) => ({
      ...board,
      formattedCreatedAt: new Date(board.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }),
    }));
    return { boards, generatedAt, test: "tert" };
  },
  head: () => ({
    meta: [{ title: "Task Manager — Furin" }],
  }),
  component: ({ boards, generatedAt }) => {
    return (
      <div className="mx-auto max-w-5xl px-6 py-14">
        {/* Header */}
        <header className="mb-12">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1">
            <span className="text-violet-400 text-xs">⚡</span>
            <span className="font-medium text-violet-300 text-xs">Furin Framework</span>
          </div>

          <h1 className="font-semibold text-5xl tracking-tight">
            <span className="bg-linear-to-br from-violet-400 via-purple-400 to-sky-400 bg-clip-text text-transparent">
              Task Managerd
            </span>
          </h1>

          <p className="mt-3 max-w-lg text-base text-zinc-400">
            A Trello-inspired board powered by Furin: featuring ISR, SSR, nested layouts and
            drag-and-drop kanban.
          </p>

          {/* ISR badge */}
          <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/8 px-3.5 py-1.5">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            <span className="font-medium text-emerald-400 text-xs">
              ISR &middot; revalidates every 10s &middot; generated at {generatedAt}
            </span>
          </div>
        </header>

        {/* Create board form */}
        <CreateBoardForm />

        {/* Boards grid */}
        {boards.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 border-dashed py-20 text-center">
            <div className="mb-3 text-4xl opacity-30">📋</div>
            <p className="text-sm text-zinc-500">No boards yet.</p>
            <p className="mt-1 text-xs text-zinc-600">Create one above to get started.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <BoardCard board={board} key={board.id} />
            ))}
          </div>
        )}

        {/* Footer info */}
        <div className="mt-16 flex items-start gap-3 rounded-xl border border-white/5 bg-white/3 p-4">
          <span className="mt-0.5 text-sm text-violet-400">ℹ</span>
          <p className="text-xs text-zinc-500 leading-relaxed">
            This page uses{" "}
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
              mode: "isr"
            </code>{" "}
            with{" "}
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
              revalidate: 10
            </code>
            . The board list is served from cache and revalidates in the background every 10
            seconds. After creating or deleting a board,{" "}
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
              revalidatePath("/", "page")
            </code>{" "}
            is called server-side to immediately bust the cache.
          </p>
        </div>
      </div>
    );
  },
});

function CreateBoardForm() {
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const { error } = await apiClient.api.boards.post({ name: trimmed });
      if (error) {
        throw new Error("Could not create the board. Please try again.");
      }
      setName("");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not create the board. Please try again.";
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mb-10 flex flex-col gap-3">
      <div className="flex gap-3">
        <div className="relative flex-1">
          <input
            className="w-full rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-zinc-600 focus:border-violet-500/40 focus:bg-white/6 focus:ring-1 focus:ring-violet-500/20 disabled:opacity-50"
            disabled={isSubmitting}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your new board..."
            type="text"
            value={name}
          />
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-3 font-semibold text-sm text-white transition-all hover:bg-violet-500 hover:shadow-lg hover:shadow-violet-500/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isSubmitting}
          onClick={handleCreate}
          type="button"
        >
          <span>+</span>
          <span>{isSubmitting ? "Creating…" : "Create Board"}</span>
        </button>
      </div>
      {errorMessage ? (
        <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-red-300 text-sm">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}

function BoardCard({ board }: { board: Board & { formattedCreatedAt: string } }) {
  const gradient = avatarColor(board.id);
  const initial = board.name.charAt(0).toUpperCase();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleDelete = async () => {
    try {
      const { error } = await apiClient.api.boards({ boardId: board.id }).delete();
      if (error) {
        throw new Error("Could not delete the board. Please try again.");
      }
      setErrorMessage(null);
    } catch (err: unknown) {
      const error =
        err instanceof Error ? err.message : "Could not delete the board. Please try again.";
      setErrorMessage(error);
    }
  };

  return (
    <div className="group relative rounded-2xl border border-white/8 bg-white/3 transition-all duration-200 hover:border-violet-500/30 hover:bg-white/5 hover:shadow-violet-500/5 hover:shadow-xl">
      {/* Delete button */}
      <div className="absolute top-3 right-3 z-10 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          className="flex size-6 items-center justify-center rounded-full bg-white/8 text-white/40 text-xs transition-colors hover:bg-red-500/20 hover:text-red-400"
          onClick={handleDelete}
          title="Delete board"
          type="button"
        >
          ×
        </button>
      </div>

      <Link className="block p-5" to={`/board/${board.id}`}>
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br ${gradient} font-bold text-sm text-white shadow-md`}
          >
            {initial}
          </div>

          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold text-base text-white transition-colors group-hover:text-violet-200">
              {board.name}
            </h2>
            {errorMessage ? <p className="mt-1 text-red-300 text-xs">{errorMessage}</p> : null}
            <p className="mt-0.5 text-xs text-zinc-600">Created {board.formattedCreatedAt}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1.5">
            {(["backlog", "todo", "doing", "done"] as const).map((col) => (
              <span
                className="rounded-md bg-white/5 px-2 py-0.5 font-medium text-xs text-zinc-600 capitalize"
                key={col}
              >
                {col}
              </span>
            ))}
          </div>
          <span className="text-xs text-zinc-700">→</span>
        </div>
      </Link>
    </div>
  );
}
