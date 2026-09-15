# @orlidating/ci-scripts

Two repo-agnostic CI checks, split out so they can be shared without a credential.

They live here rather than in a private config repo for a specific reason: a GitHub
Actions runner checks out one repository, so a check that lives in a *private*
sibling can only be reached by putting a PAT in CI — or by copying the file into
every repo, which means two copies of a security check and nothing to notice when
they drift. A small public package solves both. Nothing here is project-specific;
the project's own invariants stay private.

## What's in here

| Command | What it does |
|---|---|
| `check-action-pins` | Fails if any GitHub Action is referenced by a mutable ref, or by a SHA that is not the reviewed commit of the tag its comment names. |
| `format-staged` | Formats staged files, routing by extension across Biome, Prettier and sql-formatter. |

## Install

Pin it to a commit, the same way it asks you to pin your actions:

```sh
pnpm add -D "github:Orlidating/ci-scripts#<commit-sha>"
```

Public, so CI resolves it with no token, and the lockfile pins the exact commit —
so the copy CI runs is the copy you reviewed.

```jsonc
// package.json
{
  "scripts": {
    "actions:pins": "check-action-pins",
    "format": "format-staged --all",
    "format:check": "format-staged --all --check"
  }
}
```

## `check-action-pins`

**A tag is not a pin.** `actions/checkout@v5` resolves through a ref the upstream
owner can move, so the code CI runs tomorrow need not be the code anyone reviewed
today. In March 2025 tj-actions' tags were retagged onto a commit that dumped
runner memory — secrets included — into the build logs of every repository that
had pinned by tag.

Only a full 40-character commit SHA is immutable. It must carry a trailing version
comment, so the pin stays reviewable by a human and Renovate can still track it:

```yaml
uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
```

### A SHA is not provenance: the reviewed lockfile (backend#421)

GitHub resolves `owner/repo@<sha>` for a commit that exists **anywhere in the
repository's fork network**, under the upstream name. Two real examples:

- `actions/setup-node@a6aa7c983ce5d580d149344767c9e3f34214804c` exists only in the fork
  `Rchie121/setup-node`;
- `actions/upload-artifact@be1eaeb04ae4adec5509a6adeccadb47a703d75b` exists only in the fork
  `oxasploits/upload-artifact`.

Both are well-formed pins that run code upstream never released, with the job's token.
`commits/<sha>` and `compare/<tag>...<sha>` answer for them too (the compare reports
"ahead"), so neither is evidence. The one thing a fork cannot create is a tag in the upstream
repository itself.

So every remote pin must be **one entry of [`action-pins.lock.json`](action-pins.lock.json)**,
which ships with this package:

- **owner/repo** matches case-insensitively, as GitHub resolves names;
- **the version comment** must be exactly the entry's tag (`# v5.1.0`, not `# 5.1.0` or
  `# v5.1.0 latest`), because it is what a reviewer reads;
- **the SHA** must be exactly the entry's SHA;
- **a path after owner/repo** (`o/r/sub@…`, or a reusable workflow `o/r/.github/workflows/x.yml@…`)
  must be listed in that entry's `paths`. A repository holds test fixtures, examples and
  workflows that were never a released entry point, so reviewing a tag doesn't approve all of them.

