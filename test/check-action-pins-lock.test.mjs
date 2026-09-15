/**
 * Every remote pin must be the reviewed commit of the tag its comment names
 * (backend#421).
 *
 * GitHub resolves owner/repo@<sha> for a commit that exists anywhere in the fork
 * network. Two real ones are the fixtures here:
 *   - actions/setup-node@a6aa7c983ce5d580d149344767c9e3f34214804c, only in the fork
 *     Rchie121/setup-node (compare reports it 49 ahead of v5.0.0);
 *   - actions/upload-artifact@be1eaeb04ae4adec5509a6adeccadb47a703d75b, only in the
 *     fork oxasploits/upload-artifact (compare reports it 1 ahead of main).
 * Both resolve under the upstream name through commits/<sha> and compare, so
 * neither is evidence. Only the upstream tag's own commit is.
 *
 * Offline cases run the real checker against the shipped lockfile. The online
 * cases (--verify-lock, --resolve) use recorded `gh api` bodies through a fake gh;
 * CHECK_ACTION_PINS_LIVE=1 adds a run against GitHub itself.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fakeGh, lockText, packageWithLock, pin, REAL_BIN, RECORDED, REPO } from "./lock-package.mjs";

const CHECKOUT = "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09"; // actions/checkout v5.1.0
const PNPM = "b906affcce14559ad1aafd4ab0e942779e9f58b1"; // pnpm/action-setup v4.3.0 (annotated)
const PNPM_TAG_OBJECT = "c336a2788d9774dccfdeb4823a5058ccc9f07453";
const NODE5 = "a0853c24544627f65ddf259abe73b1d18a591444"; // actions/setup-node v5.0.0
const NODE44 = "49933ea5288caeca8642d1e84afbd3f7d6820020"; // actions/setup-node v4.4.0
const UPLOAD = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"; // actions/upload-artifact v7.0.1
const DOWNLOAD = "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"; // actions/download-artifact v8.0.1
const IMPOSTOR_NODE = "a6aa7c983ce5d580d149344767c9e3f34214804c";
const IMPOSTOR_UPLOAD = "be1eaeb04ae4adec5509a6adeccadb47a703d75b";
const DIGEST = `sha256:${"a".repeat(64)}`;

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "pins-lock-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// Offline runs get a PATH whose only gh records the call, so any network use shows.
const offlineGh = fakeGh({});
function run(bin, args, env = offlineGh.env) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd: tmpdir(), encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}
const check = (dir, bin = REAL_BIN) => run(bin, ["--root", dir]);

const H = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n";
const step = (uses) => ({ ".github/workflows/x.yml": `${H}    steps:\n      - uses: ${uses}\n` });
const job = (uses) => ({ ".github/workflows/x.yml": `on: push\njobs:\n  call:\n    uses: ${uses}\n` });
const composite = (uses) => ({ ".github/actions/s/action.yml": `runs:\n  using: composite\n  steps:\n    - uses: ${uses}\n` });
const PINNED_CI = { ".github/workflows/ci.yml": `${H}    steps:\n      - uses: actions/checkout@${CHECKOUT} # v5.1.0\n      - uses: actions/setup-node@${NODE5} # v5.0.0\n` };

describe("the shipped lockfile", () => {
  test("holds exactly the pins backend, compatibility and ci-scripts use today, each with provenance", () => {
    const lock = JSON.parse(readFileSync(path.join(REPO, "action-pins.lock.json"), "utf8"));
    const got = lock.pins.map((p) => `${p.repository}@${p.tag}=${p.sha}:${p.tag_type}${p.tag_object ? `:${p.tag_object}` : ""}`).sort();
    assert.deepEqual(got, [
      `actions/checkout@v5.1.0=${CHECKOUT}:lightweight`,
      `actions/download-artifact@v8.0.1=${DOWNLOAD}:lightweight`,
      `actions/setup-node@v5.0.0=${NODE5}:lightweight`,
      `actions/upload-artifact@v7.0.1=${UPLOAD}:lightweight`,
      `pnpm/action-setup@v4.3.0=${PNPM}:annotated:${PNPM_TAG_OBJECT}`,
    ]);
    for (const p of lock.pins) {
      assert.match(p.method, new RegExp(`gh api repos/${p.repository}/git/ref/tags/${p.tag.replace(/\./g, "\\.")}`));
      assert.match(p.resolved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  test("is published with the package, since the checker reads it from beside bin/", () => {
    assert.ok(JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).files.includes("action-pins.lock.json"));
  });
});

describe("offline: a pin passes only as a reviewed lockfile entry (backend#421)", () => {
  const R = {
    impostor: /is not the reviewed commit for .+ it is an older or different release, a commit that exists only in a fork \(an impostor commit/,
    notCommit: /is not the reviewed commit for /,
    unknownTag: /is not a reviewed tag of /,
    comment: /the version comment says "[^"]*", but [0-9a-f]{40} is the reviewed commit for /,
    unknownRepo: /is not in the reviewed lockfile \(action-pins\.lock\.json in @orlidating\/ci-scripts\)/,
    path: /the path "[^"]+" inside .+ is not reviewed/,
    docker: /by tag, not digest/,
    noComment: /missing the version comment/,
  };
  const BLOCK = [
    ["the demonstrated impostor: actions/setup-node fork commit under # v5.0.0", step(`actions/setup-node@${IMPOSTOR_NODE} # v5.0.0`), "impostor"],
    ["the upload-artifact fork commit under # v7.0.1", step(`actions/upload-artifact@${IMPOSTOR_UPLOAD} # v7.0.1`), "impostor"],
    ["a fork commit with a comment naming no reviewed tag", step(`actions/setup-node@${IMPOSTOR_NODE} # v5.0.1`), "unknownTag"],
    ["a fork commit in a composite action", composite(`actions/upload-artifact@${IMPOSTOR_UPLOAD} # v7.0.1`), "impostor"],
    ["an older release SHA (v4.4.0) under the newer comment # v5.0.0", step(`actions/setup-node@${NODE44} # v5.0.0`), "impostor"],
    ["an older release SHA with its own, unreviewed tag # v4.4.0", step(`actions/setup-node@${NODE44} # v4.4.0`), "unknownTag"],
    ["a SHA one character off the reviewed one (compared exactly)", step(`actions/checkout@${CHECKOUT.slice(0, 39)}8 # v5.1.0`), "impostor"],
    ["the reviewed SHA under the tag in other letter case # V5.1.0 (tags are case-sensitive)", step(`actions/checkout@${CHECKOUT} # V5.1.0`), "comment"],
    ["the right SHA with a wrong comment # v4.4.0", step(`actions/setup-node@${NODE5} # v4.4.0`), "comment"],
    ["the right SHA with the comment 5.0.0 (no v)", step(`actions/setup-node@${NODE5} # 5.0.0`), "comment"],
    ["the right SHA with extra words in the comment", step(`actions/setup-node@${NODE5} # v5.0.0 node 20`), "comment"],
    ["another action's reviewed SHA under this action's tag", step(`actions/setup-node@${CHECKOUT} # v5.0.0`), "notCommit"],
    ["two reviewed tags of one repo crossed: download-artifact SHA, upload tag", step(`actions/upload-artifact@${DOWNLOAD} # v7.0.1`), "notCommit"],
    ["an unknown action", step(`octo-org/unknown-action@${CHECKOUT} # v5.1.0`), "unknownRepo"],
    ["a lookalike owner", step(`action/checkout@${CHECKOUT} # v5.1.0`), "unknownRepo"],
    ["a lookalike repository", step(`actions/checkout2@${CHECKOUT} # v5.1.0`), "unknownRepo"],
    ["a path suffix into the repository", step(`actions/checkout/subdir@${CHECKOUT} # v5.1.0`), "path"],
    ["a path suffix with different owner casing", step(`Actions/Checkout/subdir@${CHECKOUT} # v5.1.0`), "path"],
    ["a reusable workflow the entry does not list", job(`actions/checkout/.github/workflows/ci.yml@${CHECKOUT} # v5.1.0`), "path"],
    ["docker:// without a digest", step("docker://alpine:3.20"), "docker"],
    ["no version comment", step(`actions/setup-node@${NODE5}`), "noComment"],
  ];
  for (const [col, extra] of [
    ["alone", {}],
    ["with a reviewed ci.yml", PINNED_CI],
  ]) {
    for (const [name, files, rule] of BLOCK) {
      test(`${name} — ${col}: blocked, for that reason`, () => {
        const r = check(tree({ ...extra, ...files }));
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, R[rule], r.out);
        assert.doesNotMatch(r.out, /all pinned/, r.out);
      });
    }
  }

  const PASS = [
    ["every shipped entry", { ".github/workflows/x.yml": `${H}    steps:\n${[`actions/checkout@${CHECKOUT} # v5.1.0`, `pnpm/action-setup@${PNPM} # v4.3.0`, `actions/setup-node@${NODE5} # v5.0.0`, `actions/upload-artifact@${UPLOAD} # v7.0.1`, `actions/download-artifact@${DOWNLOAD} # v8.0.1`].map((u) => `      - uses: ${u}\n`).join("")}` }, 5],
    ["owner and repository in other letter cases, as GitHub resolves them", step(`Actions/Checkout@${CHECKOUT} # v5.1.0`), 1],
    ["all capitals", step(`ACTIONS/SETUP-NODE@${NODE5} # v5.0.0`), 1],
    ["a docker digest, which is content-addressed and needs no entry", step(`docker://alpine@${DIGEST}`), 1],
  ];
  for (const [name, files, n] of PASS) {
    test(`control: ${name} passes`, () => {
      const r = check(tree(files));
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, new RegExp(`OK — ${n} action references?, all pinned`), r.out);
    });
  }

  test("--list says each pin was found in the lockfile", () => {
    const r = run(REAL_BIN, ["--root", tree(PINNED_CI), "--list"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /actions\/setup-node@a0853c245446…\s+\[pinned v5\.0\.0, reviewed in action-pins\.lock\.json\]/);
  });

  test("the default mode never calls gh, pass or fail (the pre-push hook runs it offline)", () => {
    const gh = fakeGh(RECORDED);
    assert.equal(run(REAL_BIN, ["--root", tree(PINNED_CI)], gh.env).code, 0);
    assert.equal(run(REAL_BIN, ["--root", tree(step(`actions/setup-node@${IMPOSTOR_NODE} # v5.0.0`))], gh.env).code, 1);
    assert.deepEqual(gh.calls(), []);
  });

  test("--root still prints the protocol line first, now protocol 3", () => {
    const r = check(tree(step(`actions/setup-node@${IMPOSTOR_NODE} # v5.0.0`)));
    assert.equal(r.stdout.split("\n")[0], "check-action-pins: protocol 3");
  });
});

describe("offline: what a fixture lockfile approves, and nothing near it", () => {
  const CODEQL = "1111111111111111111111111111111111111111";
  const CODEQL31 = "2222222222222222222222222222222222222222";
  const WF = "3333333333333333333333333333333333333333";
  const bin = packageWithLock([
    pin("actions/checkout", "v5.1.0", CHECKOUT),
    pin("actions/checkout", "v5", CHECKOUT),
    pin("github/codeql-action", "v3.0.0", CODEQL, { paths: ["init"] }),
    pin("github/codeql-action", "v3.1.0", CODEQL31),
    pin("o/r", "v1.0.0", WF, { paths: [".github/workflows/y.yml"] }),
  ]);
  const cases = [
    ["one commit under two reviewed tags: # v5", step(`actions/checkout@${CHECKOUT} # v5`), 0],
    ["one commit under two reviewed tags: # v5.1.0", step(`actions/checkout@${CHECKOUT} # v5.1.0`), 0],
    ["a listed action path", step(`github/codeql-action/init@${CODEQL} # v3.0.0`), 0],
    ["the repository's own action beside listed paths", step(`github/codeql-action@${CODEQL} # v3.0.0`), 0],
    ["an unlisted path in the same repository", step(`github/codeql-action/analyze@${CODEQL} # v3.0.0`), 1],
    ["a listed path under a tag whose entry does not list it", step(`github/codeql-action/init@${CODEQL31} # v3.1.0`), 1],
    ["a listed path with a trailing segment", step(`github/codeql-action/init/sub@${CODEQL} # v3.0.0`), 1],
    ["a listed path in another letter case (git paths are case-sensitive)", step(`github/codeql-action/Init@${CODEQL} # v3.0.0`), 1],
    ["a listed reusable workflow", job(`o/r/.github/workflows/y.yml@${WF} # v1.0.0`), 0],
    ["a listed reusable workflow, owner and repository recased", job(`O/R/.github/workflows/y.yml@${WF} # v1.0.0`), 0],
    ["an unlisted reusable workflow in the same repository", job(`o/r/.github/workflows/z.yml@${WF} # v1.0.0`), 1],
    ["a listed workflow file in another letter case", job(`o/r/.github/workflows/Y.yml@${WF} # v1.0.0`), 1],
    ["the reusable workflow's SHA under another action", job(`o/other/.github/workflows/y.yml@${WF} # v1.0.0`), 1],
  ];
  for (const [name, files, code] of cases) {
    test(`${name}: ${code === 0 ? "passes" : "blocked"}`, () => {
      const r = check(tree(files), bin);
      assert.equal(r.code, code, r.out);
    });
  }
});

describe("reserved names never satisfy a lookup (backend#422)", () => {
  const USES = [
    ["__proto__ as owner", step(`__proto__/checkout@${CHECKOUT} # v5.1.0`)],
    ["constructor as owner", step(`constructor/checkout@${CHECKOUT} # v5.1.0`)],
    ["prototype as owner", step(`prototype/checkout@${CHECKOUT} # v5.1.0`)],
    ["__proto__ as repository", step(`actions/__proto__@${CHECKOUT} # v5.1.0`)],
    ["constructor as repository", step(`actions/constructor@${CHECKOUT} # v5.1.0`)],
    ["Constructor as repository", step(`actions/Constructor@${CHECKOUT} # v5.1.0`)],
    ["constructor as the tag comment", step(`actions/checkout@${CHECKOUT} # constructor`)],
    ["__proto__ as the tag comment", step(`actions/checkout@${CHECKOUT} # __proto__`)],
    ["toString as the tag comment", step(`actions/checkout@${CHECKOUT} # toString`)],
    ["hasOwnProperty as the tag comment", step(`actions/checkout@${CHECKOUT} # hasOwnProperty`)],
    ["constructor as a path", step(`actions/checkout/constructor@${CHECKOUT} # v5.1.0`)],
    ["__proto__ as a path", step(`actions/checkout/__proto__@${CHECKOUT} # v5.1.0`)],
    ["a reusable workflow under constructor/prototype", job(`constructor/prototype/.github/workflows/y.yml@${CHECKOUT} # v5.1.0`)],
  ];
  for (const [name, files] of USES) {
    test(`uses: ${name} — blocked with the shipped lockfile`, () => {
      const r = check(tree(files));
      assert.equal(r.code, 1, r.out);
    });
  }

  // A lockfile that names them is refused, so even a matching uses: cannot pass.
  const good = pin("actions/checkout", "v5.1.0", CHECKOUT);
  const LOCKS = [
    ["repository constructor/checkout", [pin("constructor/checkout", "v5.1.0", CHECKOUT)], step(`constructor/checkout@${CHECKOUT} # v5.1.0`)],
    ["repository actions/__proto__", [pin("actions/__proto__", "v5.1.0", CHECKOUT)], step(`actions/__proto__@${CHECKOUT} # v5.1.0`)],
    ["repository actions/Prototype", [pin("actions/Prototype", "v5.1.0", CHECKOUT)], step(`actions/Prototype@${CHECKOUT} # v5.1.0`)],
    ["tag constructor", [pin("actions/checkout", "constructor", CHECKOUT)], step(`actions/checkout@${CHECKOUT} # constructor`)],
    ["tag __proto__", [pin("actions/checkout", "__proto__", CHECKOUT)], step(`actions/checkout@${CHECKOUT} # __proto__`)],
    ["path constructor", [pin("actions/checkout", "v5.1.0", CHECKOUT, { paths: ["constructor"] })], step(`actions/checkout/constructor@${CHECKOUT} # v5.1.0`)],
    ["path a/prototype", [pin("actions/checkout", "v5.1.0", CHECKOUT, { paths: ["a/prototype"] })], step(`actions/checkout/a/prototype@${CHECKOUT} # v5.1.0`)],
    ["a __proto__ key inside an entry", lockText([good]).replace(`"tag": "v5.1.0",`, `"tag": "v5.1.0",
      "__proto__": {"paths": ["sub"]},`), step(`actions/checkout/sub@${CHECKOUT} # v5.1.0`)],
    ["a constructor key inside an entry", lockText([good]).replace(`"tag": "v5.1.0",`, `"tag": "v5.1.0",
      "constructor": {"paths": ["sub"]},`), step(`actions/checkout@${CHECKOUT} # v5.1.0`)],
    ["a top-level __proto__ key", `{"__proto__": {"pins": []}, ${lockText([good]).slice(1)}`, step(`actions/checkout@${CHECKOUT} # v5.1.0`)],
    ["a prototype key inside paths' parent", lockText([good]).replace(`"method": "test fixture"`, `"method": "test fixture",
      "prototype": 1`), step(`actions/checkout@${CHECKOUT} # v5.1.0`)],
  ];
  for (const [name, lock, files] of LOCKS) {
    test(`lockfile with ${name}: refused, and the matching uses: is blocked`, () => {
      const r = check(tree(files), packageWithLock(lock));
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /reserved/, r.out);
    });
  }

  test("--resolve refuses reserved names as a usage error", () => {
    for (const spec of ["constructor/x@v1", "actions/__proto__@v1", "actions/checkout@constructor", "actions/checkout/prototype@v1"]) {
      assert.equal(run(REAL_BIN, ["--resolve", spec], fakeGh(RECORDED).env).code, 2, spec);
    }
  });
});

describe("the lockfile itself fails closed", () => {
  const good = pin("actions/checkout", "v5.1.0", CHECKOUT);
  const dupKey = lockText([good]).replace(`"sha": "${CHECKOUT}",`, `"sha": "${CHECKOUT}",\n      "sha": "${NODE5}",`);
  const CASES = [
    ["no lockfile at all", null, /cannot be read \(ENOENT\)/],
    ["not JSON", "{ pins: [", /is not valid JSON/],
    ["a duplicated key, which JSON.parse would resolve to the last value", dupKey, /duplicated key/],
    ["one repository in two letter cases", lockText([good, pin("Actions/checkout", "v5", CHECKOUT)]), /different letter case/],
    ["a repeated repository and tag", lockText([good, pin("actions/checkout", "v5.1.0", NODE5)]), /repeats actions\/checkout@v5\.1\.0/],
    ["an uppercase SHA", lockText([pin("actions/checkout", "v5.1.0", CHECKOUT.toUpperCase())]), /sha is not 40 lowercase hex/],
    ["a short SHA", lockText([pin("actions/checkout", "v5.1.0", CHECKOUT.slice(0, 12))]), /sha is not 40 lowercase hex/],
    ["an unknown field", lockText([{ ...good, trusted: true }]), /unknown field "trusted"/],
    ["an unknown top-level field", JSON.stringify({ lockfile_version: 1, pins: [good], allow_all: true }), /unknown field "allow_all"/],
    ["another lockfile_version", JSON.stringify({ lockfile_version: 2, pins: [good] }), /lockfile_version 2/],
    ["no pins list", JSON.stringify({ lockfile_version: 1 }), /no pins list/],
    ["an annotated tag with no tag_object", lockText([{ ...good, tag_type: "annotated" }]), /annotated tag without a 40-hex tag_object/],
    ["a lightweight tag with a tag_object", lockText([{ ...good, tag_object: PNPM_TAG_OBJECT }]), /lightweight tag but has a tag_object/],
    ["an unknown tag_type", lockText([{ ...good, tag_type: "signed" }]), /tag_type is neither/],
    ["a path with ..", lockText([{ ...good, paths: ["../x"] }]), /not a plain relative path/],
    ["an empty paths list", lockText([{ ...good, paths: [] }]), /paths is not a non-empty list/],
    ["a bad resolved_at", lockText([{ ...good, resolved_at: "yesterday" }]), /resolved_at is not a UTC timestamp/],
    ["an empty method", lockText([{ ...good, method: " " }]), /method is empty/],
    ["a repository with a path", lockText([{ ...good, repository: "actions/checkout/sub" }]), /repository is not owner\/repo/],
    ["a tag with ..", lockText([{ ...good, tag: "v5..1" }]), /tag is not a tag name/],
  ];
  for (const [name, text, why] of CASES) {
    test(`${name}: blocked even when the tree's pin is right, and even with no remote pin`, () => {
      const bin = packageWithLock(text);
      for (const files of [step(`actions/checkout@${CHECKOUT} # v5.1.0`), step("./local"), {}]) {
        const r = check(tree({ ...files, "local/action.yml": "runs: {using: composite, steps: []}\n" }), bin);
        assert.equal(r.code, 1, r.out);
        assert.equal(r.stdout.split("\n")[0], "check-action-pins: protocol 3");
        assert.match(r.out, why, r.out);
      }
    });
  }

  test("an empty pins list approves nothing", () => {
    const r = check(tree(step(`actions/checkout@${CHECKOUT} # v5.1.0`)), packageWithLock([]));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /is not in the reviewed lockfile/);
  });
});

describe("--verify-lock against recorded GitHub API responses", () => {
  const verify = (bin, routes = RECORDED) => {
    const gh = fakeGh(routes);
    return { ...run(bin, ["--verify-lock"], gh.env), calls: gh.calls() };
  };
  const endpoints = (calls) => calls.map((a) => a[a.length - 1]);

  test("the shipped lockfile verifies, dereferencing pnpm/action-setup's annotated tag", () => {
    const r = verify(REAL_BIN);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK — 5 lockfile pins match their tags in the upstream repositories/);
    assert.ok(endpoints(r.calls).includes(`repos/pnpm/action-setup/git/tags/${PNPM_TAG_OBJECT}`));
    assert.ok(endpoints(r.calls).includes("repos/actions/setup-node/git/ref/tags/v5.0.0"));
  });

  const FAIL = [
    ["the setup-node fork commit locked as v5.0.0", [pin("actions/setup-node", "v5.0.0", IMPOSTOR_NODE)], {}, new RegExp(`the upstream tag's commit is ${NODE5}, not the locked ${IMPOSTOR_NODE}`)],
    ["the upload-artifact fork commit locked as v7.0.1", [pin("actions/upload-artifact", "v7.0.1", IMPOSTOR_UPLOAD)], {}, new RegExp(`the upstream tag's commit is ${UPLOAD}, not the locked ${IMPOSTOR_UPLOAD}`)],
    ["an older release locked under the newer tag", [pin("actions/setup-node", "v5.0.0", NODE44)], {}, new RegExp(`commit is ${NODE5}, not the locked ${NODE44}`)],
    ["an annotated tag's tag object locked as if it were the commit", [pin("pnpm/action-setup", "v4.3.0", PNPM_TAG_OBJECT, { tag_type: "annotated", tag_object: PNPM_TAG_OBJECT })], {}, new RegExp(`commit is ${PNPM}, not the locked ${PNPM_TAG_OBJECT}`)],
    ["an annotated tag recorded as lightweight", [pin("pnpm/action-setup", "v4.3.0", PNPM)], {}, /the tag was re-created after review/],
    ["a tag upstream does not have (404)", [pin("actions/setup-node", "v9.9.9", NODE5)], {}, /git\/ref\/tags\/v9\.9\.9 failed, so this could not be verified and fails closed: gh: Not Found \(HTTP 404\)/],
    ["a repository that does not exist (404)", [pin("actions/nope", "v1.0.0", NODE5)], {}, /repos\/actions\/nope failed.*fails closed/],
    ["a non-JSON response", [pin("actions/setup-node", "v5.0.0", NODE5)], { "repos/actions/setup-node/git/ref/tags/v5.0.0": { __raw: "<html>rate limited</html>" } }, /the response is not JSON/],
    ["a JSON response that is not an object", [pin("actions/setup-node", "v5.0.0", NODE5)], { "repos/actions/setup-node/git/ref/tags/v5.0.0": "ok" }, /did not return a JSON object/],
    ["a renamed or transferred repository", [pin("actions/setup-node", "v5.0.0", NODE5)], { "repos/actions/setup-node": { ...RECORDED["repos/actions/setup-node"], full_name: "actions/setup-node-v2" } }, /renamed or transferred/],
    ["the lockfile's casing is not GitHub's", [pin("Actions/Setup-Node", "v5.0.0", NODE5)], { "repos/Actions/Setup-Node": RECORDED["repos/actions/setup-node"] }, /renamed or transferred, or the lockfile does not use GitHub's spelling/],
    ["a ref answer for a different tag", [pin("actions/setup-node", "v5.0.0", NODE5)], { "repos/actions/setup-node/git/ref/tags/v5.0.0": { ...RECORDED["repos/actions/setup-node/git/ref/tags/v5.0.0"], ref: "refs/tags/v5" } }, /returned "refs\/tags\/v5", not refs\/tags\/v5\.0\.0/],
    ["a tag that points at a tree", [pin("actions/setup-node", "v5.0.0", NODE5)], { "repos/actions/setup-node/git/ref/tags/v5.0.0": { ref: "refs/tags/v5.0.0", object: { sha: NODE5, type: "tree" } } }, /points at a "tree", not a commit/],
    ["an annotated tag object named for another tag", [pin("pnpm/action-setup", "v4.3.0", PNPM, { tag_type: "annotated", tag_object: PNPM_TAG_OBJECT })], { [`repos/pnpm/action-setup/git/tags/${PNPM_TAG_OBJECT}`]: { ...RECORDED[`repos/pnpm/action-setup/git/tags/${PNPM_TAG_OBJECT}`], tag: "v4.2.0" } }, /is named "v4\.2\.0"/],
    ["a listed path upstream does not have", [pin("actions/checkout", "v5.1.0", CHECKOUT, { paths: ["sub"] })], {}, /contents\/sub\?ref=.*fails closed/],
    ["a listed action path with no action.yml", [pin("actions/checkout", "v5.1.0", CHECKOUT, { paths: ["sub"] })], { [`repos/actions/checkout/contents/sub?ref=${CHECKOUT}`]: [{ name: "README.md", type: "file" }] }, /sub has no action\.yml or action\.yaml/],
    ["a listed workflow path that is a directory", [pin("actions/checkout", "v5.1.0", CHECKOUT, { paths: [".github/workflows/y.yml"] })], { [`repos/actions/checkout/contents/.github/workflows/y.yml?ref=${CHECKOUT}`]: [] }, /is not a workflow file/],
  ];
  for (const [name, pins, overrides, why] of FAIL) {
    test(`${name}: fails`, () => {
      const r = verify(packageWithLock(pins), { ...RECORDED, ...overrides });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, why, r.out);
      assert.doesNotMatch(r.out, /^OK/m, r.out);
    });
  }

  test("nested annotated tags past the bound fail", () => {
    const shas = Array.from({ length: 10 }, (_, i) => String(i).repeat(40));
    const routes = { ...RECORDED, "repos/actions/setup-node/git/ref/tags/v5.0.0": { ref: "refs/tags/v5.0.0", object: { sha: shas[0], type: "tag" } } };
    shas.forEach((s, i) => {
      routes[`repos/actions/setup-node/git/tags/${s}`] = { sha: s, tag: "v5.0.0", object: { sha: shas[i + 1] ?? NODE5, type: shas[i + 1] ? "tag" : "commit" } };
    });
    const r = verify(packageWithLock([pin("actions/setup-node", "v5.0.0", NODE5, { tag_type: "annotated", tag_object: shas[0] })]), routes);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /nests more than 8 annotated tag objects/);
  });

  test("listed paths that exist upstream verify", () => {
    const pins = [pin("actions/checkout", "v5.1.0", CHECKOUT, { paths: ["sub", ".github/workflows/y.yml"] })];
    const r = verify(packageWithLock(pins), {
      ...RECORDED,
      [`repos/actions/checkout/contents/sub?ref=${CHECKOUT}`]: [{ name: "action.yaml", type: "file" }],
      [`repos/actions/checkout/contents/.github/workflows/y.yml?ref=${CHECKOUT}`]: { type: "file", name: "y.yml" },
    });
    assert.equal(r.code, 0, r.out);
  });

  test("one bad entry fails the run, and the good ones are still reported", () => {
    const r = verify(packageWithLock([pin("actions/checkout", "v5.1.0", CHECKOUT), pin("actions/setup-node", "v5.0.0", IMPOSTOR_NODE)]));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✓ actions\/checkout@v5\.1\.0/);
    assert.match(r.out, /1 of 2 lockfile pins do not match/);
  });

  test("with no gh on PATH it fails closed", () => {
    const r = run(packageWithLock([pin("actions/checkout", "v5.1.0", CHECKOUT)]), ["--verify-lock"], { PATH: path.dirname(process.execPath) });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /fails closed: ENOENT/);
  });

  test("an empty or unreadable lockfile verifies nothing and fails", () => {
    assert.match(verify(packageWithLock([])).out, /has no pins, so nothing was verified/);
    assert.equal(verify(packageWithLock([])).code, 1);
    assert.equal(verify(packageWithLock(null)).code, 1);
  });

  test("it is its own mode: combined with --root, --list, --require or --resolve it is a usage error", () => {
    for (const extra of [["--root", tmpdir()], ["--list"], ["--require"], ["--resolve", "actions/checkout@v5.1.0"]]) {
      assert.equal(run(REAL_BIN, ["--verify-lock", ...extra]).code, 2, extra.join(" "));
    }
  });
});

describe("--resolve prints a verified entry", () => {
  const resolve = (spec, routes = RECORDED) => run(REAL_BIN, ["--resolve", spec], fakeGh(routes).env);

  test("an annotated tag: dereferenced, with the tag object recorded, and the entry round-trips", () => {
    const r = resolve("pnpm/action-setup@v4.3.0");
    assert.equal(r.code, 0, r.out);
    const entry = JSON.parse(r.stdout);
    assert.equal(entry.sha, PNPM);
    assert.equal(entry.tag_type, "annotated");
    assert.equal(entry.tag_object, PNPM_TAG_OBJECT);
    assert.match(entry.method, new RegExp(`git/ref/tags/v4\\.3\\.0 \\+ gh api repos/pnpm/action-setup/git/tags/${PNPM_TAG_OBJECT}`));
    assert.match(entry.resolved_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const bin = packageWithLock([entry]);
    assert.equal(check(tree(step(`pnpm/action-setup@${PNPM} # v4.3.0`)), bin).code, 0);
    assert.equal(run(bin, ["--verify-lock"], fakeGh(RECORDED).env).code, 0);
  });

  test("a lightweight tag has no tag_object", () => {
    const entry = JSON.parse(resolve("actions/setup-node@v5.0.0").stdout);
    assert.equal(entry.sha, NODE5);
    assert.equal(entry.tag_type, "lightweight");
    assert.ok(!("tag_object" in entry));
  });

  test("a path is verified and recorded", () => {
    const routes = { ...RECORDED, [`repos/actions/checkout/contents/sub?ref=${CHECKOUT}`]: [{ name: "action.yml", type: "file" }] };
    const r = resolve("actions/checkout/sub@v5.1.0", routes);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout).paths, ["sub"]);
    assert.equal(resolve("actions/checkout/missing@v5.1.0").code, 1);
  });

  test("a tag upstream does not have fails", () => {
    const r = resolve("actions/setup-node@v9.9.9");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /404/);
  });

  test("a spec that is not owner/repo[/path]@tag is a usage error", () => {
    for (const spec of ["actions/checkout", "actions/checkout@", "actions@v1", "a/b@v1@v2", "a/b/../c@v1", `actions/checkout@${CHECKOUT}x..y`]) {
      assert.equal(resolve(spec).code, 2, spec);
    }
  });
});

describe("live against GitHub (opt-in: CHECK_ACTION_PINS_LIVE=1)", { skip: process.env.CHECK_ACTION_PINS_LIVE !== "1" }, () => {
  const live = (bin, args) => run(bin, args, process.env);

  test("the shipped lockfile matches the upstream tags today", () => {
    const r = live(REAL_BIN, ["--verify-lock"]);
    assert.equal(r.code, 0, r.out);
  });

  test("both fork commits fail online, naming the real tag commit", () => {
    const r = live(packageWithLock([pin("actions/setup-node", "v5.0.0", IMPOSTOR_NODE), pin("actions/upload-artifact", "v7.0.1", IMPOSTOR_UPLOAD)]), ["--verify-lock"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`commit is ${NODE5}, not the locked ${IMPOSTOR_NODE}`));
    assert.match(r.out, new RegExp(`commit is ${UPLOAD}, not the locked ${IMPOSTOR_UPLOAD}`));
  });
});
