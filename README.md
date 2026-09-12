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

Checks `.github/workflows/*.y(a)ml` and any composite action under
`.github/actions/*/action.y(a)ml`.

| Reference | Result |
|---|---|
| Full SHA + version comment | pass |
| Full SHA, no comment | **fail** — unreviewable |
| Tag or branch (`@v5`, `@main`) | **fail** — mutable |
| Short SHA | **fail** — not guaranteed unique |
| No ref at all | **fail** — silently tracks the default branch |
| `./.github/actions/...` | pass — no third party can move it |
| `docker://img@sha256:...` | pass |
| `docker://img:tag` | **fail** |

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
