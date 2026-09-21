#!/usr/bin/env bun
/**
 * A real backup: mysqldump to a timestamped .sql file that restores on its own.
 *
 * /api/export hands you the data as JSON, which is readable and portable but not
 * a restore path. This is the one you run before a migration, and the one that
 * gets you back to a working database on a new machine.
 *
 * Run:  bun run backup            -> ~/lumpy-backups/lumpy_budget-<stamp>.sql
 *       bun run backup out.sql    -> that path instead, and nothing is pruned
 *
 * A default-path run prunes the folder after the dump is proven complete: see
 * `toPrune`. A failed dump deletes nothing, so it can never cost the last good one.
 */
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
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

/**
 * Which of `names` (a directory listing) to delete: a dump is kept while it is
 * younger than `maxAgeDays`, and the newest `keepAtLeast` are kept whatever their
 * age, so a server that stopped backing up a year ago still has its last week.
 *
 * Age, not a count. Komodo's deploy Action retries a failed deploy every five
 * minutes and each retry dumps first; "keep the last 30" would let a bad
 * afternoon push out every backup older than two and a half hours. By age, a
 * burst costs disk (a dump is a few hundred KB) and never history.
 *
 * Only names `defaultPath` could have written are candidates: a dump somebody
 * named by hand, or any other file in the folder, is never touched. The stamp is
 * read off the name rather than the file's mtime, because a copy or a restore
 * from elsewhere resets mtime and would make an old dump look new.
 */
export function toPrune(names: string[], db: string, now: Date, maxAgeDays = 30, keepAtLeast = 7): string[] {
  const shape = new RegExp(`^${db}-(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})\\.sql$`);
  const dated = names.flatMap((name) => {
    const m = shape.exec(name);
    const at = m && Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    return at ? [{ name, at }] : [];
  });
  // Names sort chronologically (backup.test.ts pins it), so newest-first is a string sort.
  dated.sort((a, b) => (a.name < b.name ? 1 : -1));
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  return dated.slice(keepAtLeast).filter((d) => d.at < cutoff).map((d) => d.name);
}

if (import.meta.main) {
  const url = new URL(process.env.DATABASE_URL ?? "mysql://root@127.0.0.1:3306/lumpy_budget");
  const db = url.pathname.replace(/^\//, "");
  const named = process.argv[2];
  const out = named ?? defaultPath(db);
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

  if (!named) {
    const dir = dirname(out);
    const gone = toPrune(readdirSync(dir), db, new Date());
    for (const name of gone) unlinkSync(join(dir, name));
    if (gone.length) console.log(`pruned ${gone.length} dump(s) older than 30 days: ${gone.join(", ")}`);
  }
  console.log(`restore with:\n  mysql --host=${url.hostname} --port=${url.port || "3306"} --user=${decodeURIComponent(url.username) || "root"} < ${out}`);
}
