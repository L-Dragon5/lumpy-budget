#!/usr/bin/env bun
/**
 * A real backup: mysqldump to a timestamped .sql file that restores on its own.
 *
 * /api/export hands you the data as JSON, which is readable and portable but not
 * a restore path. This is the one you run before a migration, and the one that
 * gets you back to a working database on a new machine.
 *
 * Run:  bun run backup            -> ~/lumpy-backups/lumpy_budget-<stamp>.sql
 *       bun run backup out.sql    -> that path instead
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Exported and tested on its own: the arguments are the part that can be silently
 * wrong (a dropped port, a password that never reaches the client) and the spawn
 * is the part a unit test cannot honestly cover.
 */
export function dumpArgs(url: URL): string[] {
  const db = url.pathname.replace(/^\//, "");
  if (!/^[a-zA-Z0-9_]+$/.test(db)) throw new Error(`bad database name: ${db}`);
  return [
    `--host=${url.hostname}`,
    `--port=${url.port || "3306"}`,
    `--user=${decodeURIComponent(url.username) || "root"}`,
    // Only when there is one: an empty --password= means "the empty password",
    // not "no password", and would break a passwordless local root.
    ...(url.password ? [`--password=${decodeURIComponent(url.password)}`] : []),
    // Consistent snapshot without locking the app out mid-dump.
    "--single-transaction",
    // --databases, not the bare name, so the dump carries its own CREATE DATABASE.
    "--databases",
    db,
  ];
}

/**
 * mysqldump signs off with a "Dump completed" line, so its absence means the file
 * is not a backup however plausible its size. Checked because the first version of
 * this script wrote the literal string "[object ReadableStream]", 23 bytes, and
 * exited 0: a byte-count check called that a success.
 */
export const looksComplete = (tail: string): boolean => /Dump completed/i.test(tail);

export const defaultPath = (db: string, now = new Date()): string =>
  join(process.env.HOME ?? ".", "lumpy-backups", `${db}-${now.toISOString().slice(0, 19).replace(/[:]/g, "-")}.sql`);

if (import.meta.main) {
  const url = new URL(process.env.DATABASE_URL ?? "mysql://root@127.0.0.1:3306/lumpy_budget");
  const db = url.pathname.replace(/^\//, "");
  const out = process.argv[2] ?? defaultPath(db);
  mkdirSync(dirname(out), { recursive: true });

  let proc;
  try {
    // Straight into the file. Bun 1.3.10 hangs forever on Bun.write(path, new
    // Response(stream)), and writing the raw ReadableStream stringifies it to the
    // literal "[object ReadableStream]", so neither of the tidier spellings works.
    proc = Bun.spawn(["mysqldump", ...dumpArgs(url)], { stdout: Bun.file(out), stderr: "pipe" });
  } catch {
    console.error("mysqldump not found. Install the MariaDB or MySQL client tools:\n  brew install mariadb");
    process.exit(1);
  }

  const code = await proc.exited;
  const err = await new Response(proc.stderr).text();
  const bytes = Bun.file(out).size;
  // Explicit offsets: BunFile.slice(-200) returns nothing in Bun 1.3.10, unlike Blob.
  const tail = await Bun.file(out).slice(Math.max(0, bytes - 200), bytes).text();

  // mysqldump warns about passwords on stderr and still succeeds, so the exit
  // code decides -- but only alongside proof the dump actually finished.
  if (code !== 0 || !looksComplete(tail)) {
    console.error(err.trim() || `mysqldump exited ${code}`);
    console.error(`\nbackup failed, ${out} is not usable`);
    process.exit(1);
  }

  const mb = (bytes / 1_000_000).toFixed(2);
  console.log(`backed up ${db} -> ${out} (${mb} MB)`);
  console.log(`restore with:\n  mysql --host=${url.hostname} --port=${url.port || "3306"} --user=${decodeURIComponent(url.username) || "root"} < ${out}`);
}
