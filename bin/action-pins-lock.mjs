/**
 * The reviewed lockfile of GitHub Action pins (backend#421).
 *
 * Why a SHA is not enough: GitHub resolves `owner/repo@<sha>` for a commit that
 * exists anywhere in the repository's FORK NETWORK, under the upstream name. So
 * `actions/setup-node@a6aa7c983ce5d580d149344767c9e3f34214804c` runs a commit
 * that exists only in the fork Rchie121/setup-node, and a check that looks only
 * at the SHA's shape passes it. The compare API resolves it too (it reports the
 * commit 49 commits ahead of v5.0.0), so "reachable" is not a test either. What
 * the fork cannot forge is a tag in the upstream repository itself.
 *
 * So every remote pin must match an entry of action-pins.lock.json, which maps
 * `owner/repo@<tag>` to the exact commit that tag pointed at when it was reviewed:
 *
 *   - offline (the default, used by CI and the pre-push hook): the pin's owner/repo
 *     (case-insensitive, as GitHub resolves it), its version comment (exactly the
 *     tag) and its SHA (exactly) must be one entry; a path after owner/repo must be
 *     listed in that entry's `paths`;
 *   - online (`--verify-lock`, ci-scripts' own CI): each entry's tag is resolved in
 *     the upstream repository, annotated tags dereferenced, and its commit must BE
 *     the entry's SHA. Any API failure fails closed;
 *   - `--resolve owner/repo[/path]@tag` prints a verified entry, so a bump is a
 *     reviewed diff to this file rather than an edit nobody checked.
 *
 * Nothing here decides whether a release is safe to run. It decides that the code
 * a workflow runs is the code upstream released under the tag a human reviewed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

export const LOCK_NAME = "action-pins.lock.json";
export const LOCK_PATH = path.join(import.meta.dirname, "..", LOCK_NAME);
export const LOCKFILE_VERSION = 1;

const SHA40 = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._+-]*)*$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const MAX_TAG_DEPTH = 8;
const TOP_KEYS = new Set(["lockfile_version", "about", "pins"]);
const PIN_KEYS = new Set(["repository", "tag", "sha", "tag_type", "tag_object", "paths", "resolved_at", "method"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// backend#422: `name in obj` and `obj[name]` reach Object.prototype, so a job named
// `constructor` once satisfied a membership test. Lookups here go through a Map
// and Object.hasOwn, and these names are refused outright, as JSON keys anywhere
// and as any owner, repository, tag or path segment. GitHub names are
// case-insensitive, so the refusal is too.
const RESERVED = /^(?:__proto__|constructor|prototype)$/i;
const reservedPart = (s) => s.split("/").some((x) => RESERVED.test(x));

function onlyKeys(obj, allowed, where) {
  if (Object.getPrototypeOf(obj) !== Object.prototype) throw new Error(`${where} is not a plain object`);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new Error(`${where} has the unknown field ${JSON.stringify(k)}`);
  }
}

function validRepository(s) {
  if (typeof s !== "string") return false;
  const parts = s.split("/");
  return parts.length === 2 && OWNER.test(parts[0]) && SEGMENT.test(parts[1]) && parts[1] !== "." && parts[1] !== "..";
}

export function validTag(s) {
  return typeof s === "string" && TAG.test(s) && !s.includes("..") && !s.endsWith(".") && !s.endsWith(".lock");
}

export function validPath(s) {
  return typeof s === "string" && s.split("/").every((p) => SEGMENT.test(p) && p !== "." && p !== "..");
}

/** One entry, checked field by field; returns it or throws. */
export function validatePin(p, where) {
  if (!isObj(p)) throw new Error(`${where} is not an object`);
  onlyKeys(p, PIN_KEYS, where);
  for (const k of ["repository", "tag"]) {
    if (typeof p[k] === "string" && reservedPart(p[k])) throw new Error(`${where}.${k} uses a reserved name (__proto__, constructor or prototype)`);
  }
  if (!validRepository(p.repository)) throw new Error(`${where}.repository is not owner/repo`);
  if (!validTag(p.tag)) throw new Error(`${where}.tag is not a tag name`);
  if (typeof p.sha !== "string" || !SHA40.test(p.sha)) throw new Error(`${where}.sha is not 40 lowercase hex`);
  if (p.tag_type === "annotated") {
    if (typeof p.tag_object !== "string" || !SHA40.test(p.tag_object)) throw new Error(`${where} is an annotated tag without a 40-hex tag_object`);
  } else if (p.tag_type === "lightweight") {
    if (Object.hasOwn(p, "tag_object")) throw new Error(`${where} is a lightweight tag but has a tag_object`);
  } else {
    throw new Error(`${where}.tag_type is neither "lightweight" nor "annotated"`);
  }
  if (Object.hasOwn(p, "paths")) {
    if (!Array.isArray(p.paths) || p.paths.length === 0) throw new Error(`${where}.paths is not a non-empty list`);
    for (const x of p.paths) if (typeof x === "string" && reservedPart(x)) throw new Error(`${where}.paths uses a reserved name (__proto__, constructor or prototype)`);
    for (const x of p.paths) if (!validPath(x)) throw new Error(`${where}.paths has ${JSON.stringify(x)}, which is not a plain relative path`);
    if (new Set(p.paths).size !== p.paths.length) throw new Error(`${where}.paths lists a path twice`);
  }
  if (typeof p.resolved_at !== "string" || !STAMP.test(p.resolved_at) || Number.isNaN(Date.parse(p.resolved_at))) {
    throw new Error(`${where}.resolved_at is not a UTC timestamp like 2026-09-15T12:00:00Z`);
  }
  if (typeof p.method !== "string" || p.method.trim() === "") throw new Error(`${where}.method is empty`);
  return p;
}

