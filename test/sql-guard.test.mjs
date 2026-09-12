import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "format-staged.mjs");
const NM = "/Users/starlight/code/orlidating/repos/compatibility/node_modules";

function repoWithSql(sql) {
  const dir = mkdtempSync(path.join(tmpdir(), "sqlguard-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
  try { symlinkSync(NM, path.join(dir, "node_modules")); } catch {}
  mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
  const f = path.join(dir, "supabase", "migrations", "0010_t.sql");
  writeFileSync(f, sql);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return { dir, f };
}

function run(dir) {
  try {
    return { code: 0, out: execFileSync("node", [BIN], { cwd: dir, encoding: "utf8", stdio: "pipe" }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("an apostrophe in a comment does not desynchronise literal parsing", () => {
  // The exact shape that broke backend#75: English prose with a possessive.
  const sql = [
    "-- Telling those roles apart is the policies' job, not the grant's.",
    "create   function private.f () returns boolean language sql",
    "security definer set search_path = '' as $$ select true $$;",
    "",
  ].join("\n");
  const { dir, f } = repoWithSql(sql);
  const { out } = run(dir);
  assert.doesNotMatch(out, /altered a string literal/);
  assert.doesNotMatch(out, /continued across a newline/);
  // and it actually reformatted, rather than passing by refusing
  assert.notEqual(readFileSync(f, "utf8"), sql);
  rmSync(dir, { recursive: true, force: true });
});

test("genuine string continuation is still refused", () => {
  const sql = "comment on schema private is 'one '\n'two';\n";
  const { dir, f } = repoWithSql(sql);
  const { out } = run(dir);
  assert.match(out, /continued across a newline/);
  assert.equal(readFileSync(f, "utf8"), sql); // untouched
  rmSync(dir, { recursive: true, force: true });
});

test("an apostrophe in a block comment is also ignored", () => {
  const sql = "/* the owner's rows */\ncreate   table t (id  int);\n";
  const { dir } = repoWithSql(sql);
  const { out } = run(dir);
  assert.doesNotMatch(out, /altered a string literal|continued across/);
  rmSync(dir, { recursive: true, force: true });
});

test("a quoted identifier containing a quote does not confuse the scan", () => {
  const sql = `create   table "odd''name" (id  int);\n`;
  const { dir } = repoWithSql(sql);
  const { out } = run(dir);
  assert.doesNotMatch(out, /altered a string literal|continued across/);
  rmSync(dir, { recursive: true, force: true });
});

test("dollar-quoted bodies survive formatting", () => {
  const sql = "create   function f () returns int language plpgsql as $$\nbegin\n  return 1;\nend\n$$;\n";
  const { dir } = repoWithSql(sql);
  const { out } = run(dir);
  assert.doesNotMatch(out, /altered a string literal|continued across/);
  rmSync(dir, { recursive: true, force: true });
});
