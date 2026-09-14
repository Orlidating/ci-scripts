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
 * Exempt, because no third party can move them — but FOLLOWED, because what
 * they run is graded too:
 *   - local actions (./path/to/dir, or $/path inside a composite action): the
 *     action.yml / action.yaml there is read and its references checked
 *   - reusable workflows in this repository (./.github/workflows/x.yml): read too
 *   - docker digests (docker://image@sha256:<64 hex>)
 *
 * How references are found (backend#255, backend#256): every file is PARSED with
 * `yaml`, pinned exactly in package.json — the library GitHub's own workflow
 * parser (actions/languageservices, @actions/workflow-parser) reads workflows
 * with, called the way it calls it: parseDocument(…, { uniqueKeys: false }).
 * An earlier version matched lines with a regex, so flow style
 * (`steps: [{uses: …}]`), a quoted or escaped key (`"u\x73es":`), an explicit
 * key (`? uses`), a value on the next line, an anchor or a `!!str` tag hid a
 * tag-pinned Action. Pattern-matching a structured language is always one
 * spelling behind; the parser is not.
 *
 * What is read, following GitHub's schema, and decided per reference:
 *   workflows  .github/workflows/*.y[a]ml          jobs.<id>.uses, jobs.<id>.steps[*].uses
 *   actions    .github/actions/** /action.y[a]ml    runs.steps[*].uses, runs.image (docker://)
 *              and every action a local reference names, anywhere in the tree
 * Keys match case-insensitively, a duplicated key contributes every value,
 * aliases are resolved and a `<<` merge key contributes what it merges (GitHub
 * supports anchors but not merge keys; reading both is the superset). A file
 * that is not valid YAML — including one holding several documents, which
 * parseDocument refuses — is a failure, never a skip: GitHub would not run it,
 * so it cannot be a legitimate push, and a file this cannot read is not a file
 * that passed. So is a symlink on any path this reads, a local reference that
 * does not exist, and local references nested deeper than MAX_DEPTH.
 *
 * Usage:
 *   check-action-pins                 # check the git working tree's root
 *   check-action-pins --root <dir>    # check a directory (no git needed); prints
 *                                     # "check-action-pins: protocol 2" first
 *   check-action-pins --list          # print every action ref and its state
 *   check-action-pins --require       # also fail when there is nothing to check
 *
 * Exit: 0 all pinned (or nothing to check), 1 violations, 2 bad usage.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

// Callers that must not be graded by an older copy of this tool (the orlidating
// pre-push hook) require this exact line. A version that ignored --root would
// otherwise grade whatever directory it ran in and could exit 0.
export const PROTOCOL = "check-action-pins: protocol 2";

const MAX_DEPTH = 16; // local actions using local actions, and directory nesting
const MAX_BYTES = 1024 * 1024;
const MAX_VISITS = 200_000; // AST nodes per file, against merge-key blowups
const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

function usage(msg) {
  console.error(`check-action-pins: ${msg}`);
  console.error("usage: check-action-pins [--root <dir>] [--list] [--require]");
  process.exit(2);
}

let LIST = false;
let REQUIRE = false;
let rootArg = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--list") LIST = true;
  // A check that reports success without checking anything is the failure shape
  // this tool exists to eliminate. --require turns "nothing found" into a failure.
  else if (a === "--require") REQUIRE = true;
  else if (a === "--root") {
    if (i + 1 >= argv.length) usage("--root needs a directory");
    rootArg = argv[++i];
  } else usage(`unknown argument ${JSON.stringify(a)}`);
}

let repoRoot;
if (rootArg !== null) {
  console.log(PROTOCOL);
  repoRoot = path.resolve(rootArg);
  let st;
  try {
    st = lstatSync(repoRoot);
  } catch {
    usage(`--root ${rootArg} does not exist`);
  }
  if (!st.isDirectory()) usage(`--root ${rootArg} is not a directory`);
} else {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

const violations = [];
const listed = [];
const fail = (rel, lineNo, ref, why, fix) => violations.push({ rel, lineNo, ref, why, fix });

// ---------------------------------------------------------------------------
// The tree: every path component is lstat'ed, so a symlink is refused wherever
// it sits, never followed out of the tree.
// ---------------------------------------------------------------------------
/** "file" | "dir" | "missing" | { link: <rel of the symlink> } | "other" */
function kindOf(rel) {
  const parts = rel.split("/").filter(Boolean);
  let cur = repoRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return "missing";
    }
    if (st.isSymbolicLink()) return { link: parts.slice(0, i + 1).join("/") };
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) return "missing";
    if (last) return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  }
  return "dir";
}

