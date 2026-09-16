/**
 * Test support for the reviewed lockfile (backend#421). No tests here.
 *
 * The checker reads the lockfile that sits next to its own bin/ directory, and
 * deliberately offers no flag or variable to point it elsewhere: a consuming
 * repository could otherwise approve its own pins. So a test that needs a
 * different lockfile gets a throwaway copy of the package: bin/ copied (so a
 * mutated source is what runs), node_modules linked, and the lockfile written.
 *
 * `fakeGh` puts a `gh` on PATH that answers `gh api <endpoint>` from recorded
 * bodies and answers anything else as real gh does for a 404.
 */
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const REPO = path.resolve(import.meta.dirname, "..");
export const REAL_BIN = path.join(REPO, "bin", "check-action-pins.mjs");
export const RECORDED = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "github-api-recorded.json"), "utf8")).responses;

const made = [];
process.on("exit", () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function pin(repository, tag, sha, extra = {}) {
  return { repository, tag, sha, tag_type: "lightweight", resolved_at: "2026-09-15T00:00:00Z", method: "test fixture", ...extra };
}

/** A reviewed image entry (backend#426). */
export function img(image, digest, extra = {}) {
  return { image, digest, resolved_at: "2026-09-15T00:00:00Z", method: "test fixture", ...extra };
}

/**
 * `pins` may be the pins array, or { pins, images } when a fixture needs reviewed images
 * too — images are what approve docker://, container: and services.<id>.image.
 */
export const lockText = (pins) => {
  const { pins: p = [], images } = Array.isArray(pins) ? { pins } : pins;
  return `${JSON.stringify({ lockfile_version: 1, pins: p, ...(images ? { images } : {}) }, null, 2)}\n`;
};

/** A package copy whose lockfile is `lock`: a pins array, raw text, or null for none. Returns its bin path. */
export function packageWithLock(lock) {
  const dir = scratch("pins-pkg-");
  cpSync(path.join(REPO, "bin"), path.join(dir, "bin"), { recursive: true });
  symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  if (lock !== null) writeFileSync(path.join(dir, "action-pins.lock.json"), typeof lock === "string" ? lock : lockText(lock));
  return path.join(dir, "bin", "check-action-pins.mjs");
}

/**
 * Environment whose PATH has a fake gh serving `routes` ({ endpoint: body }, or
 * { __raw: text } for a non-JSON body) and node, and nothing else. Every call is
 * appended to `log` (one JSON argv per line).
 */
export function fakeGh(routes) {
  const dir = scratch("pins-gh-");
  mkdirSync(path.join(dir, "bin"));
  const routesFile = path.join(dir, "routes.json");
  const log = path.join(dir, "calls.log");
  writeFileSync(routesFile, JSON.stringify(routes));
  const gh = path.join(dir, "bin", "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] !== "api") { process.stderr.write("fake gh: only api\\n"); process.exit(2); }
const positional = [];
for (let i = 1; i < args.length; i++) { if (args[i] === "-H") i++; else positional.push(args[i]); }
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, "utf8"));
const body = Object.prototype.hasOwnProperty.call(routes, positional[0]) ? routes[positional[0]] : undefined;
if (positional.length !== 1 || body === undefined) {
  process.stdout.write(JSON.stringify({ message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" }));
  process.stderr.write("gh: Not Found (HTTP 404)\\n");
  process.exit(1);
}
process.stdout.write(body && typeof body.__raw === "string" ? body.__raw : JSON.stringify(body));
`,
  );
  chmodSync(gh, 0o755);
  return {
    env: { PATH: `${path.join(dir, "bin")}${path.delimiter}${path.dirname(process.execPath)}` },
    calls: () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}
