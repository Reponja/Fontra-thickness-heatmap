#!/usr/bin/env node
/*
 * Refresh the jsDelivr copy of every locally cloned Fontra plugin.
 *
 * Fontra turns an "owner/repo" plugin address into:
 *   https://cdn.jsdelivr.net/gh/owner/repo@latest
 *
 * jsDelivr only allows cache purging for semver releases. When a repository
 * has no semver tag, "@latest" follows a branch instead, and branch caches
 * cannot be purged -- they can stay stale for up to 12 hours.
 *
 * This script therefore gives each plugin a semver tag when needed, pushes the
 * tag, and purges the tagged release plus @latest. Fontra keeps loading the
 * plugin from GitHub as owner/repo.
 *
 * Typical workflow:
 *   1. Commit and push your plugin changes.
 *   2. Run tools\purge-jsdelivr.cmd
 *   3. Reload Fontra. If it still looks old, use DevTools "Empty cache and hard
 *      reload".
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
const CDN_BASE = "https://cdn.jsdelivr.net/gh";
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/i;
const DEFAULT_DELAY_MS = 120;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 2;

function usage() {
  return [
    "Refresh jsDelivr for all local Fontra plugins",
    "",
    "Usage:",
    "  node tools/purge-jsdelivr.mjs [owner/repo ...] [options]",
    "",
    "Run this after committing and pushing. It scans the parent folder of this",
    "repository for plugin.json files and reads each plugin's GitHub origin.",
    "",
    "jsDelivr can only purge semver releases, not branches. If the pushed commit",
    "has no semver tag, this script creates the next patch tag (for example",
    "v1.0.1), pushes it, and purges @latest plus that tag.",
    "",
    "Options:",
    "  --root <dir>      Folder containing plugin repositories (default: parent of this repo)",
    "  --all             Purge every tracked file, not only files changed since the last run",
    "  --since <commit>  Purge files changed since this commit",
    "  --force           Purge plugin.json even when no files changed",
    "  --tag <version>   Use this semver tag instead of the next patch version",
    "  --no-tag          Do not create or push tags (branch @latest cannot be purged)",
    "  --refs <list>     Comma-separated jsDelivr refs (default: latest,<release tag>)",
    "  --state <file>    State file (default: %LOCALAPPDATA%\\FontraPluginPurge\\state.json)",
    "  --no-state        Do not read or write state; purge files from the last commit",
    "  --delay <ms>      Delay between purge requests (default: 120)",
    "  --timeout <ms>    Per-request timeout (default: 20000)",
    "  --retries <n>     Retries for throttled or failed requests (default: 2)",
    "  --dry-run         Print what would be purged without tagging or sending requests",
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
    tag: null,
    noTag: false,
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
    } else if (arg === "--tag") {
      options.tag = argv[++i];
    } else if (arg.startsWith("--tag=")) {
      options.tag = arg.slice("--tag=".length);
    } else if (arg === "--no-tag") {
      options.noTag = true;
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
  if (options.tag && !normalizeTag(options.tag)) {
    throw new Error(`--tag needs a version such as 1.0.1 or v1.0.1, got "${options.tag}".`);
  }
  if (options.tag && options.noTag) {
    throw new Error("--tag and --no-tag cannot be used together.");
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

function parseSemver(tag) {
  const match = String(tag).trim().match(SEMVER_RE);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function normalizeTag(tag) {
  const value = String(tag || "").trim();
  const parsed = parseSemver(value);
  if (!parsed) {
    return null;
  }
  return `v${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function normalizeVersion(version) {
  return String(version || "").trim().replace(/^v/i, "");
}

function compareSemverDesc(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  return (
    right.major - left.major ||
    right.minor - left.minor ||
    right.patch - left.patch
  );
}

function listSemverTags(dir) {
  const output = tryGit(dir, ["tag", "--list"]);
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => parseSemver(tag))
    .sort(compareSemverDesc);
}

function commitForTag(dir, tag) {
  return tryGit(dir, ["rev-list", "-n", "1", tag]);
}

function nextTag(tags) {
  if (!tags.length) {
    return "v1.0.0";
  }
  const latest = parseSemver(tags[0]);
  return `v${latest.major}.${latest.minor}.${latest.patch + 1}`;
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

function encodeName(value) {
  return encodeURIComponent(value);
}

function purgeBase(fullName, ref) {
  const [owner, repo] = fullName.split("/");
  return `${PURGE_BASE}/${encodeName(owner)}/${encodeName(repo)}@${encodeName(ref)}`;
}

function buildPurgeUrls(fullName, refs, files) {
  const urls = [];
  for (const ref of refs) {
    const base = purgeBase(fullName, ref);
    // The root refresh helps the alias resolve to the release tag.
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
        headers: { "User-Agent": "fontra-plugin-purge/2.0" },
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

async function fetchLatestVersion(fullName, options) {
  const [owner, repo] = fullName.split("/");
  const url = `${CDN_BASE}/${encodeName(owner)}/${encodeName(
    repo
  )}@latest/plugin.json?purgecheck=${Date.now()}`;
  try {
    const response = await fetch(url, {
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": "fontra-plugin-purge/2.0",
      },
      signal: AbortSignal.timeout(options.timeout),
    });
    await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      version: response.headers.get("x-jsd-version") || "",
      type: response.headers.get("x-jsd-version-type") || "",
    };
  } catch (error) {
    return { ok: false, status: null, error: error.message };
  }
}

async function verifyLatest(fullName, tag, options) {
  const attempts = 4;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await fetchLatestVersion(fullName, options);
    if (
      last.ok &&
      last.type !== "branch" &&
      normalizeVersion(last.version) === normalizeVersion(tag)
    ) {
      return { ok: true, ...last };
    }
    if (attempt < attempts - 1) {
      await delay(5000);
    }
  }
  return { ok: false, ...(last || {}) };
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
  return { version: 2, repos: {} };
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
      }; those changes are not part of this release.`
    );
  }
  if (info.branch && info.defaultBranch && info.branch !== info.defaultBranch) {
    console.log(
      `  warning: you are on "${info.branch}", but @latest follows the newest semver tag in the repository.`
    );
  }
}

function ensureReleaseTag(info, options, target) {
  const tags = listSemverTags(info.dir);
  const atTarget = tags.find((tag) => commitForTag(info.dir, tag) === target);

  if (atTarget) {
    return { tag: atTarget, tags, created: false, pushed: false };
  }
  if (options.noTag) {
    return { tag: null, tags, created: false, pushed: false };
  }

  const tag = options.tag ? normalizeTag(options.tag) : nextTag(tags);
  if (options.dryRun) {
    return { tag, tags, created: false, pushed: false, wouldCreate: true };
  }

  if (tags.includes(tag)) {
    return {
      error: `tag ${tag} already exists at another commit; pick another version with --tag`,
      tags,
    };
  }

  try {
    git(info.dir, ["tag", tag, target]);
  } catch (error) {
    return { error: `could not create tag ${tag}: ${error.message}`, tags };
  }

  try {
    execFileSync("git", ["-C", info.dir, "push", "origin", tag], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
  } catch (error) {
    tryGit(info.dir, ["tag", "-d", tag]);
    const detail =
      error.stderr?.toString().trim() ||
      error.stdout?.toString().trim() ||
      error.message;
    return { error: `could not push tag ${tag}: ${detail}`, tags };
  }

  return { tag, tags: [tag, ...tags], created: true, pushed: true };
}

function resolveRefs(options, tag) {
  if (options.refs) {
    return options.refs;
  }
  const refs = ["latest"];
  if (tag) {
    refs.push(tag);
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
    const tags = listSemverTags(info.dir);
    const target = info.upstreamCommit || info.head;
    const tagAtTarget = tags.find((tag) => commitForTag(info.dir, tag) === target);
    console.log(
      `  release: ${
        tagAtTarget || (tags.length ? `newest is ${tags[0]} (not at this commit)` : "none")
      }`
    );
    const entry = options.noState ? null : state.repos[info.fullName];
    console.log(
      entry
        ? `  state:   ${shortHash(entry.commit)}${
            entry.tag ? ` (${entry.tag})` : ""
          } purged ${new Date(entry.purgedAt).toLocaleString()}`
        : "  state:   no previous purge recorded"
    );
    return { ok: true, listed: true };
  }

  printWarnings(info);

  if (!info.upstream) {
    console.log(
      "  skipped: no upstream branch; push the branch first so a release tag points at pushed code."
    );
    return { ok: false, error: "no upstream branch" };
  }

  const target = info.upstreamCommit || info.head;
  const release = ensureReleaseTag(info, options, target);
  if (release.error) {
    console.log(`  error:   ${release.error}`);
    return { ok: false, error: release.error };
  }

  if (release.tag) {
    const detail = release.wouldCreate
      ? "would create and push"
      : release.created
        ? "created and pushed"
        : "already at this commit";
    console.log(`  release: ${release.tag} (${detail})`);
  } else {
    console.log("  release: none");
    console.log(
      "  warning: jsDelivr @latest is following a branch, and branch caches cannot be purged."
    );
    console.log(
      "           Re-run without --no-tag to create and push a semver release tag."
    );
  }

  const stateEntry = options.noState ? null : state.repos[info.fullName];
  const firstRun = !options.noState && !stateEntry;
  const tagChanged = !!release.tag && stateEntry?.tag !== release.tag;
  const forceAllFiles = release.created || tagChanged;

  let from = options.since || stateEntry?.commit || null;
  if (options.all || options.noState) {
    from = options.all ? null : from;
  }
  if (options.noState && !options.all && !options.since) {
    // Without history, purge the files from the most recent commit.
    from = `${target}^`;
    if (!gitSucceeds(dir, ["rev-parse", "--verify", `${target}^`])) {
      from = null;
    }
  }
  if (forceAllFiles) {
    // A new release means @latest is switching targets. Every file cached under
    // the old @latest alias must be purged, not only files changed since state.
    console.log("  note:    new release tag; purging all tracked files.");
    from = null;
  }
  if (firstRun && !options.since) {
    from = null;
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
      if (release.created) {
        console.log(
          "  note: a new release tag was pushed, so @latest still needs a purge."
        );
      } else {
        return { ok: true };
      }
    }
  }

  if (fileExistsAtCommit(dir, target, "plugin.json")) {
    files = [...new Set([...files, "plugin.json"])];
  }
  files = [...new Set(files)].filter((file) => file && !file.endsWith("/"));

  const refs = resolveRefs(options, release.tag);
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

  if (failed.length > 0) {
    return { ok: false, failed: failed.length };
  }

  if (!release.tag) {
    console.log(
      "  note: no semver tag was used; a branch @latest may stay stale for hours."
    );
    if (!options.noState) {
      state.repos[info.fullName] = {
        commit: target,
        branch: info.defaultBranch || info.branch,
        tag: null,
        purgedAt: new Date().toISOString(),
      };
    }
    return { ok: true, succeeded, skipped: skipped.length, untagged: true };
  }

  const verified = await verifyLatest(info.fullName, release.tag, options);
  if (!verified.ok) {
    if (verified.type === "branch") {
      console.log(
        "  verify:  jsDelivr still resolves @latest to a branch, not the new release."
      );
      console.log(
        "           New tags can take a few minutes to appear. Re-run this script shortly."
      );
    } else if (verified.status) {
      console.log(
        `  verify:  @latest still resolves to ${verified.version || "an older release"}; expected ${release.tag}.`
      );
      console.log(
        "           jsDelivr caches the release list for a few minutes. Re-run this script shortly."
      );
    } else {
      console.log(
        `  verify:  could not read @latest (${verified.status || verified.error || "error"}).`
      );
    }
    return { ok: false, verifyFailed: true };
  }

  console.log(
    `  verify:  @latest resolves to ${verified.version} (${verified.type})`
  );

  if (!options.noState) {
    state.repos[info.fullName] = {
      commit: target,
      branch: info.defaultBranch || info.branch,
      tag: release.tag,
      purgedAt: new Date().toISOString(),
    };
  }
  return { ok: true, succeeded, skipped: skipped.length };
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
  const state = options.noState ? { version: 2, repos: {} } : loadState(options.state);
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
    const fullName = github?.fullName || path.basename(dir);

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
      console.log("Dry run: no tags were pushed, no requests were sent, state was not changed.");
    } else if (allOk) {
      console.log("Done. Reload Fontra.");
      console.log(
        'If a plugin still looks old, open DevTools -> Network -> "Disable cache" and reload,'
      );
      console.log("or use the reload button's \"Empty cache and hard reload\" option.");
    } else {
      console.log(
        "Some repositories did not finish. Check the messages above; state was not advanced for them."
      );
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
