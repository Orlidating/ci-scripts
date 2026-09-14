/**
 * A `uses` value is parsed against GitHub's documented grammar (backend#268).
 *
 * The reviewer's case: `o/r/.github/workflows/y.yml@main@<40 hex> # v1` was
 * graded as SHA-pinned because the ref was taken after the LAST `@`. GitHub's
 * @actions/workflow-parser reads the ref as `main` (split("@")[1]) and
 * github/actions-lockfile as the branch `main@<sha>` (SplitN at the first @);
 * both are mutable. Every case below runs as a real workflow or action through
 * `--root`, alone and next to a SHA-pinned ci.yml.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

const BIN = path.resolve(import.meta.dirname, "..", "bin", "check-action-pins.mjs");
const SHA = "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09";
const DIGEST = `sha256:${"a".repeat(64)}`;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "pins-grammar-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function run(dir) {
  const r = spawnSync("node", [BIN, "--root", dir], { cwd: tmpdir(), encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const H = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n";
// JSON.stringify gives a YAML double-quoted scalar, so tabs and newlines inside
// the value survive parsing exactly.
const step = (uses) => ({ ".github/workflows/x.yml": `${H}    steps:\n      - uses: ${JSON.stringify(uses)} # v1.0.0\n` });
const job = (uses) => ({ ".github/workflows/x.yml": `on: push\njobs:\n  call:\n    uses: ${JSON.stringify(uses)} # v1.0.0\n` });
// Every .github/actions/**/action.y[a]ml is read whether or not a workflow names it.
const image = (img) => ({ ".github/actions/d/action.yml": `runs:\n  using: docker\n  image: ${JSON.stringify(img)}\n` });
const PINNED_CI = { ".github/workflows/ci.yml": `${H}    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n` };
const COLUMNS = { alone: {}, "with a pinned ci.yml": PINNED_CI };

// [name, files, rule] — `rule` names the grammar rule the case exercises, and R[rule] is
// that rule's own message. Rules overlap on purpose (the name charset
// also refuses `@`), so asserting the reason is what makes each rule observable
// to a mutation that removes it; the verdict alone is asserted too.
const R = {
  "one-at": /@ separators|docker reference has more than one @/,
  percent: /URL-encoded/,
  space: /whitespace or an invisible or control character/,
  sha40: /mutable ref/,
  empty: /empty segment|no owner\/repository|ref after @ is empty/,
  backslash: /backslash/,
  dotdot: /\. or \.\. segment/,
  "form-job": /job-level uses must name a reusable workflow/,
  "form-owner": /is not a GitHub account name/,
  "form-docker": /not spelled exactly docker:\/\//,
  digest: /is not sha256:<64 lowercase hex>|by tag, not digest/,
  "local-at": /local reference must not contain @/,
  expression: /is an expression/,
};
const BLOCK = [
  ["reviewer's case: reusable workflow @main@<sha>", job(`o/r/.github/workflows/y.yml@main@${SHA}`), "one-at"],
  ["action @main@<sha>", step(`actions/checkout@main@${SHA}`), "one-at"],
  ["action with path @main@<sha>", step(`o/r/sub/dir@main@${SHA}`), "one-at"],
  ["docker @main@sha256", step(`docker://alpine@main@${DIGEST}`), "one-at"],
  ["docker runs.image @x@sha256", image(`docker://alpine@x@${DIGEST}`), "one-at"],
  ["@<sha>@main", step(`actions/checkout@${SHA}@main`), "one-at"],
  ["reusable workflow @<sha>@main", job(`o/r/.github/workflows/y.yml@${SHA}@main`), "one-at"],
  ["%40 in place of @", step(`actions/checkout%40main@${SHA}`), "percent"],
  ["%40 in the ref", step(`actions/checkout@main%40${SHA}`), "percent"],
  ["space after @", step(`actions/checkout@ ${SHA}`), "space"],
  ["tab in the value", step(`actions/checkout@\t${SHA}`), "space"],
  ["newline in the value", step(`actions/checkout@main\n${SHA}`), "space"],
  ["zero-width space in the value", step(`actions/checkout@\u200b${SHA}`), "space"],
  ["uppercase hex", step(`actions/checkout@${SHA.toUpperCase()}`), "sha40"],
  ["refs/tags/<sha>", step(`actions/checkout@refs/tags/${SHA}`), "sha40"],
  ["<sha>^{}", step(`actions/checkout@${SHA}^{}`), "sha40"],
  ["41 hex", step(`actions/checkout@${SHA}0`), "sha40"],
  ["empty ref", step("actions/checkout@"), "empty"],
  ["empty owner", step(`/checkout@${SHA}`), "empty"],
  ["empty repository", step(`actions/@${SHA}`), "empty"],
  ["double slash", step(`actions//checkout@${SHA}`), "empty"],
  ["owner only", step(`actions@${SHA}`), "empty"],
  ["backslash in the path", step(`actions\\checkout@${SHA}`), "backslash"],
  ["backslash local path", step(".\\tools\\setup"), "backslash"],
  [".. segment in a remote path", step(`o/r/../other@${SHA}`), "dotdot"],
  [". segment in a remote path", step(`o/r/./x@${SHA}`), "dotdot"],
  ["reusable workflow path with ..", job(`o/r/.github/workflows/../../x.yml@${SHA}`), "dotdot"],
  ["unknown form: job uses a plain action", job(`actions/checkout@${SHA}`), "form-job"],
  ["unknown form: host:owner", step(`github.com:actions/checkout@${SHA}`), "form-owner"],
  ["unknown form: DOCKER:// in capitals", step(`DOCKER://alpine@${DIGEST}`), "form-docker"],
  ["docker digest in uppercase hex", step(`docker://alpine@sha256:${"A".repeat(64)}`), "digest"],
  ["docker digest too short", step(`docker://alpine@sha256:${"a".repeat(63)}`), "digest"],
  ["docker tag only", step("docker://alpine:3"), "digest"],
  ["local path with @", step("./tools/setup@v1"), "local-at"],
  ["expression with spaces", step("${{ matrix.action }}"), "expression"],
  ["expression without spaces", step("${{matrix.action}}"), "expression"],
];