const LINK_FIX = "commit the file itself; this check reads files in the tree and does not follow links";

// Queue of files to parse: { rel, kind: "workflow" | "action", depth }.
const queue = [];
const queued = new Set();
function enqueue(rel, kind, depth) {
  const key = `${kind}:${rel}`;
  if (queued.has(key)) return; // a cycle, or two references to one action
  queued.add(key);
  queue.push({ rel, kind, depth });
}

function discover() {
  for (const dir of [".github", ".github/workflows", ".github/actions"]) {
    const k = kindOf(dir);
    if (typeof k === "object") {
      fail(k.link, 0, "", "is a symlink, so the workflows GitHub would run are not in this tree", LINK_FIX);
      return;
    }
  }
  if (kindOf(".github/workflows") === "dir") {
    for (const name of readdirSync(path.join(repoRoot, ".github/workflows")).sort()) {
      // GitHub runs .y[a]ml files directly in .github/workflows, nothing in subdirectories.
      if (!/\.ya?ml$/.test(name)) continue;
      const rel = `.github/workflows/${name}`;
      const k = kindOf(rel);
      if (typeof k === "object") fail(rel, 0, "", "is a symlink, which this check does not follow", LINK_FIX);
      else if (k === "file") enqueue(rel, "workflow", 0);
    }
  }
  const walk = (rel, depth) => {
    if (depth > MAX_DEPTH) {
      fail(rel, 0, "", `is nested more than ${MAX_DEPTH} directories deep, so it was not read`, "flatten .github/actions");
      return;
    }
    for (const name of readdirSync(path.join(repoRoot, rel)).sort()) {
      const child = `${rel}/${name}`;
      const k = kindOf(child);
      if (typeof k === "object") fail(child, 0, "", "is a symlink under .github/actions, which this check does not follow", LINK_FIX);
      else if (k === "dir") walk(child, depth + 1);
      else if (k === "file" && (name === "action.yml" || name === "action.yaml")) enqueue(child, "action", 0);
    }
  };
  if (kindOf(".github/actions") === "dir") walk(".github/actions", 0);
}

// ---------------------------------------------------------------------------
// YAML: the AST is walked, so each reference keeps its line and comment.
// ---------------------------------------------------------------------------
function makeReader(doc, rel) {
  let visits = 0;
  const tick = () => {
    if (++visits > MAX_VISITS) throw new Error(`more than ${MAX_VISITS} YAML nodes reached through aliases and merge keys`);
  };
  const resolve = (node) => {
    const seen = new Set();
    while (isAlias(node)) {
      tick();
      if (seen.has(node)) return null;
      seen.add(node);
      node = node.resolve(doc);
    }
    return node ?? null;
  };
  /** Every { name, key, value } of a mapping: aliases resolved, `<<` merged in. */
  const entries = (node, stack = new Set()) => {
    const map = resolve(node);
    if (!isMap(map) || stack.has(map)) return [];
    stack.add(map);
    const out = [];
    for (const pair of map.items) {
      tick();
      const key = resolve(pair.key);
      if (!isScalar(key) || key.value === null || typeof key.value === "object") continue;
      const name = String(key.value);
      if (name === "<<") {
        const src = resolve(pair.value);
        const sources = isSeq(src) ? src.items : [src];
        for (const s of sources) out.push(...entries(s, stack));
        continue;
      }
      out.push({ name: name.toLowerCase(), key: pair.key, value: pair.value });
    }
    stack.delete(map);
    return out;
  };
  const get = (node, name) => entries(node).filter((e) => e.name === name);
  /** Items of a sequence value, or null (with a failure) when it is some other shape. */
  const items = (entry, what) => {
    const v = resolve(entry.value);
    if (v === null || (isScalar(v) && v.value === null)) return [];
    if (isSeq(v)) return v.items;
    fail(rel, 0, "", `${what} is not a list, so GitHub's reading of it is unknown`, "write it as a YAML sequence");
    return [];
  };
  return { resolve, entries, get, items };
}

