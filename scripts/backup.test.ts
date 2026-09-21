import { describe, expect, test } from "bun:test";
import { defaultPath, dumpArgs, looksComplete, toPrune } from "./backup";

test("every part of the connection URL reaches mysqldump", () => {
  const args = dumpArgs(new URL("mysql://joe:s3cret@db.local:3307/lumpy_budget"));
  expect(args).toContain("--host=db.local");
  expect(args).toContain("--port=3307");
  expect(args).toContain("--user=joe");
  expect(args).toContain("--password=s3cret");
  // Self-contained restore, and a snapshot that does not lock the app out.
  expect(args).toContain("--databases");
  expect(args).toContain("--single-transaction");
  expect(args.at(-1)).toBe("lumpy_budget");
});

test("no password in the URL means no --password flag at all", () => {
  // `--password=` would mean the empty password and break a passwordless root.
  expect(dumpArgs(new URL("mysql://root@127.0.0.1:3306/lumpy_budget")).join(" ")).not.toContain("--password");
});

test("a missing port falls back to 3306 rather than an empty flag", () => {
  expect(dumpArgs(new URL("mysql://root@127.0.0.1/lumpy_budget"))).toContain("--port=3306");
});

test("a percent-encoded password is decoded before it is passed on", () => {
  expect(dumpArgs(new URL("mysql://root:p%40ss%3Aword@127.0.0.1:3306/lumpy_budget"))).toContain("--password=p@ss:word");
});

test("a database name that is not an identifier is refused, not shell-escaped", () => {
  expect(() => dumpArgs(new URL("mysql://root@127.0.0.1:3306/lumpy;DROP"))).toThrow(/bad database name/);
});

test("the default filename sorts chronologically and is legal on every filesystem", () => {
  const p = defaultPath("lumpy_budget", new Date("2026-03-15T14:30:05.123Z"));
  expect(p.endsWith("lumpy_budget-2026-03-15T14-30-05.sql")).toBe(true);
  expect(p).not.toContain(":");
});

test("a file that is not a finished dump is rejected however plausible it looks", () => {
  // The bug this exists for: 23 bytes, exit code 0, and no schema in it at all.
  expect(looksComplete("[object ReadableStream]")).toBe(false);
  expect(looksComplete("CREATE TABLE `expenses` (...);\n")).toBe(false);
  expect(looksComplete("-- Dump completed on 2026-03-15 14:30:05\n")).toBe(true);
});

describe("toPrune", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  // A dump `daysAgo` days before now, named exactly as defaultPath names it.
  const dump = (daysAgo: number) => defaultPath("lumpy_budget", new Date(now.getTime() - daysAgo * 86_400_000)).split("/").at(-1)!;

  test("deletes a dump past 30 days once seven newer ones exist", () => {
    const names = [1, 2, 3, 4, 5, 6, 7, 31, 45].map(dump);
    expect(toPrune(names, "lumpy_budget", now).sort()).toEqual([dump(31), dump(45)].sort());
  });

  test("keeps everything younger than 30 days, however many there are", () => {
    // The retry storm: a failed deploy dumping every five minutes for a day.
    const burst = Array.from({ length: 288 }, (_, i) => dump(i / 288));
    const names = [...burst, dump(10), dump(29)];
    expect(toPrune(names, "lumpy_budget", now)).toEqual([]);
  });

  test("keeps the newest seven even when every one of them is old", () => {
    // A server that stopped backing up a long time ago still has its last week.
    const names = [100, 101, 102, 103, 104, 105, 106, 107, 108].map(dump);
    expect(toPrune(names, "lumpy_budget", now).sort()).toEqual([dump(107), dump(108)].sort());
  });

  test("never touches a file defaultPath could not have written", () => {
    const names = [
      "before-migration-019.sql",
      "lumpy_budget-2020-01-01.sql",
      "other_db-2020-01-01T00-00-00.sql",
      "lumpy_budget-2020-01-01T00-00-00.sql.gz",
      "lumpy_budget-2020-13-45T00-00-00.sql", // not a real date
      ...[1, 2, 3, 4, 5, 6, 7].map(dump),
    ];
    expect(toPrune(names, "lumpy_budget", now)).toEqual([]);
  });

  test("reads the age off the name, in UTC, the way defaultPath writes it", () => {
    // Exactly on the cutoff is kept; one second past it is not.
    const recent = [1, 2, 3, 4, 5, 6, 7].map(dump);
    const edge = "lumpy_budget-2026-08-22T12-00-00.sql";
    const past = "lumpy_budget-2026-08-22T11-59-59.sql";
    expect(toPrune([...recent, edge, past], "lumpy_budget", now)).toEqual([past]);
  });
});
