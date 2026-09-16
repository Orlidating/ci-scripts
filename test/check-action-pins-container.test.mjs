/**
 * A job's container and service images are graded like everything else the workflow runs
 * (backend#266).
 *
 * `container: node:20` and `services.db.image: postgres:16` pull whatever those tags point
 * at on the day, and the job — with the checkout and every secret it gets — then runs
 * inside them. That is the tj-actions retag shape, applied to an image instead of an
 * action, and until this change the checker read neither key: the fixture below exited 0
 * with "OK — 1 action reference, all pinned".
 *
 * Where a container image can appear is GitHub's schema, not a guess. In
 * actions/languageservices workflow-v1.0.json, `container` (one-of string,
 * container-mapping) and `services` (a mapping of id to one-of non-empty-string,
 * service-container-mapping) are properties of `job-factory` and not of `workflow-job`, the
 * job shape that calls a reusable workflow; no step definition carries either; and
 * action-v1.0.json has no container or services key at all, so a composite action cannot
 * carry one and `runs.image` stays the only image an action declares. Reusable workflows
 * are workflow files, so they are covered by being followed.
 *
 * Every case runs as a real workflow through `--root`, alone and next to a SHA-pinned
 * ci.yml, because a pinned reference elsewhere is exactly what hid these before.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { img, packageWithLock, pin } from "./lock-package.mjs";

const SHA = "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09";
const DIGEST = `sha256:${"a".repeat(64)}`;
// These cases grade where a container image is READ from, so the lockfile reviews every
// image they pin and only the reading is in question (backend#426 has its own file).
const BIN = packageWithLock({
  pins: [pin("actions/checkout", "v5.1.0", SHA)],
  images: [img("node", DIGEST), img("postgres", DIGEST), img("redis", DIGEST), img("alpine", DIGEST), img("ghcr.io:443/o/img", DIGEST, { tag: "1.2" })],
});
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "pins-container-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function run(dir, ...args) {
  const r = spawnSync("node", [BIN, "--root", dir, ...args], { cwd: tmpdir(), encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const PINNED_STEP = `    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n`;
/** A job carrying `body`, plus one properly pinned step, so only the image is in question. */
const job = (body) => ({ ".github/workflows/x.yml": `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n${body}${PINNED_STEP}` });
const container = (v) => job(`    container: ${v}\n`);
const containerImage = (v) => job(`    container:\n      image: ${v}\n`);
const service = (v) => job(`    services:\n      db: ${v}\n`);
const serviceImage = (v) => job(`    services:\n      db:\n        image: ${v}\n`);
const PINNED_CI = { ".github/workflows/ci.yml": `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n${PINNED_STEP}` };
const COLUMNS = { alone: {}, "with a pinned ci.yml": PINNED_CI };

// `rule` names the rule the case exercises and R[rule] is that rule's own message, so a
// mutation that drops one rule and lets another catch the value is still observable.
const R = {
  tag: /referenced by tag, not digest/,
  digest: /is not sha256:<64 lowercase hex>/,
  "one-at": /more than one @/,
  expression: /is an expression/,
  scheme: /without the docker:\/\/ prefix/,
  name: /container image name does not match the image reference grammar/,
  shape: /neither an image string nor a mapping/,
  services: /services is not a mapping of service ids/,
  "not-string": /image is not a string/,
  space: /whitespace or an invisible or control character/,
  percent: /URL-encoded/,
  backslash: /backslash/,
};

