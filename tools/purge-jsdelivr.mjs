#!/usr/bin/env node
/*
 * Purge jsDelivr caches for all locally cloned Fontra plugins.
 *
 * Fontra turns an "owner/repo" plugin address into:
 *   https://cdn.jsdelivr.net/gh/owner/repo@latest
 *
 * jsDelivr caches those files for hours or days. This script finds every
 * plugin repository in a folder, reads its GitHub origin, and purges the files
 * that changed since the last successful purge -- for @latest and for the
 * default branch.
 *
 * Typical workflow:
 *   1. Commit and push your plugin changes.
 *   2. Run tools\purge-jsdelivr.cmd
 *   3. Hard-reload Fontra (Ctrl+Shift+R) so the browser also drops its copy.
 *
 * The first run for a repository purges all tracked files, which also fixes
 * caches left over from before this script existed.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_STATE = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"),
  "FontraPluginPurge",
  "state.json"
);
const PURGE_BASE = "https://purge.jsdelivr.net/gh";
const DEFAULT_DELAY_MS = 120;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 2;

function usage() {
  return [
    "Purge jsDelivr caches for all local Fontra plugins",
    "",
    "Usage:",
    "  node tools/purge-jsdelivr.mjs [owner/repo ...] [options]",
    "",
    "Run this after committing and pushing. It scans the parent folder of this",
    "repository for plugin.json files, reads each plugin's GitHub origin, and",
    "purges changed files for @latest and the default branch.",
    "",
    "Options:",
    "  --root <dir>      Folder containing plugin repositories (default: parent of this repo)",
    "  --all             Purge every tracked file, not only files changed since the last run",
    "  --since <commit>  Purge files changed since this commit",
    "  --force           Purge plugin.json even when no files changed",
    "  --refs <list>     Comma-separated jsDelivr refs (default: latest,<default branch>)",
    "  --state <file>    State file (default: %LOCALAPPDATA%\\FontraPluginPurge\\state.json)",
    "  --no-state        Do not read or write state; purge files from the last commit",
    "  --delay <ms>      Delay between purge requests (default: 120)",
    "  --timeout <ms>    Per-request timeout (default: 20000)",
    "  --retries <n>     Retries for throttled or failed requests (default: 2)",
    "  --dry-run         Print what would be purged without sending requests",
    "  --list            List discovered plugin repositories and exit",
    "  --verbose         Print every purge URL",
    "  --help            Show this message",
    "",
    "Positional owner/repo arguments limit the run to matching repositories.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    root: null,
    state: DEFAULT_STATE,
    all: false,
    since: null,
    force: false,
    refs: null,
    noState: false,
    delay: DEFAULT_DELAY_MS,
    timeout: DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
    dryRun: false,
    list: false,
    verbose: false,
    filters: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root") {
      options.root = argv[++i];
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--since") {
      options.since = argv[++i];
    } else if (arg.startsWith("--since=")) {
      options.since = arg.slice("--since=".length);
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--refs") {
      options.refs = argv[++i];
    } else if (arg.startsWith("--refs=")) {
      options.refs = arg.slice("--refs=".length);
    } else if (arg === "--state") {
      options.state = argv[++i];
    } else if (arg.startsWith("--state=")) {
      options.state = arg.slice("--state=".length);
    } else if (arg === "--no-state") {
      options.noState = true;
    } else if (arg === "--delay") {
      options.delay = Number(argv[++i]);
    } else if (arg.startsWith("--delay=")) {
      options.delay = Number(arg.slice("--delay=".length));
    } else if (arg === "--timeout") {
      options.timeout = Number(argv[++i]);
    } else if (arg.startsWith("--timeout=")) {
      options.timeout = Number(arg.slice("--timeout=".length));
    } else if (arg === "--retries") {
      options.retries = Number(argv[++i]);
    } else if (arg.startsWith("--retries=")) {
      options.retries = Number(arg.slice("--retries=".length));
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.filters.push(arg);
    }
  }

  if (!Number.isFinite(options.delay) || options.delay < 0) {
    throw new Error("--delay must be a non-negative number.");
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 1000) {
    throw new Error("--timeout must be at least 1000 ms.");
  }
  if (!Number.isInteger(options.retries) || options.retries < 0) {
    throw new Error("--retries must be a non-negative integer.");
  }

  options.root = path.resolve(options.root || DEFAULT_ROOT);
  options.state = path.resolve(options.state);

  if (options.refs) {
    options.refs = options.refs
      .split(",")
      .map((ref) => ref.trim())
      .filter(Boolean);
    if (!options.refs.length) {
      throw new Error("--refs needs at least one ref.");
    }
  }

  return options;
}

function discoverPluginRepos(root) {
  if (!existsSync(root)) {
    throw new Error(`Root folder does not exist: ${root}`);
  }

  const dirs = [];
  if (existsSync(path.join(root, "plugin.json"))) {
    dirs.push(root);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    const dir = path.join(root, entry.name);
    if (existsSync(path.join(dir, "plugin.json"))) {
      dirs.push(dir);
    }
  }
  return dirs;
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

function gitSucceeds(dir, args) {
  try {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parseGitHubRemote(remote) {
  const cleaned = remote.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i,
    /^git@github\.com:([^/]+)\/([^/]+)$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i,
    /^git:\/\/github\.com\/([^/]+)\/([^/]+)$/i,
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2],
        fullName: `${match[1]}/${match[2]}`,
      };
    }
  }
  return null;
}

function getDefaultBranch(dir, fallback) {
  const remoteHead = tryGit(dir, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (remoteHead) {
    const name = remoteHead.replace(/^origin\//, "");
    if (name) {
      return name;
    }
  }
  return fallback;
}

function collectRepoInfo(dir) {
  const remote = tryGit(dir, ["remote", "get-url", "origin"]);
  if (!remote) {
    return { dir, error: "no origin remote" };
  }
  const github = parseGitHubRemote(remote);
  if (!github) {
    return { dir, error: `origin is not a GitHub repository: ${remote}` };
  }

  const branch = tryGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = tryGit(dir, ["rev-parse", "HEAD"]);
  if (!head) {
    return { dir, ...github, error: "repository has no commits" };
  }

  const upstream = tryGit(dir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  const upstreamCommit = upstream ? tryGit(dir, ["rev-parse", "@{u}"]) : null;
  const unpushed = upstream
    ? Number(tryGit(dir, ["rev-list", "--count", `@{u}..HEAD`]) || 0)
    : null;
  const dirty = !!tryGit(dir, ["status", "--porcelain", "--untracked-files=no"]);
  const defaultBranch = getDefaultBranch(dir, branch);

  return {
    dir,
    ...github,
    branch,
    head,
    upstream,
    upstreamCommit,
    unpushed,
    dirty,
    defaultBranch,
  };
}

function listFilesAtCommit(dir, commit) {
  const output = tryGit(dir, ["ls-tree", "-r", "--name-only", commit]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function listChangedFiles(dir, from, to) {
  const output = tryGit(dir, [
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    `${from}..${to}`,
  ]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function isAncestor(dir, ancestor, descendant) {
  return gitSucceeds(dir, ["merge-base", "--is-ancestor", ancestor, descendant]);
}

function fileExistsAtCommit(dir, commit, file) {
  return gitSucceeds(dir, ["cat-file", "-e", `${commit}:${file}`]);
}

function encodePath(file) {
  return file
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function purgeBase(fullName, ref) {
  const [owner, repo] = fullName.split("/");
  return `${PURGE_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}@${encodeURIComponent(ref)}`;
}

function buildPurgeUrls(fullName, refs, files) {
  const urls = [];
  for (const ref of refs) {
    const base = purgeBase(fullName, ref);
    // The root refresh helps the @latest alias resolve to the new commit.
    urls.push(`${base}/`);
    for (const file of files) {
      urls.push(`${base}/${encodePath(file)}`);
    }
  }
  return urls;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function purgeUrl(url, options) {
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "fontra-plugin-purge/1.0" },
        signal: AbortSignal.timeout(options.timeout),
      });
      const text = await response.text();

      if (response.status === 429) {
        if (attempt < options.retries) {
          await delay(1000 * 2 ** attempt);
          continue;
        }
        return { ok: false, status: 429, message: "rate limited" };
      }

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: text.slice(0, 300).replace(/\s+/g, " "),
        };
      }

      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        // jsDelivr normally returns JSON; a 2xx without JSON is still success.
      }

      if (data?.status === "failed") {
        return { ok: false, status: response.status, message: "purge failed" };
      }

      const throttled =
        data?.paths &&
        Object.values(data.paths).some((entry) => entry && entry.throttled);
      if (throttled) {
        if (attempt < options.retries) {
          await delay(1000 * 2 ** attempt);
          continue;
        }
        return {
          ok: false,
          status: response.status,
          message: "throttled by jsDelivr",
        };
      }

      return { ok: true, status: response.status };
    } catch (error) {
      if (attempt < options.retries) {
        await delay(1000 * 2 ** attempt);
        continue;
      }
      return { ok: false, status: null, message: error.message };
    }
  }
  return { ok: false, status: null, message: "unknown error" };
}

function loadState(file) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (state && typeof state.repos === "object" && state.repos) {
      return state;
    }
  } catch {
    // Missing or invalid state is treated as empty.
  }
  return { version: 1, repos: {} };
}

function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function shortHash(hash) {
  return hash ? hash.slice(0, 7) : "?";
}

function printRepoHeader(info) {
  console.log("");
  console.log(info.fullName);
  console.log(`  folder:  ${info.dir}`);
  console.log(
    `  branch:  ${info.branch || "?"}  head: ${shortHash(info.head)}  default: ${
      info.defaultBranch || "?"
    }`
  );
}

function printWarnings(info) {
  if (info.dirty) {
    console.log(
      "  warning: there are uncommitted changes; jsDelivr only sees pushed commits."
    );
  }
  if (info.upstream === null) {
    console.log(
      "  warning: no upstream branch is configured; push the repository first."
    );
  } else if (info.unpushed > 0) {
    console.log(
      `  warning: ${info.unpushed} unpushed commit${
        info.unpushed === 1 ? "" : "s"
      }; push before relying on the purge.`
    );
  }
  if (info.branch && info.defaultBranch && info.branch !== info.defaultBranch) {
    console.log(
      `  warning: you are on "${info.branch}", but @latest serves "${info.defaultBranch}".`
    );
  }
}

function resolveRefs(options, info) {
  if (options.refs) {
    return options.refs;
  }
  const refs = ["latest"];
  const branch = info.defaultBranch || info.branch;
  if (branch && branch !== "HEAD" && branch !== "latest") {
    refs.push(branch);
  }
  return refs;
}

async function processRepo(dir, options, state) {
  const info = collectRepoInfo(dir);
  if (info.error) {
    console.log("");
    console.log(`${dir}`);
    console.log(`  skipped: ${info.error}`);
    return { ok: true, skipped: true };
  }

  printRepoHeader(info);

  if (options.list) {
    printWarnings(info);
    const entry = options.noState ? null : state.repos[info.fullName];
    console.log(
      entry
        ? `  state:   ${shortHash(entry.commit)} purged ${new Date(
            entry.purgedAt
          ).toLocaleString()}`
        : "  state:   no previous purge recorded"
    );
    return { ok: true, listed: true };
  }

  printWarnings(info);

  const target = info.upstreamCommit || info.head;
  const stateEntry = options.noState ? null : state.repos[info.fullName];
  const firstRun = !options.noState && !stateEntry;

  let from = options.since || stateEntry?.commit || null;
  if (options.all || options.noState) {
    from = options.all ? null : from;
  }
  if (firstRun && !options.since) {
    from = null;
  }
  if (options.noState && !options.all && !options.since) {
    // Without history, purge the files from the most recent commit.
    from = `${target}^`;
    if (!gitSucceeds(dir, ["rev-parse", "--verify", `${target}^`])) {
      from = null;
    }
  }

  if (from && !gitSucceeds(dir, ["rev-parse", "--verify", `${from}^{commit}`])) {
    console.log(`  warning: commit ${from} not found; purging all tracked files.`);
    from = null;
  } else if (from && !isAncestor(dir, from, target)) {
    console.log(
      `  warning: ${shortHash(
        from
      )} is not an ancestor of ${shortHash(
        target
      )}; purging all tracked files to be safe.`
    );
    from = null;
  }

  let files = from
    ? listChangedFiles(dir, from, target)
    : listFilesAtCommit(dir, target);

  if (from && files.length === 0) {
    if (options.force) {
      files = ["plugin.json"];
    } else {
      console.log(
        `  up to date: no files changed since ${shortHash(from)} (${new Date(
          stateEntry?.purgedAt || Date.now()
        ).toLocaleString()})`
      );
      return { ok: true };
    }
  }

  if (fileExistsAtCommit(dir, target, "plugin.json")) {
    files = [...new Set([...files, "plugin.json"])];
  }
  files = [...new Set(files)].filter((file) => file && !file.endsWith("/"));

  const refs = resolveRefs(options, info);
  const urls = buildPurgeUrls(info.fullName, refs, files);

  console.log(
    `  files:   ${files.length} (${
      from ? `changed since ${shortHash(from)}` : "all tracked files"
    })`
  );
  console.log(
    `  refs:    ${refs.join(", ")}  requests: ${urls.length}${
      options.dryRun ? " (dry run)" : ""
    }`
  );

  if (options.dryRun) {
    const shown = options.verbose ? urls : urls.slice(0, 8);
    for (const url of shown) {
      console.log(`    ${url}`);
    }
    if (!options.verbose && urls.length > shown.length) {
      console.log(`    ... and ${urls.length - shown.length} more (use --verbose)`);
    }
    return { ok: true, dryRun: true };
  }

  let succeeded = 0;
  const skipped = [];
  const failed = [];

  for (const url of urls) {
    const result = await purgeUrl(url, options);
    if (result.ok) {
      succeeded++;
    } else if (result.status === 404) {
      skipped.push({ url, message: result.message });
    } else {
      failed.push({ url, message: result.message, status: result.status });
    }
    if (options.verbose) {
      const label = result.ok ? "ok" : result.status === 404 ? "skip" : "FAIL";
      console.log(`    ${label} ${url}`);
    }
    if (options.delay > 0 && url !== urls[urls.length - 1]) {
      await delay(options.delay);
    }
  }

  console.log(
    `  result:  ${succeeded} purged, ${skipped.length} skipped, ${failed.length} failed`
  );
  for (const entry of skipped.slice(0, 5)) {
    console.log(`    skipped 404: ${entry.url}`);
  }
  for (const entry of failed.slice(0, 10)) {
    console.log(
      `    failed ${entry.status || ""}: ${entry.url} — ${entry.message || ""}`
    );
  }
  if (skipped.length > 5) {
    console.log(`    ... and ${skipped.length - 5} more 404s`);
  }
  if (failed.length > 10) {
    console.log(`    ... and ${failed.length - 10} more failures`);
  }

  if (failed.length === 0) {
    if (!options.noState) {
      state.repos[info.fullName] = {
        commit: target,
        branch: info.defaultBranch || info.branch,
        purgedAt: new Date().toISOString(),
      };
    }
    return { ok: true, succeeded, skipped: skipped.length };
  }
  return { ok: false, failed: failed.length };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const dirs = discoverPluginRepos(options.root);
  if (!dirs.length) {
    console.error(
      `No plugin.json found in ${options.root} or its immediate subfolders.`
    );
    process.exitCode = 1;
    return;
  }

  const filters = new Set(options.filters);
  const state = options.noState ? { version: 1, repos: {} } : loadState(options.state);
  const matchedFilters = new Set();

  console.log(`Root:  ${options.root}`);
  console.log(`State: ${options.noState ? "(disabled)" : options.state}`);
  console.log(
    `Found ${dirs.length} plugin repositor${dirs.length === 1 ? "y" : "ies"}.`
  );

  let allOk = true;
  for (const dir of dirs) {
    // Resolve the origin before filtering so owner/repo filters work.
    const remote = tryGit(dir, ["remote", "get-url", "origin"]);
    const github = remote ? parseGitHubRemote(remote) : null;
    const fullName =
      github?.fullName || path.basename(dir);

    if (filters.size && !filters.has(fullName)) {
      continue;
    }
    if (filters.size) {
      matchedFilters.add(fullName);
    }

    const result = await processRepo(dir, options, state);
    if (!result.ok) {
      allOk = false;
    }
  }

  for (const filter of filters) {
    if (!matchedFilters.has(filter)) {
      console.log("");
      console.log(`warning: no discovered plugin matched "${filter}".`);
    }
  }

  if (!options.list && !options.dryRun && !options.noState) {
    saveState(options.state, state);
  }

  if (!options.list) {
    console.log("");
    if (options.dryRun) {
      console.log("Dry run: no requests were sent and state was not changed.");
    } else if (allOk) {
      console.log("Done. Hard-reload Fontra (Ctrl+Shift+R) to drop the browser cache.");
    } else {
      console.log(
        "Some purges failed. Check the messages above; state was not advanced for those repos."
      );
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