The check is offline, so the pre-push hook needs no network. There is no flag or variable to
point it at another lockfile: a consuming repository cannot approve its own pins. A lockfile
that is missing, not JSON, has a duplicated key, an unknown field, a malformed value, or a
reserved name (`__proto__`, `constructor`, `prototype`, backend#422) approves nothing.

```json
{
  "repository": "pnpm/action-setup",
  "tag": "v4.3.0",
  "sha": "b906affcce14559ad1aafd4ab0e942779e9f58b1",
  "tag_type": "annotated",
  "tag_object": "c336a2788d9774dccfdeb4823a5058ccc9f07453",
  "resolved_at": "2026-09-15T20:24:39Z",
  "method": "gh api repos/pnpm/action-setup/git/ref/tags/v4.3.0 + gh api repos/pnpm/action-setup/git/tags/c336…; the tag's commit in pnpm/action-setup itself is the sha"
}
```

**Adding or bumping an action** is a ci-scripts PR:

```sh
node bin/check-action-pins.mjs --resolve actions/checkout@v5.1.0      # prints a verified entry
node bin/check-action-pins.mjs --resolve github/codeql-action/init@v3  # with a path
```

`--resolve` reads `repos/<o>/<r>` (the name must not redirect, since a renamed repository's old
name can be re-registered), then `git/ref/tags/<tag>` in that repository, dereferencing annotated
tags through `git/tags/<sha>`. It records the commit, and checks that any path exists at it.
Add the printed entry to the lockfile. Then bump `@orlidating/ci-scripts` in the consuming
repository in the same change that moves its `uses:`.

**`--verify-lock`** repeats that resolution for every entry and requires the tag's commit to
**be** the entry's SHA, with the same tag type and tag object. It runs in this repository's CI
on every push, pull request and weekly. Any API error, a missing `gh`, or a non-JSON answer
fails it; nothing is read as a pass. Tests use recorded responses
(`test/fixtures/github-api-recorded.json`) through a fake `gh`, and
`CHECK_ACTION_PINS_LIVE=1 node --test test/check-action-pins-lock.test.mjs` also runs against
GitHub.

`docker://image@sha256:<digest>` needs no entry: a digest names the content itself.

This proves the code is what upstream released under the tag a human reviewed. It does not
prove that release is safe, and it does not reach actions that an upstream composite action
calls in turn.

Checks `.github/workflows/*.y(a)ml`, every composite action under
`.github/actions/**/action.y(a)ml`, and every local action or reusable workflow a
reference names, wherever it lives in the tree (followed recursively, with a depth
bound and cycle detection).

**It parses, it does not pattern-match.** Every file is read with
[`yaml`](https://eemeli.org/yaml/), pinned exactly, called as GitHub's own workflow
parser (`@actions/workflow-parser`) calls it: `parseDocument(…, { uniqueKeys: false })`.
It walks `jobs.<id>.uses`, `jobs.<id>.steps[*].uses`, `runs.steps[*].uses` and
`runs.image`, with keys matched case-insensitively, aliases resolved, a duplicated key
contributing every value and a `<<` merge key contributing what it merges. So flow
style, quoted, escaped or explicit keys, anchors, tags and next-line values are all
graded. A file that is not valid YAML, a symlink on a path it reads, or a local
reference that is not in the tree is a failure, never a skip.

`--root <dir>` checks a directory without git (it prints `check-action-pins: protocol 3`
first, so a caller can tell it is not an older copy that would ignore `--root`; protocol 3 is
the first that enforces the lockfile, so a caller that requires it cannot be graded by an
impostor-accepting protocol-2 copy).
Unknown arguments are an error.

Each `uses` value is **parsed against GitHub's documented grammar**, not searched
for a SHA (backend#268):

- step: `{owner}/{repo}@{ref}`, `{owner}/{repo}/{path}@{ref}`, `./path`, `$/path`,
  `docker://[host/]image[:tag]@sha256:<digest>`
- job: `{owner}/{repo}/.github/workflows/{file}.y[a]ml@{ref}`, `./.github/workflows/{file}`
- `runs.image`: `docker://…`

A remote `{ref}` passes only when it is exactly 40 lowercase hex characters and the
whole remainder after the **single** `@`. GitHub's parsers split a value with two
`@` differently (`@actions/workflow-parser` takes the text after the first `@` up to
the second; `github/actions-lockfile` takes everything after the first `@`; the
runner rejects it), and every one of those readings is mutable, so more than one `@`
fails. So do an empty owner, repository or ref, whitespace or invisible characters,
`%` (URL encoding), a backslash, a `.` or `..` segment in a remote path, a job-level
`uses` that is not a reusable workflow, and any value no form matches.

| Reference | Result |
|---|---|
| Full SHA whose owner/repo, version comment and SHA are one lockfile entry | pass |
| Full SHA from a fork of the repository (impostor commit), under a reviewed tag's comment | **fail** — not the reviewed commit |
| An older release's SHA under a newer comment, or the right SHA under a wrong comment | **fail** — SHA and comment must be one entry |
| An action, or a tag of it, that is not in the lockfile | **fail** — add it with `--resolve` in ci-scripts |
| `owner/repo/path@sha` or a reusable workflow whose path the entry does not list | **fail** — not a reviewed entry point |
| `o/r/.github/workflows/y.yml@main@<sha>`, `@<sha>@main`, `docker://i@x@sha256:…` | **fail** — more than one `@`; GitHub reads a mutable ref |
| Uppercase hex, `refs/tags/<sha>`, `<sha>^{}` | **fail** — not exactly 40 lowercase hex |
| `%40`, a space, tab or newline, a backslash, `..` in a remote path | **fail** — no documented form has them |
| Full SHA, no comment | **fail** — unreviewable |
| Tag or branch (`@v5`, `@main`) | **fail** — mutable |
| Short SHA | **fail** — not guaranteed unique |
| No ref at all | **fail** — silently tracks the default branch |
| `./path/to/dir` or `$/path` (local action) | pass — no third party can move it — **and followed**: its `action.yml`/`action.yaml` is graded too |
| Local action that is not in the tree, or reached through a symlink | **fail** — GitHub would fail, and nothing was checked |
| `./.github/workflows/x.yml` (local reusable workflow) | followed and graded |
| A workflow or action that is not valid YAML (several documents included) | **fail** — GitHub would not run it |
| `docker://img@sha256:<64 lowercase hex>` (a tag beside the digest is allowed) | pass |
| `docker://img:tag` | **fail** |

### It says when it checked nothing

A repository with no workflows prints `No GitHub Action references found — nothing
was checked.` and exits 0, rather than `OK — 0 references, all pinned`. The second
phrasing reads like a check that ran and passed, which is the failure shape this
tool exists to eliminate. Pass `--require` to turn that into a failure — worth it
in a repo that knows it has workflows, so a mis-glob is loud rather than green.

Resolve a pin with `node bin/check-action-pins.mjs --resolve owner/repo@tag` in this
repository, not with `gh api repos/<o>/<r>/commits/<ref>`: that endpoint also answers for a
fork's commit.

## `format-staged`

One formatter does not cover a mixed repository. Biome handles TypeScript,
JavaScript, JSON and CSS; in a repo whose schema, config and docs are YAML, SQL
and Markdown, that can be a minority of the tracked files.

| Extension | Tool |
|---|---|
| `.ts .tsx .js .mjs .cjs .json .jsonc .css` | Biome |
| `.yaml .yml .md` | Prettier |
| `.sql` | sql-formatter (postgresql) |

Each tool is resolved from the **consuming repo's** `node_modules`, so versions
stay pinned per repo. A tool that isn't installed means those file types are
skipped with a notice rather than a failed commit.

```sh
format-staged            # staged files, rewrite and re-stage (pre-commit)
format-staged --all      # every tracked file
format-staged --all --check   # exit 1 if anything would change (CI)
```

### Two things it deliberately refuses to do

**It never formats lockfiles.** `pnpm-lock.yaml` is YAML by extension and Prettier
will happily reflow it, but a lockfile's bytes are its integrity record — a
reformatted one cannot be diffed against what the resolver actually produced, and
the package manager rewrites it on the next install anyway. `pnpm-lock.yaml`,
`package-lock.json`, `yarn.lock` and `bun.lockb` are excluded by name, as are
`node_modules`, `dist`, `build` and `coverage` by path.

**It never rewrites SQL except for whitespace.** Formatting a migration rewrites a
file that may already have been applied somewhere, so the SQL path compares the
whitespace-stripped input and output and refuses to write if anything else changed.
A formatter bug therefore degrades to a refusal rather than a corrupted migration.
It also restores the trailing newline sql-formatter drops.

`.prettierignore` is honoured, so a repo can exempt a file without reaching for
`--no-verify`.

## Tests

```sh
node --test test/
```

The pin checker's behaviour is pinned by tests, including the cases that matter
most: a short SHA, a SHA without a comment, a missing ref, a docker tag, a
second workflow file, and the two real fork commits above, offline and online.
This repo's own CI runs `check-action-pins --require` against itself and
`--verify-lock` against GitHub.

## License

MIT.