const BLOCK = [
  // The issue's own fixture, both halves.
  ["the issue's container: node:20", container("node:20"), "tag"],
  ["the issue's services.db.image: postgres:16", serviceImage("postgres:16"), "tag"],
  // The string form, the mapping form, and both for services.
  ["container with no tag at all (latest)", container("node"), "tag"],
  ["container.image by tag", containerImage("node:20"), "tag"],
  ["a service in string form", service("postgres:16"), "tag"],
  ["a registry image by tag", container("ghcr.io/o/img:1.2"), "tag"],
  ["a registry image with a port, by tag", container("ghcr.io:443/o/img:1.2"), "tag"],
  // The digest itself has to be one.
  ["container digest in uppercase hex", container(`node@sha256:${"A".repeat(64)}`), "digest"],
  ["container digest too short", container(`node@sha256:${"a".repeat(63)}`), "digest"],
  ["container digest too long", container(`node@sha256:${"a".repeat(65)}`), "digest"],
  ["container digest of another algorithm", container(`node@sha512:${"a".repeat(64)}`), "digest"],
  ["container digest with an empty digest", container("node@"), "digest"],
  ["service digest in uppercase hex", serviceImage(`postgres@sha256:${"A".repeat(64)}`), "digest"],
  ["two @ in a container image", container(`node@1@${DIGEST}`), "one-at"],
  ["two @ in a service image", serviceImage(`postgres@x@${DIGEST}`), "one-at"],
  // An expression cannot be graded, so it is refused rather than assumed.
  ["container as an expression", container("${{ matrix.image }}"), "expression"],
  ["container.image as an expression", containerImage("${{ matrix.image }}"), "expression"],
  ["a service image as an expression", serviceImage("${{ matrix.db }}"), "expression"],
  ["an expression with a digest beside it", container(`${"${{ matrix.reg }}"}/node@${DIGEST}`), "expression"],
  // docker:// is not a scheme GitHub strips here; it would become part of the name.
  ["docker:// prefix with a digest", container(`docker://node@${DIGEST}`), "scheme"],
  ["docker:// prefix by tag", container("docker://node:20"), "scheme"],
  ["docker:// prefix on a service", serviceImage(`docker://postgres@${DIGEST}`), "scheme"],
  // The name beside a valid digest still has to be an image name.
  ["a name with a space beside a digest", container(`"no name@${DIGEST}"`), "space"],
  ["a %-encoded name", container(`no%40name@${DIGEST}`), "percent"],
  ["a backslash in the name", container(`o\\img@${DIGEST}`), "backslash"],
  ["a name that is not an image reference", container(`-bad-@${DIGEST}`), "name"],
  // Quoted: a leading @ is a reserved indicator in YAML, so the unquoted form would be
  // refused as unparseable before the name rule ever saw it.
  ["an empty name before the digest", container(`"@${DIGEST}"`), "name"],
  // Shapes GitHub would not run are failures, never skips.
  ["container as a list", job("    container:\n      - node:20\n"), "shape"],
  ["a service as a list", job("    services:\n      db:\n        - postgres:16\n"), "shape"],
  ["services as a string", job("    services: postgres:16\n"), "services"],
  ["container.image as a number", job("    container:\n      image: 5\n"), "not-string"],
  ["a service image as a number", job("    services:\n      db:\n        image: 5\n"), "not-string"],
];

describe("job container and service images are graded (backend#266)", () => {
  for (const [col, extra] of Object.entries(COLUMNS)) {
    for (const [name, files, rule] of BLOCK) {
      test(`[${rule}] ${name} — ${col}: blocked, for that rule's reason`, () => {
        const r = run(tree({ ...extra, ...files }));
        assert.equal(r.code, 1, r.out);
        assert.doesNotMatch(r.out, /all pinned/, r.out);
        assert.match(r.out, R[rule], r.out);
      });
    }
  }

  const PASS = [
    ["a container pinned by digest", container(`node@${DIGEST}`)],
    ["container.image pinned by digest", containerImage(`node@${DIGEST}`)],
    ["a service pinned by digest, string form", service(`postgres@${DIGEST}`)],
    ["a service mapping pinned by digest", serviceImage(`postgres@${DIGEST}`)],
    ["a registry, port, tag and digest together", container(`ghcr.io:443/o/img:1.2@${DIGEST}`)],
    ["a container and two services, all by digest", job(`    container:\n      image: node@${DIGEST}\n    services:\n      db:\n        image: postgres@${DIGEST}\n      cache: redis@${DIGEST}\n`)],
    ["a container mapping with options but no image pulls nothing", job("    container:\n      credentials:\n        username: u\n        password: p\n")],
    ["an explicitly null container", job("    container:\n")],
    ["an explicitly null services", job("    services:\n")],
  ];
  for (const [col, extra] of Object.entries(COLUMNS)) {
    for (const [name, files] of PASS) {
      test(`control: ${name} — ${col}: passes`, () => {
        const r = run(tree({ ...extra, ...files }));
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /all pinned/, r.out);
      });
    }
  }
});

