# Purge jsDelivr for all Fontra plugins

Fontra plugin addresses are two-part, like `Reponja/Fontra-thickness-heatmap`.
Fontra turns that into:

```
https://cdn.jsdelivr.net/gh/Reponja/Fontra-thickness-heatmap@latest
```

jsDelivr caches `@latest` aggressively (roughly 12 hours at the CDN, longer in
the browser), so a pushed update can keep serving the old files. This helper
fixes that for **every** plugin repository on your machine in one run. It does
not copy anything locally: Fontra keeps loading the plugins from GitHub via
jsDelivr.

## Quick start

```bat
tools\purge-jsdelivr.cmd
```

or:

```bat
node tools/purge-jsdelivr.mjs
```

Then hard-reload Fontra with `Ctrl+Shift+R`.

The workflow is:

1. Commit and push the plugin changes.
2. Run the purge helper.
3. Hard-reload Fontra.

## What it does

- Scans the **parent folder** of this repository (normally `Documents\GitHub`)
  for immediate subfolders containing `plugin.json`.
- Reads each repository's GitHub `origin` remote. Repositories that are not on
  GitHub are reported and skipped.
- Purges both `@latest` and the default branch, so the alias and the branch URL
  are both fresh.
- On the first run for a repository, purges **all tracked files**. That also
  clears caches left over from before you used this helper.
- On later runs, purges only the files changed since the last successful purge.
  `plugin.json` is always included.

State is kept in:

```
%LOCALAPPDATA%\FontraPluginPurge\state.json
```

The script warns when a repository has uncommitted changes, unpushed commits,
or is on a branch other than the default branch, because jsDelivr can only serve
what is actually pushed.

## Options

```bat
node tools/purge-jsdelivr.mjs --list
node tools/purge-jsdelivr.mjs --dry-run
node tools/purge-jsdelivr.mjs --all
node tools/purge-jsdelivr.mjs --root C:\Users\me\Documents\GitHub
node tools/purge-jsdelivr.mjs Reponja/Fontra-thickness-heatmap
```

- `--list` — list discovered plugin repositories and their state, then exit.
- `--dry-run` — print what would be purged. Sends no requests and changes no
  state.
- `--all` — purge every tracked file, not only files changed since the last run.
- `--since <commit>` — purge files changed since a specific commit.
- `--force` — purge `plugin.json` even when nothing changed.
- `--refs latest,main` — override the jsDelivr refs.
- `--root <dir>` — folder containing the plugin repositories.
- `--state <file>` / `--no-state` — use a different state file, or none.
- `--delay <ms>` — delay between requests (default `120`).
- `--timeout <ms>` — per-request timeout (default `20000`).
- `--retries <n>` — retries for throttled or failed requests (default `2`).
- `--verbose` — print every purge URL and result.
- `owner/repo ...` — limit the run to those repositories.

## Notes

- Purging clears the CDN cache. Your browser can still hold its own copy, which
  is why the hard reload matters.
- jsDelivr only serves pushed commits. Run `git push` first.
- The script never commits, pushes, or edits repositories.