// Controls: every legitimate form still passes.
const PASS = [
  ["action", step(`actions/checkout@${SHA}`)],
  ["action with a path", step(`github/codeql-action/init@${SHA}`)],
  ["reusable workflow", job(`o/r/.github/workflows/y.yml@${SHA}`)],
  ["docker digest", step(`docker://alpine@${DIGEST}`)],
  ["docker host, port, tag and digest", step(`docker://ghcr.io:443/o/img:1.2@${DIGEST}`)],
  ["docker runs.image digest", image(`docker://alpine@${DIGEST}`)],
  ["dots, dashes and underscores in names", step(`my-org/my_repo.js/sub-dir@${SHA}`)],
];

describe("uses is parsed against GitHub's grammar (backend#268)", () => {
  for (const [col, extra] of Object.entries(COLUMNS)) {
    for (const [name, files, rule] of BLOCK) {
      test(`[${rule}] ${name} — ${col}: blocked, for that rule's reason`, () => {
        const r = run(tree({ ...extra, ...files }));
        assert.equal(r.code, 1, r.out);
        assert.doesNotMatch(r.out, /all pinned/, r.out);
        assert.match(r.out, R[rule], r.out);
      });
    }
    for (const [name, files] of PASS) {
      test(`control: ${name} — ${col}: passes`, () => {
        const r = run(tree({ ...extra, ...files }));
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /all pinned/, r.out);
      });
    }
  }

  test("the message names the ref GitHub would read, not the SHA", () => {
    const r = run(tree(job(`o/r/.github/workflows/y.yml@main@${SHA}`)));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /2 @ separators/);
    assert.match(r.out, /"main"/);
  });
});

describe("the AST visit cap is enforced (MAX_VISITS, mutant CK8)", () => {
  test("a merge key that expands to more than 200,000 nodes blocks, and the alias count alone would not", () => {
    // One anchored map of 100 keys merged in 2,100 times: 210,000 pairs to walk,
    // but only one anchor, so toJS's maxAliasCount (10,000) never trips. Without
    // the cap this file is walked to the end and its pinned reference passes.
    const keys = Array.from({ length: 100 }, (_, i) => `k${i}: 0`).join(", ");
    const merges = Array.from({ length: 2100 }, () => "*a").join(", ");
    const wf = `x: &a {${keys}}\n<<: [${merges}]\n${H}    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n`;
    const r = run(tree({ ".github/workflows/x.yml": wf }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /more than 200000 YAML nodes/, r.out);
  });
});
