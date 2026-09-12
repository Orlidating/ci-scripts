#!/usr/bin/env node
/**
 * Format staged files, then re-stage what changed.
 *
 * Routes by extension, because no single formatter covers a mixed repository:
 *
 *   .ts .tsx .js .mjs .cjs .json .jsonc .css  -> Biome
 *   .yaml .yml .md                            -> Prettier
 *   .sql                                      -> sql-formatter (postgresql)
 *
 * Biome does not format YAML, SQL or Markdown. In a repository whose schema,
 * config and docs live in those formats, that can be the majority of the tracked
 * files — and ungated formats are how a convention drifts once several people
 * are each writing one file of it.
 *
 * Usage:
 *   node format-staged.mjs            # staged files (pre-commit)
 *   node format-staged.mjs --all      # every tracked file
 *   node format-staged.mjs --check    # exit 1 if anything would change (CI)
 *
 * Dependencies are resolved from the REPO's node_modules, not this script's
 * directory, so the shared hook works against each repo's pinned versions.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const ALL = args.has("--all");

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const require = createRequire(path.join(repoRoot, "package.json"));

/** Never format vendored or generated trees, even if something staged them. */
const EXCLUDED = /(^|\/)(node_modules|dist|build|coverage|\.git|supabase\/\.branches|supabase\/\.temp)(\/|$)/;

/**
 * Lockfiles are generated, and their bytes are the integrity record.
 * Prettier happily reflows pnpm-lock.yaml — 5.5KB of churn on this repo — and
 * the package manager rewrites it right back on the next install. Worse, a
 * reformatted lockfile is a lockfile nobody can diff against what the resolver
 * actually produced.
 */
const GENERATED = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/;

const BIOME_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonc", ".css"]);
const PRETTIER_EXT = new Set([".yaml", ".yml", ".md"]);
const SQL_EXT = new Set([".sql"]);

/** Files staged for commit (added/copied/modified/renamed), or all tracked files. */
function targetFiles() {
  const cmd = ALL
    ? ["ls-files"]
    : ["diff", "--cached", "--name-only", "--diff-filter=ACMR"];
  return execFileSync("git", cmd, { encoding: "utf8", cwd: repoRoot })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !EXCLUDED.test(f) && !GENERATED.test(f));
}

function tryRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

const changed = [];
const skipped = new Set();
const refused = [];

