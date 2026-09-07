#!/usr/bin/env bun
import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Numbered .sql files, applied in order, recorded in _migrations. No ORM, no
 * rollback machinery: forward-only, which is all a single-user app ever needs.
 * ponytail: add a `down` half the day a migration actually needs reverting.
 */
const dir = join(import.meta.dir, "..", "migrations");

export async function migrate(url = process.env.DATABASE_URL ?? "mysql://root@127.0.0.1:3306/lumpy_budget") {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) throw new Error(`bad database name: ${dbName}`);

  // Bootstrap through the `mysql` system database so a fresh machine works from
  // zero. A URL with no database at all makes Bun fall back to its postgres adapter.
  const rootUrl = new URL(url);
  rootUrl.pathname = "/mysql";
  const root = new SQL(rootUrl.toString());
  await root.unsafe(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4`);
  await root.end();

  const sql = new SQL(url);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS _migrations (
       filename VARCHAR(255) NOT NULL PRIMARY KEY,
       applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`,
  );
  const done = new Set(
    ((await sql.unsafe("SELECT filename FROM _migrations")) as { filename: string }[]).map((r) => r.filename),
  );

  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const body = readFileSync(join(dir, file), "utf8");
    for (const stmt of splitStatements(body)) await sql.unsafe(stmt);
    await sql.unsafe("INSERT INTO _migrations (filename) VALUES (?)", [file]);
    applied.push(file);
  }
  await sql.end();
  return { database: dbName, applied, skipped: files.length - applied.length };
}

/**
 * Splits a .sql file into statements. Walks the string rather than splitting on
 * ";" because a trailing `-- comment; like this` would otherwise cut a CREATE
 * TABLE in half, which is exactly what it did the first time.
 */
export function splitStatements(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") { cur += body[++i] ?? ""; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; cur += c; continue; }
    if (c === "-" && body[i + 1] === "-") { while (i < body.length && body[i] !== "\n") i++; continue; }
    if (c === "/" && body[i + 1] === "*") { i = body.indexOf("*/", i + 2) + 1; continue; }
    if (c === ";") { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

if (import.meta.main) {
  const result = await migrate();
  console.log(
    result.applied.length
      ? `migrated ${result.database}: applied ${result.applied.join(", ")}`
      : `migrated ${result.database}: already up to date (${result.skipped} files)`,
  );
}