function lineOf(lc, node) {
  const at = node?.range?.[0];
  return typeof at === "number" ? lc.linePos(at).line : 0;
}

/** The references GitHub executes in one parsed file. */
function referencesIn(doc, lc, rel, kind) {
  const r = makeReader(doc, rel);
  const refs = []; // { entry, form: "step" | "job" | "image" }
  if (kind === "workflow") {
    for (const jobs of r.get(doc.contents, "jobs")) {
      for (const job of r.entries(jobs.value)) {
        for (const u of r.get(job.value, "uses")) refs.push({ entry: u, form: "job" });
        for (const steps of r.get(job.value, "steps")) {
          for (const step of r.items(steps, `jobs.${job.name}.steps`)) {
            for (const u of r.get(step, "uses")) refs.push({ entry: u, form: "step" });
          }
        }
      }
    }
  } else {
    for (const runs of r.get(doc.contents, "runs")) {
      for (const steps of r.get(runs.value, "steps")) {
        for (const step of r.items(steps, "runs.steps")) {
          for (const u of r.get(step, "uses")) refs.push({ entry: u, form: "step" });
        }
      }
      for (const image of r.get(runs.value, "image")) {
        const v = r.resolve(image.value);
        if (isScalar(v) && typeof v.value === "string" && /^docker:\/\//i.test(v.value)) {
          refs.push({ entry: image, form: "image" });
        }
      }
    }
  }
  return refs.map(({ entry, form }) => {
    const scalar = r.resolve(entry.value);
    const comment = [entry.value?.comment, scalar?.comment].find((c) => typeof c === "string") ?? "";
    return {
      form,
      lineNo: lineOf(lc, entry.key) || lineOf(lc, scalar),
      value: isScalar(scalar) ? scalar.value : scalar === null ? null : "[not a scalar]",
      comment: comment.trim(),
    };
  });
}

/**
 * An independent reading through toJS (the same library's own alias and
 * duplicate-key resolution), walked by the same schema. Every reference it sees
 * must also be one the AST walk saw; a disagreement is a failure, so a bug in
 * the walk above cannot turn into a silent pass.
 */
