import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "format-staged.mjs");
// This package's own node_modules. The formatters are devDependencies here so
// the tests run anywhere — an earlier version borrowed a sibling repo's
// node_modules by absolute path, which passed locally for the wrong reason
// (the SQL branch was silently skipped) and could not run on CI at all.
const NM = path.resolve(import.meta.dirname, "..", "node_modules");

function repoWithSql(sql) {
  const dir = mkdtempSync(path.join(tmpdir(), "sqlguard-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0" }));
  // Fail loudly rather than skip: a test that quietly exercises nothing is worse
  // than no test, and that is exactly how this suite went green while broken.
  symlinkSync(NM, path.join(dir, "node_modules"));
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
  // Regression test for the real failure in backend#75. The shape matters: an
  // apostrophe in prose, then SEVERAL literals whose spacing the formatter will
  // change. A single literal is not enough — the desync has to produce a
  // different pairing in the input and the output for gate 2 to notice, which is
  // exactly why an earlier version of this test passed against a broken scanner.
  const sql = [
    // Exactly ONE apostrophe. An even number pairs with itself and stays in
    // sync, which is how a weaker version of this test passed against a broken
    // scanner; an odd one borrows the next real literal's opening quote.
    "-- Telling those roles apart is the policies' job.",
    "revoke  all  on  public.consents  from  anon,  authenticated;",
    "grant   select,  insert  on  public.consents  to  authenticated;",
    "create   policy  consents_select  on  public.consents",
    "  for  select  to  authenticated  using  (  user_id  =  auth.uid()  );",
    "create   function  private.is_admin ()  returns  boolean",
    "  language  sql  security  definer  set  search_path  =  ''",
    "  as  $$  select  current_setting('app.role',  true)  =  'admin'  $$;",
    "",
  ].join("\n");
  const { dir, f } = repoWithSql(sql);
  const { out } = run(dir);
  assert.doesNotMatch(out, /altered a string literal/);
  assert.doesNotMatch(out, /continued across a newline/);
  const after = readFileSync(f, "utf8");
  assert.notEqual(after, sql, "expected the file to be reformatted, not skipped");
  // The literals themselves must be untouched — that is the property gate 2 exists for.
  for (const lit of ["'app.role'", "'admin'", "''"]) {
    assert.ok(after.includes(lit), `literal ${lit} did not survive formatting`);
  }
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
