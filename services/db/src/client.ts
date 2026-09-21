import { SQL } from "bun";
import { TABLES, isTable, type TableName } from "./tables";

const url = process.env.DATABASE_URL ?? "mysql://root@127.0.0.1:3306/lumpy_budget";
export const sql = new SQL(url);
export const databaseName = (): string => new URL(url).pathname.replace(/^\//, "");

/** Identifiers are never parameterizable, so they only ever come from this whitelist. */
const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`refusing unsafe identifier: ${name}`);
  return `\`${name}\``;
};

/** `id, name, DATE_FORMAT(txn_date,'%Y-%m-%d') AS txn_date, ...` */
export function selectList(table: TableName): string {
  const spec = TABLES[table];
  const dates = new Set<string>((spec as { date?: string[] }).date ?? []);
  return spec.cols
    .map((c) => (dates.has(c) ? `DATE_FORMAT(${ident(c)}, '%Y-%m-%d') AS ${ident(c)}` : ident(c)))
    .join(", ");
}

export function coerce<T>(table: TableName, row: Record<string, unknown>): T {
  const spec = TABLES[table] as TableSpecLoose;
  for (const c of spec.bool ?? []) if (row[c] !== null && row[c] !== undefined) row[c] = Boolean(row[c]);
  for (const c of spec.num ?? []) if (row[c] !== null && row[c] !== undefined) row[c] = Number(row[c]);
  for (const c of spec.json ?? []) {
    const v = row[c];
    if (typeof v === "string") row[c] = JSON.parse(v);
  }
  for (const c of spec.date ?? []) {
    // Belt and braces: if a query ever forgets DATE_FORMAT, still emit YYYY-MM-DD.
    const v = row[c];
    if (v instanceof Date) row[c] = v.toISOString().slice(0, 10);
  }
  for (const c of spec.datetime ?? []) {
    // A TIMESTAMP keeps its time, so it becomes a full ISO string rather than a
    // date. Converted here rather than in SQL: the driver has already resolved
    // the instant, while DATE_FORMAT would stamp a 'Z' on a session-local time.
    const v = row[c];
    if (v instanceof Date) row[c] = v.toISOString();
  }
  return row as T;
}
type TableSpecLoose = { bool?: string[]; num?: string[]; json?: string[]; date?: string[]; datetime?: string[] };

export type Executor = Pick<typeof sql, "unsafe">;

export async function rows<T>(table: TableName, where = "", params: unknown[] = [], db: Executor = sql): Promise<T[]> {
  const q = `SELECT ${selectList(table)} FROM ${ident(table)} ${where ? `WHERE ${where}` : ""} ORDER BY ${TABLES[table].order}`;
  const out = (await db.unsafe(q, params)) as Record<string, unknown>[];
  return out.map((r) => coerce<T>(table, r));
}

export async function byId<T>(table: TableName, id: number, db: Executor = sql): Promise<T | null> {
  const out = await rows<T>(table, "id = ?", [id], db);
  return out[0] ?? null;
}

/** Values are always parameterized; only the column names come from the spec. */
export async function insert(table: TableName, data: Record<string, unknown>, db: Executor = sql): Promise<number> {
  const cols = TABLES[table].cols.filter((c) => c !== "id" && c in data);
  if (cols.length === 0) throw new Error(`insert into ${table}: nothing to write`);
  const q = `INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  const res = (await db.unsafe(q, cols.map((c) => serialize(data[c])))) as unknown as { lastInsertRowid: number };
  return Number(res.lastInsertRowid);
}

/**
 * Many rows at once, written with the `id` they came with. That is the whole
 * trick behind restoring a backup: keep the primary keys and every foreign key
 * in the file still points at the record it pointed at when it was exported, so
 * there is no id-remapping pass to get wrong.
 *
 * Columns come from the table spec, not from the row, so an unknown key in the
 * file cannot reach the database. A missing one is written as NULL, which is a
 * constraint error on a NOT NULL column -- loud, inside the caller's
 * transaction, rather than a row that quietly restores wrong.
 */
export async function bulkInsert(table: TableName, data: Record<string, unknown>[], db: Executor = sql): Promise<number> {
  if (data.length === 0) return 0;
  const spec = TABLES[table] as TableSpecLoose & { cols: string[] };
  const datetimes = new Set(spec.datetime ?? []);
  const cols = spec.cols;
  const placeholders = `(${cols.map((c) => (datetimes.has(c) ? AT_UTC : "?")).join(", ")})`;
  for (let i = 0; i < data.length; i += 200) {
    const chunk = data.slice(i, i + 200);
    const q = `INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")}) VALUES ${chunk.map(() => placeholders).join(", ")}`;
    await db.unsafe(
      q,
      chunk.flatMap((r) => cols.map((c) => (datetimes.has(c) ? utcWall(r[c]) : serialize(r[c] ?? null)))),
    );
  }
  return data.length;
}