describe("the same spellings the uses: walk handles", () => {
  const SHAPES = {
    "key case: Container": "    Container: node:20\n",
    "key case: SERVICES and Image": "    SERVICES:\n      db:\n        IMAGE: postgres:16\n",
    "flow style container": "    container: {image: node:20}\n",
    "flow style services": "    services: {db: {image: postgres:16}}\n",
    "quoted key": '    "container": node:20\n',
    "value on the next line": "    container:\n      image:\n        node:20\n",
    "an anchor on the image": "    container:\n      image: &im node:20\n",
    "a duplicated image key, pinned first": `    container:\n      image: node@${DIGEST}\n      image: node:20\n`,
    "a duplicated image key, pinned last": `    container:\n      image: node:20\n      image: node@${DIGEST}\n`,
    "a duplicated container key": `    container: node@${DIGEST}\n    container: node:20\n`,
  };
  for (const [name, body] of Object.entries(SHAPES)) {
    test(`${name}: blocked`, () => {
      const r = run(tree({ ...PINNED_CI, ...job(body) }));
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /x\.yml/, r.out);
    });
  }

  test("an alias carrying the whole container is graded", () => {
    const wf = `x: &c {image: node:20}\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    container: *c\n${PINNED_STEP}`;
    const r = run(tree({ ".github/workflows/x.yml": wf }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, R.tag, r.out);
  });

  test("a merge key contributing the image is graded", () => {
    const wf = `x: &c {image: node:20}\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    container:\n      <<: *c\n${PINNED_STEP}`;
    const r = run(tree({ ".github/workflows/x.yml": wf }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, R.tag, r.out);
  });
});

describe("every workflow file a container can sit in", () => {
  test("a local reusable workflow's container is graded", () => {
    const caller = "on: push\njobs:\n  c:\n    uses: ./.github/workflows/y.yml\n";
    const called = `on: workflow_call\njobs:\n  a:\n    runs-on: ubuntu-latest\n    container: node:20\n${PINNED_STEP}`;
    const r = run(tree({ ".github/workflows/x.yml": caller, ".github/workflows/y.yml": called }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /y\.yml/, r.out);
    assert.match(r.out, R.tag, r.out);
  });

  test("a second workflow's container is graded, not just the first", () => {
    const r = run(tree({ ...PINNED_CI, ".github/workflows/z.yml": job("    container: node:20\n")[".github/workflows/x.yml"] }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /z\.yml/, r.out);
  });

  test("an unpinned container in one job does not hide behind a pinned sibling job", () => {
    const wf = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    container: node@${DIGEST}\n${PINNED_STEP}  b:\n    runs-on: ubuntu-latest\n    container: node:20\n${PINNED_STEP}`;
    const r = run(tree({ ".github/workflows/x.yml": wf }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, R.tag, r.out);
  });
});

describe("it does not block what is not a container image", () => {
  test("a step input named image is not a container image", () => {
    const wf = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n        with:\n          image: node:20\n`;
    const r = run(tree({ ".github/workflows/x.yml": wf }));
    assert.equal(r.code, 0, r.out);
  });

  test("an action's runs.image is still runs.image, and a reviewed digest passes", () => {
    const action = `runs:\n  using: docker\n  image: docker://alpine@${DIGEST}\n`;
    const r = run(tree({ ...PINNED_CI, ".github/actions/d/action.yml": action }));
    assert.equal(r.code, 0, r.out);
  });

  test("a job-level env named container is not one", () => {
    const wf = `on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      container: node:20\n${PINNED_STEP}`;
    const r = run(tree({ ".github/workflows/x.yml": wf }));
    assert.equal(r.code, 0, r.out);
  });
});

describe("what it reports", () => {
  test("the violation is reported under image:, not uses:", () => {
    const r = run(tree(container("node:20")));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\n\s+image: node:20\n/, r.out);
    assert.doesNotMatch(r.out, /uses: node:20/, r.out);
  });

  test("the fix tells you how to pin it, without a docker:// prefix", () => {
    const r = run(tree(container("node:20")));
    assert.match(r.out, /fix: pin to image@sha256:<digest>/, r.out);
  });

  test("--list shows a digest-pinned container as checked", () => {
    const r = run(tree(container(`node@${DIGEST}`)), "--list");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`x\\.yml:\\d+\\s+node@${DIGEST}\\s+\\[digest, reviewed in action-pins\\.lock\\.json\\]`), r.out);
  });

  test("a container image counts as a reference, so --require is satisfied by one", () => {
    const r = spawnSync("node", [BIN, "--root", tree(job(`    container: node@${DIGEST}\n`)), "--require"], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  });
});