// --- Biome -------------------------------------------------------------------
// Biome has its own staged-file handling and is fast, so shell out once.
function runBiome(files) {
  if (files.length === 0) return;
  const bin = path.join(repoRoot, "node_modules", ".bin", "biome");
  const mode = CHECK ? ["check"] : ["check", "--write"];
  // Chunk: a large commit would otherwise risk ARG_MAX on the command line.
  const CHUNK = 200;
  for (let i = 0; i < files.length; i += CHUNK) {
    const batch = files.slice(i, i + CHUNK);
    try {
      execFileSync(bin, [...mode, "--no-errors-on-unmatched", ...batch], {
        cwd: repoRoot,
        stdio: CHECK ? "inherit" : "pipe",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      if (CHECK) {
        refused.push("biome: files are not formatted or have lint errors");
        return;
      }
      // --write still exits non-zero for errors it cannot fix. Surface them.
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      refused.push(`biome could not fix everything:\n${out.trim()}`);
      return;
    }
  }
  // Biome rewrote in place; git tells us which actually changed.
  for (const f of files) if (isDirty(f)) changed.push(f);
}

function isDirty(file) {
  const out = execFileSync("git", ["diff", "--name-only", "--", file], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  return out.trim() !== "";
}

// --- Prettier ----------------------------------------------------------------
async function runPrettier(files) {
  if (files.length === 0) return;
  const prettier = tryRequire("prettier");
  if (!prettier) {
    skipped.add("prettier (not installed — YAML and Markdown unformatted)");
    return;
  }
  // Honour .prettierignore the way `prettier --write .` would. Without this a
  // repo has no way to exempt a file from the shared hook, and the only escape
  // is --no-verify.
  const ignorePath = path.join(repoRoot, ".prettierignore");
  const hasIgnoreFile = existsSync(ignorePath);

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    if (hasIgnoreFile) {
      const info = await prettier.getFileInfo(abs, { ignorePath });
      if (info.ignored) continue;
    }
    const src = readFileSync(abs, "utf8");
    let out;
    try {
      const config = await prettier.resolveConfig(abs);
      out = await prettier.format(src, { ...config, filepath: abs });
    } catch (err) {
      // An unparseable YAML/Markdown file is the author's problem to see, but it
      // must not take down formatting for every other staged file.
      refused.push(`prettier could not parse ${rel}: ${err.message.split("\n")[0]}`);
      continue;
    }
    if (out === src) continue;
    if (CHECK) {
      refused.push(`not formatted: ${rel}`);
      continue;
    }
    writeFileSync(abs, out);
    changed.push(rel);
  }
}

// --- SQL ---------------------------------------------------------------------
/**
 * Formatting a migration rewrites a file that may already have been applied
 * somewhere, so the bar for writing one is high.
 *
 * "Whitespace-only" is NOT a safe premise in SQL, and an earlier version of this
 * guard was wrong about that. Two string literals separated by a NEWLINE
 * concatenate — `select 'foo'\n'bar'` is `foobar` — while the same two literals
 * separated by a SPACE are a syntax error. Collapsing that newline is a
 * whitespace-only edit by any character-level comparison, and it broke a real
 * migration that had applied cleanly minutes earlier.
 *
 * So there are three gates, and all three must pass:
 *   1. no string-literal continuation anywhere in the file (we refuse rather
 *      than reason about it);
 *   2. the sequence of literal contents is byte-identical, since whitespace
 *      inside a literal is data, not layout;
 *   3. the non-whitespace character stream is unchanged.
 *
 * A formatter bug, or a construct we have not thought about, therefore degrades
 * to a refusal instead of a corrupted migration.
 */
/**
 * A minimal left-to-right SQL scanner.
 *
 * Regexes cannot do this job, and three successive bugs in this guard came from
 * pretending otherwise. The decisive one: an apostrophe in an English comment —
 * `-- telling those roles apart is the policies' job` — has no partner, so it
 * pairs with the opening quote of the next real literal and desynchronises every
 * literal after it. A correct migration then looks corrupted. This repo's SQL
 * comments are prose full of possessives, so that is the common case, not a
 * corner one.
 *
 * Tracks: line comments, block comments (nested, as PostgreSQL allows), quoted
 * identifiers, dollar-quoted strings, and single-quoted strings including the
 * E'' and U&'' forms. Returns the literals in order, plus whether any two
 * adjacent literals are separated only by whitespace/comments containing a
 * newline — which is string continuation, where collapsing the newline changes
 * `'foo'\n'bar'` (= foobar) into a syntax error.
 */
function scanSql(sql) {
  const literals = [];
  let hasContinuation = false;
  let lastLiteralEnd = -1;
  let i = 0;
  const n = sql.length;

  const gapIsContinuation = (from, to) => {
    if (from < 0) return false;
    const gap = sql.slice(from, to);
    if (!gap.includes("\n")) return false;
    // Whitespace and comments only — anything else means these are separate tokens.
    return /^(?:\s|--[^\n]*|\/\*[\s\S]*?\*\/)*$/.test(gap);
  };

  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);

    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }

    if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth++; i += 2; continue; }
        if (sql.slice(i, i + 2) === "*/") { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }

    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Dollar-quoted: $tag$ ... $tag$
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const close = sql.indexOf(tag, i + tag.length);
      const stop = close === -1 ? n : close + tag.length;
      if (gapIsContinuation(lastLiteralEnd, i)) hasContinuation = true;
      literals.push(sql.slice(i, stop));
      lastLiteralEnd = stop;
      i = stop;
      continue;
    }

    // Single-quoted, including the E'' and U&'' prefixes.
    const prefix = /^(?:[EeNn]|[Uu]&)?'/.exec(sql.slice(i));
    if (prefix) {
      const escapeString = /^[Ee]/.test(prefix[0]);
      const startLit = i;
      i += prefix[0].length;
      while (i < n) {
        if (escapeString && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      if (gapIsContinuation(lastLiteralEnd, startLit)) hasContinuation = true;
      literals.push(sql.slice(startLit, i));
      lastLiteralEnd = i;
      continue;
    }

    i++;
  }

  return { literals, hasContinuation };
}