/**
 * Parse and validate the lockfile text. Throws on anything short of a clean file:
 * a lockfile this cannot read is not a lockfile that approved anything.
 */
export function parseLock(text) {
  let data;
  try {
    // JSON.parse makes "__proto__" an own property rather than a prototype, but a
    // reserved key has no business in this file, so it is refused wherever it is.
    data = JSON.parse(text, (key, value) => {
      if (RESERVED.test(key)) throw new Error(`the key ${JSON.stringify(key)} is reserved (backend#422)`);
      return value;
    });
  } catch (err) {
    throw new Error(err instanceof SyntaxError ? `is not valid JSON (${err.message})` : `has ${err.message}`);
  }
  // JSON.parse keeps the LAST of two equal keys, while a reviewer reads the first.
  // The same text read as YAML with unique keys refuses the duplicate.
  const dup = parseDocument(text, { uniqueKeys: true, prettyErrors: false }).errors.find((e) => e.code === "DUPLICATE_KEY");
  if (dup) throw new Error(`has a duplicated key (${dup.message.split("\n")[0]}), which JSON.parse would silently resolve to the last one`);
  if (!isObj(data)) throw new Error("is not a JSON object");
  onlyKeys(data, TOP_KEYS, "the top level");
  if (data.lockfile_version !== LOCKFILE_VERSION) throw new Error(`has lockfile_version ${JSON.stringify(data.lockfile_version)}, and this checker reads ${LOCKFILE_VERSION}`);
  if (!Array.isArray(data.pins)) throw new Error("has no pins list");

  const index = new Map(); // lowercased owner/repo -> pins
  data.pins.forEach((raw, i) => {
    const pin = validatePin(raw, `pins[${i}]`);
    const key = pin.repository.toLowerCase();
    const same = index.get(key) ?? [];
    if (same.some((o) => o.repository !== pin.repository)) {
      throw new Error(`pins[${i}] spells ${pin.repository} with a different letter case than another entry; use GitHub's full_name`);
    }
    if (same.some((o) => o.tag === pin.tag)) throw new Error(`pins[${i}] repeats ${pin.repository}@${pin.tag}`);
    same.push(pin);
    index.set(key, same);
  });
  return { pins: data.pins, index };
}

