import { expect, test } from "bun:test";
import { defaultPath, dumpArgs, looksComplete } from "./backup";

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