/**
 * Every clock in SQL names its zone, because the session's zone belongs to the
 * driver. Bun 1.3 left a MySQL session on SYSTEM; Bun 1.4 sets `time_zone =
 * '+00:00'` on every connection it opens, reconnects included, and there is no
 * option to change it (oven-sh/bun#40254). A TIMESTAMP is stored as UTC either
 * way, so the rows are fine -- what moves is any SQL that turns one into a
 * calendar day or a wall time, which then answers in whichever zone the driver
 * picked. Both helpers below give the same answer under either session.
 *
 * AT_UTC is the write side: the value goes over as a UTC wall time and the
 * database converts it into whatever the session is, so the stored instant is
 * the one the export recorded. The version this replaced formatted the value
 * with getHours(), on the process clock, which was right only while the session
 * was also on the process clock -- a restore on Bun 1.4 moved every created_at
 * back by the UTC offset.
 */
const AT_UTC = "CONVERT_TZ(?, '+00:00', @@session.time_zone)";

/** An ISO instant (what `coerce` emits for a TIMESTAMP) as a UTC wall time. */
export function utcWall(v: unknown): unknown {
  if (typeof v !== "string" && !(v instanceof Date)) return v;
  const d = new Date(v);
  // Left as-is: CONVERT_TZ turns garbage into NULL, and a NOT NULL column then
  // refuses it out loud instead of storing a guess.
  if (Number.isNaN(d.getTime())) return v;
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The calendar day a TIMESTAMP falls on, on the database machine's clock -- the
 * clock the DATE columns were written on. Not DATE(col): under Bun 1.4 that is
 * the UTC day, so a balance typed at 8pm local reads as typed tomorrow and the
 * rest of today's spending drops out of it. `col` is SQL from this codebase,
 * never a request, and is checked to be a (qualified) column name anyway.
 */
export function localDate(col: string): string {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(col)) throw new Error(`refusing unsafe column: ${col}`);
  return `DATE(CONVERT_TZ(${col}, @@session.time_zone, 'SYSTEM'))`;
}

export async function update(table: TableName, id: number, data: Record<string, unknown>, db: Executor = sql): Promise<number> {
  const cols = TABLES[table].cols.filter((c) => c !== "id" && c in data);
  if (cols.length === 0) return 0;
  const q = `UPDATE ${ident(table)} SET ${cols.map((c) => `${ident(c)} = ?`).join(", ")} WHERE id = ?`;
  const res = (await db.unsafe(q, [...cols.map((c) => serialize(data[c])), id])) as unknown as { affectedRows: number };
  return Number(res.affectedRows ?? 0);
}

export async function remove(table: TableName, id: number, db: Executor = sql): Promise<number> {
  const res = (await db.unsafe(`DELETE FROM ${ident(table)} WHERE id = ?`, [id])) as unknown as { affectedRows: number };
  return Number(res.affectedRows ?? 0);
}

const serialize = (v: unknown): unknown =>
  v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;

export { TABLES, isTable, ident };
export type { TableName };
