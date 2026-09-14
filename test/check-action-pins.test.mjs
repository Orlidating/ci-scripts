import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "check-action-pins.mjs");
const SHA = "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09";

/** A throwaway git repo containing one workflow, since the checker resolves its root via git. */
function repoWith(workflow, name = "ci.yml") {
  const dir = mkdtempSync(path.join(tmpdir(), "pins-"));
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", name), workflow);
  return dir;
}

function run(dir) {
  try {
    const stdout = execFileSync("node", [BIN], { cwd: dir, encoding: "utf8" });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const wf = (uses) => `jobs:\n  a:\n    steps:\n      - uses: ${uses}\n`;

test("accepts a full SHA with a version comment", () => {
  const dir = repoWith(wf(`actions/checkout@${SHA} # v5.1.0`));
  const { code, out } = run(dir);
  assert.equal(code, 0);
  assert.match(out, /all pinned to an immutable ref/);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects a tag — the whole point, since an owner can move it", () => {
  const dir = repoWith(wf("actions/checkout@v5"));
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /mutable ref "v5"/);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects a branch name", () => {
  const dir = repoWith(wf("actions/checkout@main"));
  assert.equal(run(dir).code, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects a short SHA, which is not guaranteed unique", () => {
  const dir = repoWith(wf("actions/checkout@fbc6f39 # v5.1.0"));
  assert.equal(run(dir).code, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects a SHA with no version comment, so the pin stays reviewable", () => {
  const dir = repoWith(wf(`actions/checkout@${SHA}`));
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /missing the version comment/);
  rmSync(dir, { recursive: true, force: true });
});

test("rejects no ref at all — that silently tracks the default branch", () => {
  const dir = repoWith(wf("actions/checkout"));
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /no ref at all/);
  rmSync(dir, { recursive: true, force: true });
});

test("allows a local action, which no third party can move — and follows it", () => {
  const dir = repoWith(wf("./.github/actions/build"));
  mkdirSync(path.join(dir, ".github", "actions", "build"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "actions", "build", "action.yml"), "runs:\n  using: composite\n  steps:\n    - run: echo build\n      shell: bash\n");
  assert.equal(run(dir).code, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a local action that is not in the tree fails (backend#257): GitHub would fail, and nothing was checked", () => {
  const dir = repoWith(wf("./.github/actions/build"));
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /no action\.yml or action\.yaml/);
  rmSync(dir, { recursive: true, force: true });
});

test("allows a docker digest but rejects a docker tag", () => {
  const ok = repoWith(wf(`docker://alpine@sha256:${"a".repeat(64)}`));
  assert.equal(run(ok).code, 0);
  rmSync(ok, { recursive: true, force: true });

  const bad = repoWith(wf("docker://alpine:3.20"));
  const { code, out } = run(bad);
  assert.equal(code, 1);
  assert.match(out, /tag, not digest/);
  rmSync(bad, { recursive: true, force: true });
});

test("checks every workflow, not just the first", () => {
  const dir = repoWith(wf(`actions/checkout@${SHA} # v5.1.0`));
  writeFileSync(
    path.join(dir, ".github", "workflows", "release.yml"),
    wf("actions/setup-node@v5"),
  );
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /release\.yml/);
  rmSync(dir, { recursive: true, force: true });
});

test("checks composite actions defined in this repo", () => {
  const dir = repoWith(wf(`actions/checkout@${SHA} # v5.1.0`));
  mkdirSync(path.join(dir, ".github", "actions", "setup"), { recursive: true });
  writeFileSync(
    path.join(dir, ".github", "actions", "setup", "action.yml"),
    `runs:\n  using: composite\n  steps:\n    - uses: pnpm/action-setup@v4\n`,
  );
  const { code, out } = run(dir);
  assert.equal(code, 1);
  assert.match(out, /action\.yml/);
  rmSync(dir, { recursive: true, force: true });
});

test("is not fooled by a quoted ref", () => {
  const dir = repoWith(wf(`"actions/checkout@v5"`));
  assert.equal(run(dir).code, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("says nothing was checked, rather than OK, when there are no workflows", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pins-"));
  execFileSync("git", ["init", "-q", dir]);
  const { code, out } = run(dir);
  assert.equal(code, 0);
  assert.match(out, /nothing was checked/);
  assert.doesNotMatch(out, /all pinned/); // must not read like a check that passed
  rmSync(dir, { recursive: true, force: true });
});

test("--require turns 'nothing to check' into a failure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pins-"));
  execFileSync("git", ["init", "-q", dir]);
  let code = 0;
  try {
    execFileSync("node", [BIN, "--require"], { cwd: dir, encoding: "utf8" });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("--require still passes when real pinned references exist", () => {
  const dir = repoWith(wf(`actions/checkout@${SHA} # v5.1.0`));
  const code = (() => {
    try {
      execFileSync("node", [BIN, "--require"], { cwd: dir, encoding: "utf8" });
      return 0;
    } catch (err) {
      return err.status;
    }
  })();
  assert.equal(code, 0);
  rmSync(dir, { recursive: true, force: true });
});
