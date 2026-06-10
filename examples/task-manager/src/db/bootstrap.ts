import type { Database } from "bun:sqlite";

export function ensureTaskManagerSchema(sqlite: Database): void {
  sqlite.run(`
    create table if not exists boards (
      id text primary key,
      name text not null,
      created_at text not null
    )
  `);

  sqlite.run(`
    create table if not exists cards (
      id text primary key,
      board_id text not null references boards(id) on delete cascade,
      column text not null check (column in ('backlog', 'todo', 'doing', 'done')),
      title text not null,
      description text not null default '',
      position integer not null default 0,
      created_at text not null
    )
  `);
}
