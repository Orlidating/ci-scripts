/**
 * Every image a workflow pulls must be a reviewed lockfile entry (backend#426).
 *
 * A digest fixes the bytes. It does not say who published them, or whether anyone looked at
 * them. Before this change `check-action-pins --require` exited 0 on
 * `uses: docker://evil.example.com/pwn@sha256:<64 hex>`, while the equivalent action pin
 * needed a reviewed lockfile entry — so the gate was strict about code from GitHub and
 * indifferent to code from any registry on earth.
 *
 * The rule is the one actions already get, applied to all four surfaces an image can be
 * pulled from: `uses: docker://…`, an action's `runs.image`, `jobs.<id>.container` and
 * `jobs.<id>.services.<id>.image`. Name and digest must be one entry; a tag written beside
 * the digest must be that entry's tag, because the tag is what a reviewer reads.
 *
 * There is deliberately no --verify-lock for images: a git tag can be re-pointed upstream,
 * which is what --verify-lock catches for pins, but a manifest digest is content-addressed
 * and cannot be, so a reviewed image entry cannot drift after review.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { img, lockText, packageWithLock, pin } from "./lock-package.mjs";

const SHA = "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09";
const REVIEWED = `sha256:${"a".repeat(64)}`;
const STALE = `sha256:${"b".repeat(64)}`;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Two reviewed images that record a tag, and one that does not.
const BIN = packageWithLock({
  pins: [pin("actions/checkout", "v5.1.0", SHA)],
  images: [img("ghcr.io/owner/tool", REVIEWED, { tag: "v2.1.0" }), img("postgres", REVIEWED, { tag: "16" }), img("alpine", REVIEWED)],
});

function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "pins-imagelock-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
const run = (dir, bin = BIN, ...args) => {
  const r = spawnSync("node", [bin, "--root", dir, ...args], { cwd: tmpdir(), encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const H = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n";
const PINNED_STEP = `    steps:\n      - uses: actions/checkout@${SHA} # v5.1.0\n`;
// The four surfaces an image reaches the runner through.
const SURFACES = {
  "uses: docker://": (image) => ({ ".github/workflows/x.yml": `${H}    steps:\n      - uses: docker://${image}\n` }),
  "an action's runs.image": (image) => ({ ".github/actions/d/action.yml": `runs:\n  using: docker\n  image: docker://${image}\n` }),
  "a job container": (image) => ({ ".github/workflows/x.yml": `${H}    container: ${image}\n${PINNED_STEP}` }),
  "a service image": (image) => ({ ".github/workflows/x.yml": `${H}    services:\n      db:\n        image: ${image}\n${PINNED_STEP}` }),
};

describe("an image passes only as a reviewed entry, on every surface (backend#426)", () => {
  for (const [surface, files] of Object.entries(SURFACES)) {
    test(`${surface}: the reviewed name and digest pass`, () => {
      const r = run(tree(files(`ghcr.io/owner/tool:v2.1.0@${REVIEWED}`)));
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /all pinned/, r.out);
    });

    test(`${surface}: an attacker's registry is refused, digest and all`, () => {
      const r = run(tree(files(`evil.example.com/pwn@${REVIEWED}`)));
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /the image "evil\.example\.com\/pwn" is not in the reviewed lockfile/, r.out);
      assert.doesNotMatch(r.out, /all pinned/, r.out);
    });

    test(`${surface}: a stale digest under a reviewed name is refused`, () => {
      const r = run(tree(files(`ghcr.io/owner/tool:v2.1.0@${STALE}`)));
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /is not a reviewed digest of "ghcr\.io\/owner\/tool"/, r.out);
    });

    test(`${surface}: a tag that is not the reviewed one is refused, even with the reviewed digest`, () => {
      const r = run(tree(files(`ghcr.io/owner/tool:v9.9.9@${REVIEWED}`)));
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /is not the reviewed tag for/, r.out);
    });

    test(`${surface}: the reviewed digest with no tag passes`, () => {
      const r = run(tree(files(`ghcr.io/owner/tool@${REVIEWED}`)));
      assert.equal(r.code, 0, r.out);
    });

    test(`${surface}: a tag on an entry that records none is refused`, () => {
      const r = run(tree(files(`alpine:3@${REVIEWED}`)));
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /the entry records no tag/, r.out);
    });
  }

  test("one reviewed image does not approve another name with the same digest", () => {
    const r = run(tree(SURFACES["a job container"](`redis@${REVIEWED}`)));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /the image "redis" is not in the reviewed lockfile/, r.out);
  });

  test("a lockfile with no images approves no image at all", () => {
    const bin = packageWithLock({ pins: [pin("actions/checkout", "v5.1.0", SHA)] });
    const r = run(tree(SURFACES["a job container"](`postgres@${REVIEWED}`)), bin);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /is not in the reviewed lockfile/, r.out);
  });

  test("the message says a digest is not a review, so the fix is not 'add a digest'", () => {
    const r = run(tree(SURFACES["uses: docker://"](`evil.example.com/pwn@${REVIEWED}`)));
    assert.match(r.out, /not that anyone reviewed them or that they came from where you think/, r.out);
    assert.match(r.out, /fix: in a ci-scripts PR, add to action-pins\.lock\.json's images/, r.out);
  });

  test("--list says the image was found in the lockfile, not merely that it has a digest", () => {
    const r = run(tree(SURFACES["a job container"](`postgres:16@${REVIEWED}`)), BIN, "--list");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[digest, reviewed in action-pins\.lock\.json\]/, r.out);
  });
});

describe("the images list itself fails closed", () => {
  const good = pin("actions/checkout", "v5.1.0", SHA);
  const CASES = [
    ["images is not a list", JSON.stringify({ lockfile_version: 1, pins: [good], images: {} }), /images field that is not a list/],
    ["an image with no digest", lockText({ pins: [good], images: [{ image: "postgres", resolved_at: "2026-09-15T00:00:00Z", method: "t" }] }), /digest is not sha256:<64 lowercase hex>/],
    ["an uppercase digest", lockText({ pins: [good], images: [img("postgres", `sha256:${"A".repeat(64)}`)] }), /digest is not sha256:<64 lowercase hex>/],
    ["a digest of another algorithm", lockText({ pins: [good], images: [img("postgres", `sha512:${"a".repeat(64)}`)] }), /digest is not sha256:<64 lowercase hex>/],
    ["an image name carrying its digest", lockText({ pins: [good], images: [img(`postgres@${REVIEWED}`, REVIEWED)] }), /is not an image name|must be the name alone/],
    ["an uppercase image name", lockText({ pins: [good], images: [img("Postgres", REVIEWED)] }), /is not an image name/],
    ["an unknown field on an image", lockText({ pins: [good], images: [{ ...img("postgres", REVIEWED), trusted: true }] }), /unknown field "trusted"/],
    ["a bad tag", lockText({ pins: [good], images: [img("postgres", REVIEWED, { tag: "no spaces allowed" })] }), /tag is not an image tag/],
    ["a bad resolved_at", lockText({ pins: [good], images: [img("postgres", REVIEWED, { resolved_at: "yesterday" })] }), /resolved_at is not a UTC timestamp/],
    ["an empty method", lockText({ pins: [good], images: [img("postgres", REVIEWED, { method: " " })] }), /method is empty/],
    ["the same image and digest twice", lockText({ pins: [good], images: [img("postgres", REVIEWED), img("postgres", REVIEWED)] }), /repeats postgres@/],
    ["a reserved image name", lockText({ pins: [good], images: [img("constructor", REVIEWED)] }), /reserved/],
  ];
  for (const [name, text, why] of CASES) {
    test(`${name}: the whole lockfile is refused, so nothing it holds approves anything`, () => {
      const bin = packageWithLock(text);
      // Even a tree whose action pin is perfect, and one with nothing remote at all.
      for (const files of [SURFACES["uses: docker://"](`postgres@${REVIEWED}`), { ".github/workflows/x.yml": `${H}${PINNED_STEP}` }]) {
        const r = run(tree(files), bin);
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, why, r.out);
      }
    });
  }

  test("two entries for one image with different digests are allowed, and each is matched exactly", () => {
    const bin = packageWithLock({
      pins: [pin("actions/checkout", "v5.1.0", SHA)],
      images: [img("postgres", REVIEWED, { tag: "16" }), img("postgres", STALE, { tag: "15" })],
    });
    assert.equal(run(tree(SURFACES["a job container"](`postgres:16@${REVIEWED}`)), bin).code, 0);
    assert.equal(run(tree(SURFACES["a job container"](`postgres:15@${STALE}`)), bin).code, 0);
    // The digests must not become interchangeable just because the name is reviewed.
    assert.equal(run(tree(SURFACES["a job container"](`postgres:16@${STALE}`)), bin).code, 1);
  });
});
