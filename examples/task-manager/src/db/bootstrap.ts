import type { Database } from "bun:sqlite";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { boards, cards } from "./schema";

interface RuntimeSQLiteColumn extends SQLiteColumn {
  default: unknown;
  enumValues: string[] | undefined;
  getSQLType(): string;
  hasDefault: boolean;
  name: string;
  notNull: boolean;
  primary: boolean;
}

export function ensureTaskManagerSchema(sqlite: Database): void {
  sqlite.run(createTableStatement(boards));
  sqlite.run(createTableStatement(cards));
}

function createTableStatement(table: SQLiteTable): string {
  const config = getTableConfig(table);
  const columnDefinitions = config.columns.map((column) =>
    createColumnDefinition(column as RuntimeSQLiteColumn)
  );
  const foreignKeyDefinitions = config.foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    const sourceColumns = reference.columns
      .map((column) => quoteIdentifier(column.name))
      .join(", ");
    const targetColumns = reference.foreignColumns
      .map((column) => quoteIdentifier(column.name))
      .join(", ");
    const targetTable = getTableConfig(reference.foreignTable).name;
    const clauses = [
      `foreign key (${sourceColumns}) references ${quoteIdentifier(targetTable)}(${targetColumns})`,
    ];

    if (foreignKey.onUpdate !== undefined) {
      clauses.push(`on update ${foreignKey.onUpdate}`);
    }
    if (foreignKey.onDelete !== undefined) {
      clauses.push(`on delete ${foreignKey.onDelete}`);
    }

    return clauses.join(" ");
  });

  return `create table if not exists ${quoteIdentifier(config.name)} (${[
    ...columnDefinitions,
    ...foreignKeyDefinitions,
  ].join(", ")})`;
}

function createColumnDefinition(column: RuntimeSQLiteColumn): string {
  const clauses = [quoteIdentifier(column.name), column.getSQLType()];

  if (column.primary) {
    clauses.push("primary key");
  } else if (column.notNull) {
    clauses.push("not null");
  }

  if (column.hasDefault) {
    clauses.push(`default ${formatDefaultValue(column.default)}`);
  }

  if (column.enumValues !== undefined && column.enumValues.length > 0) {
    const values = column.enumValues.map(formatDefaultValue).join(", ");
    clauses.push(`check (${quoteIdentifier(column.name)} in (${values}))`);
  }

  return clauses.join(" ");
}

function formatDefaultValue(value: unknown): string {
  if (typeof value === "string") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (value === null) {
    return "null";
  }
  throw new Error("Unsupported SQLite default value in task-manager schema");
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