export function loadLock(file = LOCK_PATH) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot be read (${err.code ?? err.message})`);
  }
  return parseLock(text);
}

const RESOLVE_HINT = (spec) =>
  `in a ci-scripts PR, run  node bin/check-action-pins.mjs --resolve ${spec}  and add the entry it prints to ${LOCK_NAME}; then bump @orlidating/ci-scripts in this repository`;

/**
 * Offline decision for one remote pin. `owner`, `repo` and `path` (segments) come
 * from the grammar parse, `sha` is the 40-hex ref, `comment` the trimmed version
 * comment. Returns null when an entry approves it, else { error, fix }.
 */
export function checkPin(lock, { owner, repo, path: segs = [], sha, comment }) {
  const repository = `${owner}/${repo}`;
  if (!(lock.index instanceof Map)) throw new TypeError("lock.index must be a Map");
  const pins = reservedPart(repository) ? [] : (lock.index.get(repository.toLowerCase()) ?? []);
  const tag = comment;
  if (pins.length === 0) {
    return {
      error: `${repository} is not in the reviewed lockfile (${LOCK_NAME} in @orlidating/ci-scripts), so nothing shows this SHA is a release of it rather than a commit from a fork`,
      fix: RESOLVE_HINT(`${repository}@<tag>`),
    };
  }
  const canonical = pins[0].repository;
  const byTag = RESERVED.test(tag) ? undefined : pins.find((p) => p.tag === tag);
  const bySha = pins.filter((p) => p.sha === sha).map((p) => p.tag);
  if (!byTag) {
    if (bySha.length > 0) {
      return {
        error: `the version comment says "${tag}", but ${sha} is the reviewed commit for ${canonical}@${bySha.join(", @")}; the comment is what a reviewer reads, so it must name the tag exactly`,
        fix: `write the comment as  # ${bySha[0]}`,
      };
    }
    return {
      error: `"${tag}" is not a reviewed tag of ${canonical} in ${LOCK_NAME} (reviewed: ${pins.map((p) => p.tag).join(", ")}); the version comment must be exactly the tag`,
      fix: validTag(tag) ? RESOLVE_HINT(`${canonical}@${tag}`) : "write the comment as exactly the tag, e.g.  # v5.1.0",
    };
  }
  if (byTag.sha !== sha) {
    const why =
      bySha.length > 0
        ? `it is the reviewed commit for @${bySha.join(", @")}, so the SHA and the comment disagree`
        : "it is an older or different release, a commit that exists only in a fork (an impostor commit GitHub still resolves under this name), or a typo";
    return {
      error: `${sha} is not the reviewed commit for ${canonical}@${tag}, which is ${byTag.sha}: ${why}`,
      fix: `pin the reviewed commit:  ${canonical}${segs.length ? `/${segs.join("/")}` : ""}@${byTag.sha} # ${tag}`,
    };
  }
  const sub = segs.join("/");
  const listedPaths = Object.hasOwn(byTag, "paths") ? byTag.paths : [];
  if (sub !== "" && (reservedPart(sub) || !listedPaths.includes(sub))) {
    return {
      error: `the path "${sub}" inside ${canonical}@${tag} is not reviewed (the entry lists ${byTag.paths ? byTag.paths.join(", ") : "no paths"}); a repository can hold test fixtures, examples and workflows that were never a released entry point`,
      fix: `use ${canonical}@${tag} itself, or add "${sub}" to that entry's paths in a ci-scripts PR (--verify-lock checks it exists at the SHA)`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Online: resolving and verifying against the upstream repository
// ---------------------------------------------------------------------------
// `api(endpoint)` returns the parsed JSON body of `gh api <endpoint>` or throws.

function call(api, endpoint) {
  let body;
  try {
    body = api(endpoint);
  } catch (err) {
    throw new Error(`gh api ${endpoint} failed, so this could not be verified and fails closed: ${err.message}`);
  }
  if (!isObj(body) && !Array.isArray(body)) throw new Error(`gh api ${endpoint} did not return a JSON object or list`);
  return body;
}

const enc = (s) => s.split("/").map(encodeURIComponent).join("/");

/** The commit `tag` names IN `repository` itself: { commit, tag_type, tag_object?, method }. Throws. */
export function derefTag(api, repository, tag) {
  const meta = call(api, `repos/${repository}`);
  if (meta.full_name !== repository) {
    throw new Error(
      `repos/${repository} answered as ${JSON.stringify(meta.full_name)}: the repository was renamed or transferred, or the lockfile does not use GitHub's spelling; a vacated name can be registered by anyone`,
    );
  }
  const refEp = `repos/${repository}/git/ref/tags/${enc(tag)}`;
  const ref = call(api, refEp);
  if (ref.ref !== `refs/tags/${tag}`) throw new Error(`${refEp} returned ${JSON.stringify(ref.ref)}, not refs/tags/${tag}`);
  const method = [`gh api ${refEp}`];
  let obj = ref.object;
  let tagObject;
  for (let depth = 0; ; depth++) {
    if (!isObj(obj) || typeof obj.sha !== "string" || !SHA40.test(obj.sha)) throw new Error(`tag ${tag} of ${repository} does not point at an object with a 40-hex sha`);
    if (obj.type === "commit") break;
    if (obj.type !== "tag") throw new Error(`tag ${tag} of ${repository} points at a ${JSON.stringify(obj.type)}, not a commit`);
    if (depth >= MAX_TAG_DEPTH) throw new Error(`tag ${tag} of ${repository} nests more than ${MAX_TAG_DEPTH} annotated tag objects`);
    const tagEp = `repos/${repository}/git/tags/${obj.sha}`;
    const t = call(api, tagEp);
    if (t.sha !== obj.sha) throw new Error(`${tagEp} returned the tag object ${JSON.stringify(t.sha)}`);
    if (tagObject === undefined) {
      if (t.tag !== tag) throw new Error(`the annotated tag object for ${tag} of ${repository} is named ${JSON.stringify(t.tag)}`);
      tagObject = obj.sha;
    }
    method.push(`gh api ${tagEp}`);
    obj = t.object;
  }
  return { commit: obj.sha, tag_type: tagObject ? "annotated" : "lightweight", ...(tagObject ? { tag_object: tagObject } : {}), method };
}

function checkPath(api, repository, sha, p) {
  const ep = `repos/${repository}/contents/${enc(p)}?ref=${sha}`;
  const body = call(api, ep);
  if (WORKFLOW_PATH.test(p)) {
    if (!isObj(body) || body.type !== "file") throw new Error(`${p} is not a workflow file in ${repository} at ${sha}`);
    return;
  }
  if (!Array.isArray(body) || !body.some((e) => isObj(e) && e.type === "file" && (e.name === "action.yml" || e.name === "action.yaml"))) {
    throw new Error(`${p} has no action.yml or action.yaml in ${repository} at ${sha}`);
  }
}

/** Every reason `pin` does not match upstream; empty when it does. Never throws. */
export function verifyPin(api, pin) {
  const where = `${pin.repository}@${pin.tag}`;
  let r;
  try {
    r = derefTag(api, pin.repository, pin.tag);
  } catch (err) {
    return [`${where}: ${err.message}`];
  }
  const out = [];
  if (r.commit !== pin.sha) {
    out.push(
      `${where}: the upstream tag's commit is ${r.commit}, not the locked ${pin.sha}; the entry names an older or different release, a commit that exists only in a fork (an impostor commit), or the tag moved after review`,
    );
  }
  if (r.tag_type !== pin.tag_type || r.tag_object !== pin.tag_object) {
    out.push(
      `${where}: upstream the tag is ${r.tag_type}${r.tag_object ? ` (tag object ${r.tag_object})` : ""}, but the entry records ${pin.tag_type}${pin.tag_object ? ` (tag object ${pin.tag_object})` : ""}; the tag was re-created after review`,
    );
  }
  if (out.length === 0) {
    for (const p of Object.hasOwn(pin, "paths") ? pin.paths : []) {
      try {
        checkPath(api, pin.repository, pin.sha, p);
      } catch (err) {
        out.push(`${where}: ${err.message}`);
      }
    }
  }
  return out;
}

/** `owner/repo[/path]@tag` -> { repository, path, tag }, or null. */
export function parseSpec(spec) {
  if (typeof spec !== "string") return null;
  const at = spec.split("@");
  if (at.length !== 2) return null;
  const [name, tag] = at;
  const segs = name.split("/");
  if (segs.length < 2) return null;
  const repository = `${segs[0]}/${segs[1]}`;
  const sub = segs.slice(2).join("/");
  if (reservedPart(name) || RESERVED.test(tag)) return null;
  if (!validRepository(repository) || !validTag(tag) || (sub !== "" && !validPath(sub))) return null;
  return { repository, path: sub, tag };
}

/** A verified lockfile entry for `spec`, resolved now. Throws with every problem. */
export function resolvePin(api, spec, now = new Date()) {
  const s = parseSpec(spec);
  if (!s) throw new Error(`${JSON.stringify(spec)} is not owner/repo[/path]@tag`);
  const r = derefTag(api, s.repository, s.tag);
  const pin = {
    repository: s.repository,
    tag: s.tag,
    sha: r.commit,
    tag_type: r.tag_type,
    ...(r.tag_object ? { tag_object: r.tag_object } : {}),
    ...(s.path ? { paths: [s.path] } : {}),
    resolved_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    method: `${r.method.join(" + ")}; the tag's commit in ${s.repository} itself is the sha`,
  };
  if (s.path) checkPath(api, s.repository, pin.sha, s.path);
  return validatePin(pin, "the resolved entry");
}
