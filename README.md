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
| `check-action-pins` | Fails if any GitHub Action is referenced by a mutable ref. |
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

`--root <dir>` checks a directory without git (it prints `check-action-pins: protocol 2`
first, so a caller can tell it is not an older copy that would ignore `--root`).
Unknown arguments are an error.

| Reference | Result |
|---|---|
| Full SHA + version comment | pass |
| Full SHA, no comment | **fail** — unreviewable |
| Tag or branch (`@v5`, `@main`) | **fail** — mutable |
| Short SHA | **fail** — not guaranteed unique |
| No ref at all | **fail** — silently tracks the default branch |
| `./path/to/dir` or `$/path` (local action) | pass — no third party can move it — **and followed**: its `action.yml`/`action.yaml` is graded too |
| Local action that is not in the tree, or reached through a symlink | **fail** — GitHub would fail, and nothing was checked |
| `./.github/workflows/x.yml` (local reusable workflow) | followed and graded |
| A workflow or action that is not valid YAML (several documents included) | **fail** — GitHub would not run it |
| `docker://img@sha256:...` | pass |
| `docker://img:tag` | **fail** |

### It says when it checked nothing

A repository with no workflows prints `No GitHub Action references found — nothing
was checked.` and exits 0, rather than `OK — 0 references, all pinned`. The second
phrasing reads like a check that ran and passed, which is the failure shape this
tool exists to eliminate. Pass `--require` to turn that into a failure — worth it
in a repo that knows it has workflows, so a mis-glob is loud rather than green.

Resolve a SHA with:

```sh
gh api repos/actions/checkout/commits/v5 --jq .sha
```

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
most: a short SHA, a SHA without a comment, a missing ref, a docker tag, and a
second workflow file. This repo's own CI runs `check-action-pins` against itself.

## License

MIT.
