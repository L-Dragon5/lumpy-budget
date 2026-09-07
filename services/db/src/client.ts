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
  return row as T;
}
type TableSpecLoose = { bool?: string[]; num?: string[]; json?: string[]; date?: string[] };

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
