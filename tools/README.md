# Refresh jsDelivr for all Fontra plugins

Fontra plugin addresses are two-part, like `Reponja/Fontra-thickness-heatmap`.
Fontra turns that into:

```
https://cdn.jsdelivr.net/gh/Reponja/Fontra-thickness-heatmap@latest
```

jsDelivr caches `@latest` aggressively, and **it can only purge semver
releases, not branches**. A repository without a version tag falls back to a
branch, where a purge may do nothing and the old files can stay for up to 12
hours. This helper fixes that for **every** plugin repository on your machine
in one run. Fontra keeps loading the plugins from GitHub via jsDelivr.

## Quick start

```bat
tools\purge-jsdelivr.cmd
```

or:

```bat
node tools/purge-jsdelivr.mjs
```

The workflow is:

1. Commit and push the plugin changes.
2. Run the purge helper.
3. Reload Fontra. If a plugin still looks old, open DevTools (`F12`) → Network →
   enable **Disable cache**, then reload. Or use the reload button’s **Empty
   cache and hard reload**.

## What it does

- Scans the **parent folder** of this repository (normally `Documents\GitHub`)
  for immediate subfolders containing `plugin.json`.
- Reads each repository's GitHub `origin` remote. Repositories that are not on
  GitHub are reported and skipped.
- If the pushed commit has no semver tag, creates the next patch tag (for
  example `v1.0.0`, then `v1.0.1`) at the **pushed** commit and pushes the tag.
  This is what makes `@latest` purgeable.
- Purges both `@latest` and the exact release tag.
- On the first run for a repository, purges **all tracked files**. That also
  clears caches left over from before you used this helper.
- On later runs, purges only the files changed since the last successful purge.
  `plugin.json` is always included.
- After purging, checks the `x-jsd-version` header from jsDelivr and confirms
  that `@latest` really resolves to the new release.

State is kept in:

```
%LOCALAPPDATA%\FontraPluginPurge\state.json
```

The script warns when a repository has uncommitted changes or unpushed commits.
It tags the **pushed** commit (`@{u}`), so unpushed work is never published by
the tagging step. If a repository has no upstream branch, it is skipped.

New tags can take a few minutes to appear in jsDelivr’s release list. If the
verification step says that, wait a bit and run the script again. It will reuse
the same tag and retry the purge.

## Options

```bat
node tools/purge-jsdelivr.mjs --list
node tools/purge-jsdelivr.mjs --dry-run
node tools/purge-jsdelivr.mjs --all
node tools/purge-jsdelivr.mjs --tag 1.4.0
node tools/purge-jsdelivr.mjs --no-tag
node tools/purge-jsdelivr.mjs --root C:\Users\me\Documents\GitHub
node tools/purge-jsdelivr.mjs Reponja/Fontra-thickness-heatmap
```

- `--list` — list discovered plugin repositories, their release tags, and state.
- `--dry-run` — print the release tag that would be created and the URLs that
  would be purged. Pushes no tags, sends no requests, changes no state.
- `--all` — purge every tracked file, not only files changed since the last run.
- `--tag <version>` — use this semver version instead of the next patch tag.
- `--no-tag` — never create or push tags. Only useful for repositories that
  already have semver releases, or for a best-effort branch purge.
- `--since <commit>` — purge files changed since a specific commit.
- `--force` — purge `plugin.json` even when nothing changed.
- `--refs latest,1.2.3` — override the jsDelivr refs.
- `--root <dir>` — folder containing the plugin repositories.
- `--state <file>` / `--no-state` — use a different state file, or none.
- `--delay <ms>` — delay between requests (default `120`).
- `--timeout <ms>` — per-request timeout (default `20000`).
- `--retries <n>` — retries for throttled or failed requests (default `2`).
- `--verbose` — print every purge URL and result.
- `owner/repo ...` — limit the run to those repositories.

## Notes

- Purging clears the CDN cache. Your browser can still hold its own copy, which
  is why the DevTools “Disable cache” reload matters.
- jsDelivr only serves pushed commits. Run `git push` first.
- The script never commits or pushes commits. It only pushes the release tag it
  creates, and only when `--no-tag` is not used.
- Existing non-semver tags (such as `nightly`) are ignored. The first run starts
  at `v1.0.0`.
