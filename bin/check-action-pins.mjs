#!/usr/bin/env node
/**
 * Fail if any GitHub Action is referenced by a mutable ref.
 *
 * A tag is not a pin. `actions/checkout@v5` resolves through a tag the upstream
 * owner can move at any time, so the code CI runs tomorrow need not be the code
 * anyone reviewed today. That is not hypothetical: in March 2025 tj-actions'
 * tags were retagged onto a commit that dumped runner memory — including
 * secrets — into build logs, across every repo that had pinned by tag.
 *
 * Only a full 40-character commit SHA is immutable. Every third-party action
 * must be pinned to one, with the human-readable version in a trailing comment
 * so Renovate (and people) can still see what it is:
 *
 *   uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
 *
 * Exempt, because neither can be moved by a third party:
 *   - local actions  (./.github/actions/foo)
 *   - reusable workflows in this same repository (./.github/workflows/x.yml)
 *   - docker digests (docker://image@sha256:...)
 *
 * Usage:
 *   node check-action-pins.mjs            # check, exit 1 on any violation
 *   node check-action-pins.mjs --list     # print every action ref and its state
 *   node check-action-pins.mjs --require  # also fail when there is nothing to check
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const LIST = process.argv.includes("--list");
// A check that reports success without checking anything is the failure shape
// this tool exists to eliminate. --require turns "nothing found" into a failure,
// for repos that know they have workflows and want a mis-glob to be loud.
const REQUIRE = process.argv.includes("--require");

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const SHA40 = /^[0-9a-f]{40}$/;
const USES = /^\s*-?\s*uses:\s*(['"]?)([^'"\s#]+)\1\s*(#.*)?$/;

/** Workflow files plus any composite actions defined in this repo. */
function workflowFiles() {
  const out = [];
  const wfDir = path.join(repoRoot, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) {
      if (/\.ya?ml$/.test(f)) out.push(path.join(wfDir, f));
    }
  }
  const actDir = path.join(repoRoot, ".github", "actions");
  if (existsSync(actDir)) {
    for (const d of readdirSync(actDir)) {
      const p = path.join(actDir, d);
      if (!statSync(p).isDirectory()) continue;
      for (const name of ["action.yml", "action.yaml"]) {
        const f = path.join(p, name);
        if (existsSync(f)) out.push(f);
      }
    }
  }
  return out;
}

const violations = [];
const listed = [];

for (const file of workflowFiles()) {
  const rel = path.relative(repoRoot, file);
  const lines = readFileSync(file, "utf8").split("\n");

  lines.forEach((line, i) => {
    const m = USES.exec(line);
    if (!m) return;
    const ref = m[2];
    const comment = (m[3] ?? "").trim();
    const lineNo = i + 1;

    // Local action or reusable workflow in this repo: nothing third-party to move.
    if (ref.startsWith("./")) {
      listed.push({ rel, lineNo, ref, state: "local" });
      return;
    }

    if (ref.startsWith("docker://")) {
      if (ref.includes("@sha256:")) {
        listed.push({ rel, lineNo, ref, state: "digest" });
      } else {
        violations.push({
          rel,
          lineNo,
          ref,
          why: "docker image referenced by tag, not digest",
          fix: "pin to docker://image@sha256:<digest>",
        });
      }
      return;
    }

    const at = ref.lastIndexOf("@");
    if (at === -1) {
      violations.push({
        rel,
        lineNo,
        ref,
        why: "no ref at all — resolves to the default branch",
        fix: "pin to a full 40-character commit SHA",
      });
      return;
    }

    const name = ref.slice(0, at);
    const version = ref.slice(at + 1);

    if (!SHA40.test(version)) {
      violations.push({
        rel,
        lineNo,
        ref,
        why: `pinned to the mutable ref "${version}" — the owner can move it at any time`,
        fix: `pin to a full 40-character commit SHA, e.g.\n      uses: ${name}@<sha> # ${version}\n    resolve it with: gh api repos/${name}/commits/${version} --jq .sha`,
      });
      return;
    }

    // SHA-pinned, but keep the version legible for humans and Renovate.
    if (!/^#\s*v?\d/.test(comment)) {
      violations.push({
        rel,
        lineNo,
        ref,
        why: "SHA-pinned but missing the version comment",
        fix: `add a trailing comment naming the version, e.g. "# v5.1.0", so the pin stays reviewable and Renovate can track it`,
      });
      return;
    }

    listed.push({ rel, lineNo, ref: `${name}@${version.slice(0, 12)}…`, state: `pinned ${comment.replace(/^#\s*/, "")}` });
  });
}

if (LIST) {
  for (const l of [...listed].sort((a, b) => a.rel.localeCompare(b.rel) || a.lineNo - b.lineNo)) {
    console.log(`  ${l.rel}:${l.lineNo}  ${l.ref}  [${l.state}]`);
  }
  for (const v of violations) {
    console.log(`  ${v.rel}:${v.lineNo}  ${v.ref}  [UNPINNED]`);
  }
}

if (violations.length === 0) {
  const n = listed.length;
  if (n === 0) {
    // Say what actually happened. "OK — 0 references, all pinned" reads like a
    // check that ran and passed; this one found nothing to inspect.
    const msg = "No GitHub Action references found — nothing was checked.";
    if (REQUIRE) {
      console.error(`✗ ${msg}`);
      console.error("  --require was passed, so this is a failure: either the workflows");
      console.error("  are missing or they are not where this expected to find them");
      console.error("  (.github/workflows/*.y[a]ml, .github/actions/*/action.y[a]ml).");
      process.exit(1);
    }
    console.log(msg);
    process.exit(0);
  }
  console.log(`OK — ${n} action reference${n === 1 ? "" : "s"}, all pinned to an immutable ref.`);
  process.exit(0);
}

console.error("");
for (const v of violations) {
  console.error(`✗ ${v.rel}:${v.lineNo}`);
  console.error(`    uses: ${v.ref}`);
  console.error(`    ${v.why}`);
  console.error(`    fix: ${v.fix}`);
  console.error("");
}
console.error(
  `${violations.length} unpinned action reference${violations.length === 1 ? "" : "s"}.\n` +
    `A tag is not a pin: the owner can move it, so CI would run code nobody reviewed.\n`,
);
process.exit(1);