function jsReferences(doc, kind) {
  const js = doc.toJS({ maxAliasCount: 10_000 });
  const out = [];
  const obj = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : null);
  const vals = (o, name) => {
    const res = [];
    const walk = (m, depth) => {
      if (!obj(m) || depth > MAX_DEPTH) return;
      for (const [k, v] of Object.entries(m)) {
        if (k === "<<") for (const s of Array.isArray(v) ? v : [v]) walk(s, depth + 1);
        else if (k.toLowerCase() === name) res.push(v);
      }
    };
    walk(o, 0);
    return res;
  };
  const steps = (s) => (Array.isArray(s) ? s : []);
  if (kind === "workflow") {
    for (const jobs of vals(js, "jobs")) {
      for (const job of Object.values(obj(jobs) ?? {})) {
        out.push(...vals(job, "uses"));
        for (const s of vals(job, "steps")) for (const step of steps(s)) out.push(...vals(step, "uses"));
      }
    }
  } else {
    for (const runs of vals(js, "runs")) {
      for (const s of vals(runs, "steps")) for (const step of steps(s)) out.push(...vals(step, "uses"));
      for (const image of vals(runs, "image")) if (typeof image === "string" && /^docker:\/\//i.test(image)) out.push(image);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grading one reference
// ---------------------------------------------------------------------------
function localTarget(rel, lineNo, ref, rest, form, depth) {
  const norm = path.posix.normalize(rest.replace(/\/+$/, "") || ".");
  if (norm === ".." || norm.startsWith("../") || path.posix.isAbsolute(norm)) {
    fail(rel, lineNo, ref, "local reference leaves the repository", "reference a path inside this repository");
    return;
  }
  if (depth + 1 > MAX_DEPTH) {
    fail(rel, lineNo, ref, `local references nest more than ${MAX_DEPTH} deep, so the action it names was not read`, "flatten the chain of local actions");
    return;
  }
  if (form === "job") {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(norm)) {
      fail(rel, lineNo, ref, "a local reusable workflow must be a .y[a]ml file directly in .github/workflows", "move it there");
      return;
    }
    const k = kindOf(norm);
    if (k === "file") enqueue(norm, "workflow", depth + 1);
    else if (typeof k === "object") fail(rel, lineNo, ref, `the path goes through the symlink ${k.link}, which this check does not follow`, LINK_FIX);
    else fail(rel, lineNo, ref, "names a workflow that does not exist in this tree, so GitHub would fail and nothing was checked", "fix the path");
    return;
  }
  const found = [];
  for (const name of ["action.yml", "action.yaml"]) {
    const file = norm === "." ? name : `${norm}/${name}`;
    const k = kindOf(file);
    if (typeof k === "object") {
      fail(rel, lineNo, ref, `the path goes through the symlink ${k.link}, which this check does not follow`, LINK_FIX);
      return;
    }
    if (k === "file") found.push(file);
  }
  if (found.length === 0) {
    fail(rel, lineNo, ref, `names a local action with no action.yml or action.yaml at ${norm} in this tree, so what it runs was not checked`, "fix the path, or commit the action (submodules are not followed)");
    return;
  }
  for (const f of found) enqueue(f, "action", depth + 1);
  listed.push({ rel, lineNo, ref, state: "local, followed" });
}

// ---------------------------------------------------------------------------
// The grammar of a `uses` value (backend#268)
// ---------------------------------------------------------------------------
// A reference is PARSED against GitHub's documented forms, never searched for a
// SHA. The earlier split took the text after the LAST `@`, so
// `o/r/.github/workflows/y.yml@main@<40 hex>` read as SHA-pinned, while every
// parser GitHub publishes reads a mutable ref there:
//   - @actions/workflow-parser src/workflows/file-reference.ts parseFileReference:
//     `const [remotePath, version] = ref.split("@")` — the ref is "main";
//   - github/actions-lockfile go/pkg/lockfile/uses.go splitUsesRef:
//     `strings.SplitN(uses, "@", 2)` — the ref is the branch "main@<sha>";
//   - actions/runner PipelineTemplateConverter.cs (steps): `Split('@')`, and an
//     error unless there are exactly two segments.
// Where they disagree the stricter reading wins, so exactly one `@` is allowed.
//
// The forms (docs.github.com, "Workflow syntax for GitHub Actions", jobs.<id>.uses
// and jobs.<id>.steps[*].uses; "Metadata syntax" for $/):
//   step   {owner}/{repo}@{ref}   {owner}/{repo}/{path}@{ref}   ./path   $/path
//          docker://{image}:{tag}   docker://{host}/{image}:{tag}
//   job    {owner}/{repo}/.github/workflows/{filename}@{ref}   ./.github/workflows/{filename}
//   image  (action metadata runs.image) docker://…
// What passes: {ref} is exactly 40 lowercase hex and the whole remainder after
// the one `@`; a local path; a docker reference whose digest is sha256:<64
// lowercase hex> (distribution/reference: reference := name [":" tag] ["@" digest],
// so a tag beside the digest is allowed — the digest alone names the content).
// Everything else fails closed, including a form this grammar does not know.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/; // GitHub user and organisation names
const SEGMENT = /^[A-Za-z0-9._-]+$/; // repository names and path segments
const DOCKER_NAME = /^(?:[A-Za-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const DOCKER_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DOCKER_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * { kind: "docker" | "local" | "self" | "remote", … } or { error, fix }.
 * Checks that apply to every form come first, so no form can carry them.
 */
export function parseUses(ref, form) {
  if (ref === "") return { error: "reference is empty", fix: "write owner/repo@<sha> # vX.Y.Z" };
  if (ref.includes("${{")) return { error: "reference is an expression, so what it resolves to is not in the file", fix: "write a literal owner/repo@<sha> # vX.Y.Z" };
  // \s covers tab, newline and Unicode spaces; Cc and Cf cover other controls and
  // zero-width characters that would render invisibly in review.
  if (/[\s\p{Cc}\p{Cf}]/u.test(ref)) return { error: "reference contains whitespace or an invisible or control character", fix: "remove it" };
  if (ref.includes("%")) return { error: "reference contains a URL-encoded character (%), which no documented form has", fix: "write the characters themselves" };
  if (ref.includes("\\")) return { error: "reference contains a backslash, which parsers split on differently", fix: "use forward slashes" };
  if (/^docker:/i.test(ref) && !ref.startsWith("docker://")) {
    // actions/runner matches "docker://" case-sensitively (Ordinal); anything else is a different form.
    return { error: "docker reference is not spelled exactly docker://", fix: "write docker://image@sha256:<digest>" };
  }
  if (form === "image" && !ref.startsWith("docker://")) return { error: "runs.image is not a docker:// reference", fix: "write docker://image@sha256:<digest>" };

  if (ref.startsWith("docker://")) {
    const image = ref.slice("docker://".length);
    const parts = image.split("@");
    if (parts.length > 2) return { error: "docker reference has more than one @, so its digest is ambiguous", fix: "write docker://image@sha256:<digest>" };
    if (parts.length < 2) return { error: "docker image referenced by tag, not digest", fix: "pin to docker://image@sha256:<digest>" };
    const [nameTag, digest] = parts;
    if (!DOCKER_DIGEST.test(digest)) return { error: `docker digest "${digest}" is not sha256:<64 lowercase hex>`, fix: "pin to docker://image@sha256:<digest>" };
    // A tag's colon follows the last slash; a colon before it is a registry port.
    const slash = nameTag.lastIndexOf("/");
    const colon = nameTag.lastIndexOf(":");
    const name = colon > slash ? nameTag.slice(0, colon) : nameTag;
    const tag = colon > slash ? nameTag.slice(colon + 1) : null;
    if (!DOCKER_NAME.test(name) || (tag !== null && !DOCKER_TAG.test(tag))) {
      return { error: "docker image name does not match the image reference grammar", fix: "write docker://[host/]image[:tag]@sha256:<digest>" };
    }
    return { kind: "docker" };
  }

  if (ref.startsWith("./") || ref.startsWith("$/")) {
    // No documented local form has an @ref; `./x@v1` would be a directory named
    // "x@v1" to the runner and a ref to a reader.
    if (ref.includes("@")) return { error: `a ${ref.slice(0, 2)} local reference must not contain @`, fix: "drop the @ref; a local reference runs this commit" };
    return { kind: ref.startsWith("./") ? "local" : "self", rest: ref.slice(2) };
  }

  const pieces = ref.split("@");
  if (pieces.length === 1) return { error: "no ref at all — resolves to the default branch", fix: "pin to a full 40-character commit SHA" };
  if (pieces.length > 2) {
    return {
      error: `has ${pieces.length - 1} @ separators; GitHub's parsers read the ref as "${pieces[1]}" (first @) or "${pieces.slice(1).join("@")}" (the rest), both mutable`,
      fix: "write exactly one @ followed by a full 40-character commit SHA",
    };
  }
  const [remotePath, version] = pieces;
  const segs = remotePath.split("/");
  if (segs.some((s) => s === "")) return { error: "owner, repository or path has an empty segment", fix: "write owner/repo[/path]@<sha>" };
  if (segs.length < 2) return { error: "no owner/repository before the @", fix: "write owner/repo[/path]@<sha>" };
  const [owner, repo, ...path] = segs;
  if (!OWNER.test(owner)) return { error: `owner "${owner}" is not a GitHub account name`, fix: "write owner/repo[/path]@<sha>" };
  if (!SEGMENT.test(repo) || repo === "." || repo === "..") return { error: `repository "${repo}" is not a repository name`, fix: "write owner/repo[/path]@<sha>" };
  for (const p of path) {
    if (p === "." || p === "..") return { error: "a remote path has a . or .. segment", fix: "write the path without . or .. segments" };
    if (!SEGMENT.test(p)) return { error: `path segment "${p}" has a character no action path uses`, fix: "write owner/repo[/path]@<sha>" };
  }
  const isWorkflow = path.length === 3 && path[0] === ".github" && path[1] === "workflows" && /\.ya?ml$/.test(path[2]);
  if (form === "job" && !isWorkflow) {
    return { error: "a job-level uses must name a reusable workflow, owner/repo/.github/workflows/<file>.y[a]ml@<sha>", fix: "fix the path" };
  }
  if (version === "") return { error: "the ref after @ is empty", fix: "pin to a full 40-character commit SHA" };
  if (!SHA40.test(version)) {
    return {
      error: `pinned to the mutable ref "${version}" — the owner can move it at any time`,
      fix: `pin to a full 40-character commit SHA, e.g.\n      uses: ${remotePath}@<sha> # ${version}\n    resolve it with: gh api repos/${owner}/${repo}/commits/${version} --jq .sha`,
    };
  }
  return { kind: "remote", name: remotePath, version };
}

function grade(rel, depth, { form, lineNo, value, comment }) {
  if (typeof value !== "string") {
    fail(rel, lineNo, String(value), "uses is not a string, so GitHub's reading of it is unknown", "write the reference as a plain string");
    return;
  }
  const ref = value;
  const parsed = parseUses(ref, form);
  if (parsed.error) {
    fail(rel, lineNo, ref, parsed.error, parsed.fix);
    return;
  }
  if (parsed.kind === "docker") {
    listed.push({ rel, lineNo, ref, state: "digest" });
    return;
  }
  if (parsed.kind === "local" || parsed.kind === "self") return localTarget(rel, lineNo, ref, parsed.rest, form, depth);
  const { name, version } = parsed;
  // SHA-pinned, but keep the version legible for humans and Renovate.
  if (!/^v?\d/.test(comment)) {
    fail(rel, lineNo, ref, "SHA-pinned but missing the version comment", `add a trailing comment naming the version, e.g. "# v5.1.0", so the pin stays reviewable and Renovate can track it`);
    return;
  }
  listed.push({ rel, lineNo, ref: `${name}@${version.slice(0, 12)}…`, state: `pinned ${comment}` });
}

function checkFile({ rel, kind, depth }) {
  let src;
  try {
    const buf = readFileSync(path.join(repoRoot, rel));
    if (buf.length > MAX_BYTES) {
      fail(rel, 0, "", `is larger than ${MAX_BYTES} bytes, so it was not read`, "split the file");
      return;
    }
    src = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (err) {
    fail(rel, 0, "", `cannot be read as UTF-8 text (${err.message})`, "fix the file");
    return;
  }
  const lc = new LineCounter();
  // As @actions/workflow-parser calls it (workflows/yaml-object-reader.ts).
  const doc = parseDocument(src, { lineCounter: lc, keepSourceTokens: true, uniqueKeys: false, prettyErrors: false });
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length > 0) {
    const p = problems[0];
    const line = typeof p.pos?.[0] === "number" ? lc.linePos(p.pos[0]).line : 0;
    fail(rel, line, "", `is not valid YAML, so GitHub would not run it and nothing in it was checked: ${p.code}: ${p.message.split("\n")[0]}`, "fix the YAML");
    return;
  }
  let refs;
  let jsRefs;
  try {
    refs = referencesIn(doc, lc, rel, kind);
    jsRefs = jsReferences(doc, kind);
  } catch (err) {
    fail(rel, 0, "", `could not be read to a verdict: ${err.message}`, "simplify the aliases or merge keys");
    return;
  }
  const seen = new Set(refs.map((x) => x.value));
  for (const v of jsRefs) {
    if (!seen.has(v)) {
      fail(rel, 0, String(v), "two readings of this file disagree about its references, so it was not graded", "report this to ci-scripts");
      return;
    }
  }
  for (const ref of refs) grade(rel, depth, ref);
}

discover();
while (queue.length > 0) checkFile(queue.shift());

if (LIST) {
  for (const l of [...listed].sort((a, b) => a.rel.localeCompare(b.rel) || a.lineNo - b.lineNo)) {
    console.log(`  ${l.rel}:${l.lineNo}  ${l.ref}  [${l.state}]`);
  }
  for (const v of violations) {
    console.log(`  ${v.rel}:${v.lineNo}  ${v.ref}  [UNPINNED OR UNREADABLE]`);
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
      console.error("  (.github/workflows/*.y[a]ml, .github/actions/**/action.y[a]ml).");
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
  console.error(`✗ ${v.rel}${v.lineNo ? `:${v.lineNo}` : ""}`);
  if (v.ref) console.error(`    uses: ${v.ref}`);
  console.error(`    ${v.why}`);
  console.error(`    fix: ${v.fix}`);
  console.error("");
}
console.error(
  `${violations.length} unpinned or unreadable action reference${violations.length === 1 ? "" : "s"}.\n` +
    `A tag is not a pin: the owner can move it, so CI would run code nobody reviewed.\n`,
);
process.exit(1);