function runSql(files) {
  if (files.length === 0) return;
  const mod = tryRequire("sql-formatter");
  if (!mod) {
    skipped.add("sql-formatter (not installed — SQL unformatted)");
    return;
  }
  const { format } = mod;
  const opts = { language: "postgresql", keywordCase: "lower", tabWidth: 2 };

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    const src = readFileSync(abs, "utf8");
    let out;
    try {
      out = format(src, opts);
    } catch (err) {
      refused.push(`sql-formatter failed on ${rel}: ${err.message}`);
      continue;
    }
    // sql-formatter drops the trailing newline; without it every diff carries a
    // "\ No newline at end of file" marker.
    if (!out.endsWith("\n")) out += "\n";
    if (out === src) continue;

    // Gate 1: never touch a file using string-literal continuation.
    const scanned = scanSql(src);
    if (scanned.hasContinuation) {
      refused.push(
        `refusing to format ${rel}: it contains a string literal continued across ` +
          `a newline. Joining those lines changes the parse (adjacent literals ` +
          `concatenate across a newline, but are a syntax error on one line), and ` +
          `no character-level check can tell that apart from reflowing. ` +
          `Format this file by hand, or put the string on one line.`,
      );
      continue;
    }

    // Gate 2: literal contents are data — they must be untouched.
    const a = scanned.literals;
    const b = scanSql(out).literals;
    if (a.length !== b.length || a.some((lit, i) => lit !== b[i])) {
      refused.push(
        `refusing to rewrite ${rel}: the formatter altered a string literal. ` +
          `Whitespace inside a literal is data. Report this — it is a formatter bug.`,
      );
      continue;
    }

    // Gate 3: nothing but layout changed elsewhere.
    const strip = (s) => s.replace(/\s+/g, "");
    if (strip(out) !== strip(src)) {
      refused.push(
        `refusing to rewrite ${rel}: the formatter changed more than whitespace. ` +
          `Format it by hand and report this — it is a formatter bug, not a style issue.`,
      );
      continue;
    }
    if (CHECK) {
      refused.push(`not formatted: ${rel}`);
      continue;
    }
    writeFileSync(abs, out);
    changed.push(rel);
  }
}

// --- main --------------------------------------------------------------------
const files = targetFiles();
const byTool = { biome: [], prettier: [], sql: [] };
for (const f of files) {
  const ext = path.extname(f);
  if (BIOME_EXT.has(ext)) byTool.biome.push(f);
  else if (PRETTIER_EXT.has(ext)) byTool.prettier.push(f);
  else if (SQL_EXT.has(ext)) byTool.sql.push(f);
}

if (files.length === 0) process.exit(0);

runBiome(byTool.biome);
await runPrettier(byTool.prettier);
runSql(byTool.sql);

if (!CHECK && changed.length > 0) {
  execFileSync("git", ["add", "--", ...changed], { cwd: repoRoot });
  console.error(`formatted and re-staged ${changed.length} file(s):`);
  for (const f of changed) console.error(`  ${f}`);
}

for (const s of skipped) console.error(`skipped: ${s}`);

if (refused.length > 0) {
  console.error("");
  for (const r of refused) console.error(`✗ ${r}`);
  process.exit(1);
}

process.exit(0);
