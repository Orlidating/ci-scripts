/**
 * check-action-pins reads workflows and actions with a YAML parser (backend#255,
 * backend#256, backend#257). Each shape below parses, under yaml 2.7.0, 2.8.1,
 * 2.9.0 and 2.9.1 alike, to `uses: actions/checkout@v4`; the old line regex read
 * none of them. Every shape runs twice: alone, and next to a SHA-pinned ci.yml,
 * because a pinned file elsewhere is exactly what hid them before.
 *
 * These use --root on plain directories (no git), which is how the orlidating
 * pre-push hook calls the checker on a snapshot of the pushed commit.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { packageWithLock, pin } from "./lock-package.mjs";

const SHA = "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09";
// These cases grade YAML reading, so the lockfile approves the fixture pins
// (backend#421 is covered in check-action-pins-lock.test.mjs).
const BIN = packageWithLock([pin("actions/checkout", "v5.1.0", SHA), pin("actions/cache", "v4.2.0", SHA)]);
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "pins-yaml-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    if (content && typeof content === "object") symlinkSync(content.symlink, full);
    else writeFileSync(full, content);
  }
  return dir;
}

function run(dir, ...args) {
  const r = spawnSync("node", [BIN, "--root", dir, ...args], { cwd: tmpdir(), encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const H = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n";
const PINNED_CI = { ".github/workflows/ci.yml": `${H}    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n` };

// The reviewer's table (claude-config#4 review, backend#256), plus the rest of #256's shapes.
const SHAPES = {
  "block style (control)": `${H}    steps:\n      - uses: actions/checkout@v4\n`,
  "flow sequence": `${H}    steps: [{uses: actions/checkout@v4}]\n`,
  "flow step": `${H}    steps:\n      - {uses: actions/checkout@v4}\n`,
  "quoted key": `${H}    steps:\n      - "uses": actions/checkout@v4\n`,
  "single-quoted key": `${H}    steps:\n      - 'uses': actions/checkout@v4\n`,
  "anchor on the value": `${H}    steps:\n      - uses: &co actions/checkout@v4\n`,
  "value on the next line": `${H}    steps:\n      - uses:\n          actions/checkout@v4\n`,
  "block scalar": `${H}    steps:\n      - uses: >-\n          actions/checkout@v4\n`,
  "space before the colon": `${H}    steps:\n      - uses : actions/checkout@v4\n`,
  "!!str tag": `${H}    steps:\n      - uses: !!str actions/checkout@v4\n`,
  "JSON workflow": '{"on":"push","jobs":{"a":{"runs-on":"ubuntu-latest","steps":[{"uses":"actions/checkout@v4"}]}}}\n',
  "escaped key u\\x73es": `${H}    steps:\n      - "u\\x73es": actions/checkout@v4\n`,
  "explicit key ? uses": `${H}    steps:\n      - ? uses\n        : actions/checkout@v4\n`,
  "alias as the value": `x: &v actions/checkout@v4\n${H}    steps:\n      - uses: *v\n`,
  "alias as the key": `x: &k uses\n${H}    steps:\n      - *k : actions/checkout@v4\n`,
  "whole step through an alias": `x: &s {uses: actions/checkout@v4}\n${H}    steps:\n      - *s\n`,
  "steps list through an alias": `x: &l [{uses: actions/checkout@v4}]\n${H}    steps: *l\n`,
  "merge key <<": `x: &s {uses: actions/checkout@v4}\n${H}    steps:\n      - <<: *s\n        name: merged\n`,
  "merge key list <<: [*a]": `x: &s {uses: actions/checkout@v4}\n${H}    steps:\n      - <<: [*s]\n        name: merged\n`,
  "duplicate key, pinned first": `${H}    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n        uses: actions/checkout@v4\n`,
  "duplicate key, pinned last": `${H}    steps:\n      - uses: actions/checkout@v4\n        uses: actions/checkout@${SHA} # v5.1.0\n`,
  "Uses: (key case)": `${H}    steps:\n      - Uses: actions/checkout@v4\n`,
  "CRLF line endings": `${H}    steps:\n      - uses: actions/checkout@v4\n`.replace(/\n/g, "\r\n"),
  "same file mixes pinned and flow": `${H}    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n      - {uses: actions/setup-node@v4}\n`,
  "reusable workflow jobs.x.uses": "on: push\njobs:\n  call:\n    uses: octo/repo/.github/workflows/y.yml@main\n",
  "reusable workflow uses in flow style": "on: push\njobs: {call: {uses: octo/repo/.github/workflows/y.yml@main}}\n",
  "docker tag": `${H}    steps:\n      - uses: docker://alpine:3\n`,
};

describe("every spelling of an unpinned uses: is found by parsing (backend#256)", () => {
  for (const [name, wf] of Object.entries(SHAPES)) {
    for (const [col, extra] of [
      ["alone", {}],
      ["with a pinned ci.yml", PINNED_CI],
    ]) {
      test(`${name} — ${col}: blocked`, () => {
        const r = run(tree({ ...extra, ".github/workflows/x.yml": wf }));
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, /x\.yml/, r.out);
      });
    }
  }
});

describe("what GitHub would not run cannot pass", () => {
  test("multi-document file (parseDocument refuses it), even with the unpinned ref in document 2", () => {
    const wf = `${H}    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n---\n${H}    steps:\n      - uses: actions/checkout@v4\n`;
    const r = run(tree({ ...PINNED_CI, ".github/workflows/x.yml": wf }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not valid YAML.*MULTIPLE_DOCS/);
  });

  test("unparseable YAML blocks, it is not skipped", () => {
    const r = run(tree({ ...PINNED_CI, ".github/workflows/x.yml": `${H}    steps:\n      - uses: [unclosed\n` }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not valid YAML/);
  });

  test("an unparseable composite action blocks", () => {
    const r = run(tree({ ...PINNED_CI, ".github/actions/s/action.yml": "runs: {using: composite, steps: [\n" }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /action\.yml[\s\S]*not valid YAML/);
  });

  test("an alias bomb fails instead of hanging or passing", () => {
    let y = "a0: &a0 [x]\n";
    for (let i = 1; i < 30; i++) y += `a${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}]\n`;
    y += `${H}    steps: *a29\n`;
    const r = run(tree({ ".github/workflows/x.yml": y }));
    assert.equal(r.code, 1, r.out);
  });

  test("steps that are not a list block", () => {
    const r = run(tree({ ".github/workflows/x.yml": `${H}    steps: {uses: actions/checkout@v4}\n` }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /not a list/);
  });

  test("uses that is not a string blocks", () => {
    const r = run(tree({ ".github/workflows/x.yml": `${H}    steps:\n      - uses: [actions/checkout@v4]\n` }));
    assert.equal(r.code, 1, r.out);
  });
});

describe("local actions are followed wherever they live (backend#257)", () => {
  const COMPOSITE = (uses) => `runs:\n  using: composite\n  steps:\n    - uses: ${uses}\n      shell: bash\n`;
  const WF = (uses) => `${H}    steps:\n      - uses: ${uses}\n`;

  test("./tools/setup with an @v4 composite: blocked", () => {
    const r = run(tree({ ...PINNED_CI, ".github/workflows/x.yml": WF("./tools/setup"), "tools/setup/action.yml": COMPOSITE("actions/cache@v4") }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /tools\/setup\/action\.yml[\s\S]*actions\/cache@v4/);
  });

  test("the same with action.yaml, a trailing slash and ./ segments: blocked", () => {
    const r = run(tree({ ".github/workflows/x.yml": WF("./tools/./setup/"), "tools/setup/action.yaml": COMPOSITE("actions/cache@v4") }));
    assert.equal(r.code, 1, r.out);
  });

  test("a pinned local composite passes, and is followed", () => {
    const r = run(tree({ ".github/workflows/x.yml": WF("./tools/setup"), "tools/setup/action.yml": COMPOSITE(`actions/cache@${SHA} # v4.2.0`) }), "--list");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /tools\/setup\/action\.yml:\d+\s+actions\/cache@/);
  });

  test("a local action that does not exist blocks (GitHub would fail)", () => {
    const r = run(tree({ ...PINNED_CI, ".github/workflows/x.yml": WF("./tools/missing") }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no action\.yml or action\.yaml/);
  });

  test("recursive: a local composite using another local composite outside .github", () => {
    const r = run(
      tree({
        ".github/workflows/x.yml": WF("./a"),
        "a/action.yml": COMPOSITE("./b/c"),
        "b/c/action.yml": COMPOSITE("actions/cache@v4"),
      }),
    );
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /b\/c\/action\.yml/);
  });

  test("a cycle of local actions terminates and grades what it holds", () => {
    const pinned = `runs:\n  using: composite\n  steps:\n    - uses: ./b\n    - uses: actions/cache@${SHA} # v4.2.0\n`;
    const r = run(tree({ ".github/workflows/x.yml": WF("./a"), "a/action.yml": pinned, "b/action.yml": COMPOSITE("./a") }));
    assert.equal(r.code, 0, r.out);
  });

  test("a chain deeper than the bound blocks", () => {
    const files = { ".github/workflows/x.yml": WF("./d0") };
    for (let i = 0; i < 20; i++) files[`d${i}/action.yml`] = COMPOSITE(`./d${i + 1}`);
    files["d20/action.yml"] = COMPOSITE(`actions/cache@${SHA} # v4.2.0`);
    const r = run(tree(files));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /nest more than/);
  });

  test("$/path is the same repository: followed", () => {
    const r = run(tree({ ".github/actions/outer/action.yml": COMPOSITE("$/tools/inner"), "tools/inner/action.yml": COMPOSITE("actions/cache@v4") }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /tools\/inner\/action\.yml/);
  });

  test("a local path that leaves the repository blocks", () => {
    const r = run(tree({ ".github/workflows/x.yml": WF("./../elsewhere") }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /leaves the repository/);
  });

  test("a local reusable workflow is followed", () => {
    const r = run(tree({ ".github/workflows/x.yml": "on: push\njobs:\n  c:\n    uses: ./.github/workflows/y.yml\n", ".github/workflows/y.yml": "on: workflow_call\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: [{uses: actions/checkout@v4}]\n" }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /y\.yml/);
  });

  test("nested .github/actions/a/b/action.yml is read without a reference", () => {
    const r = run(tree({ ...PINNED_CI, ".github/actions/group/setup/action.yml": COMPOSITE("actions/cache@v4") }));
    assert.equal(r.code, 1, r.out);
  });

  test("runs.image docker:// by tag blocks, by digest passes", () => {
    const bad = run(tree({ ".github/actions/d/action.yml": "runs:\n  using: docker\n  image: docker://alpine:3\n" }));
    assert.equal(bad.code, 1, bad.out);
    const ok = run(tree({ ".github/actions/d/action.yml": `runs:\n  using: docker\n  image: docker://alpine@sha256:${"a".repeat(64)}\n` }));
    assert.equal(ok.code, 0, ok.out);
  });
});

describe("symlinks are refused, never followed", () => {
  test(".github itself as a symlink", () => {
    const r = run(tree({ "real/workflows/x.yml": SHAPES["block style (control)"], ".github": { symlink: "real" } }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\.github[\s\S]*is a symlink/);
  });

  test("a workflow file as a symlink", () => {
    const r = run(tree({ ...PINNED_CI, "x.yml": SHAPES["block style (control)"], ".github/workflows/x.yml": { symlink: "../../x.yml" } }));
    assert.equal(r.code, 1, r.out);
  });

  test("a local action path through a symlinked directory", () => {
    const r = run(tree({ ".github/workflows/x.yml": `${H}    steps:\n      - uses: ./tools/link\n`, "real/action.yml": "runs: {using: composite, steps: []}\n", "tools/link": { symlink: "../real" } }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /symlink tools\/link/);
  });
});

describe("no false block on legitimate trees", () => {
  test("run:-only workflow, uses:-less composite, non-YAML files and subdirectories: nothing was checked", () => {
    const r = run(
      tree({
        ".github/workflows/x.yml": `${H}    steps:\n      - run: "echo uses: not a key"\n      - run: |\n          echo "- uses: actions/checkout@v4"\n`,
        ".github/workflows/README.md": "uses: actions/checkout@v4\n",
        ".github/workflows/sub/y.yml": "not: [valid\n",
        ".github/actions/s/action.yml": "runs:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n",
        ".github/pull_request_template.md": "uses: whatever\n",
      }),
    );
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nothing was checked/);
  });

  test("a step's with: input named uses is not a reference", () => {
    const r = run(tree({ ".github/workflows/x.yml": `${H}    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n        with:\n          uses: actions/checkout@v4\n` }));
    assert.equal(r.code, 0, r.out);
  });

  test("anchors (which GitHub supports) with pinned references pass", () => {
    const r = run(tree({ ".github/workflows/x.yml": `x: &co actions/checkout@${SHA} # v5.1.0\n${H}    steps:\n      - uses: *co\n` }));
    assert.equal(r.code, 0, r.out);
  });
});

describe("--root", () => {
  test("prints the protocol line first and needs no git repository", () => {
    const r = spawnSync("node", [BIN, "--root", tree(PINNED_CI)], { cwd: tmpdir(), encoding: "utf8", env: { ...process.env, PATH: path.dirname(process.execPath) } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split("\n")[0], "check-action-pins: protocol 3");
  });

  test("unknown arguments are an error, never ignored", () => {
    const r = spawnSync("node", [BIN, "--rot", "x"], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
  });

  test("a --root that is not a directory is an error", () => {
    const r = spawnSync("node", [BIN, "--root", path.join(tmpdir(), "does-not-exist-pins")], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
  });
});
