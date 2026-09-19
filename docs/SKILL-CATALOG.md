# Skill catalog

The workbench routes **skill packages** — directories containing a `SKILL.md`
plus optional reference files and scripts — into agent and node context. This
document explains where that catalog comes from, why it is not in git, and how
to build your own.

## Why the catalog is not in this repository

A skill package is authored by someone. The packages an operator accumulates in
`~/.agents/skills` and `~/.codex/skills` come from many upstreams: vendor system
skills shipped with a CLI, community packages, and private in-house ones. Most
carry no licence at all.

Redistributing that mixture from a public repository would place other people's
work under this repository's MIT licence, which is not ours to do. So
`apps/desktop/resources/skills/` is `.gitignore`d. Every machine materializes
its own catalog from packages it already has the right to use.

This is a deliberate boundary, not an oversight. The ingestion tooling
(`scripts/skill-snapshot.mjs`, `scripts/ingest-skills.mjs`) *is* part of this
repository and is MIT-licensed like the rest of it.

## Building a catalog

```sh
npm run skills:ingest   # materialize the snapshot from your home folders
npm run skills:verify   # re-verify it against its manifest
```

`skills:ingest` reads `~/.agents/skills` and `~/.codex/skills`, validates every
package, and writes a snapshot to `apps/desktop/resources/skills/` together with
a `.catalog-manifest.json` recording the source-relative path, SHA-256, and
package digest of every copied file.

The import is transactional. It stages the whole tree, validates it, and only
then swaps it into place; a failure anywhere leaves the previous snapshot
untouched. It materializes symlinked directories into ordinary files and
excludes virtual environments, Python caches, and private `.env` files.

### The shrink guard

Publishing a snapshot is destructive — the previous one is renamed aside and
then deleted. If a source directory has been emptied or moved, a naive import
would silently replace a large working catalog with a nearly empty one.

`ingestSkillSnapshot` therefore refuses to shrink a catalog by half or more:

```
Error: Refusing to shrink the skill catalog from 201 packages to 7.
The existing snapshot was kept.

This usually means a source directory is empty or was moved. Sources read:
  ~/.agents/skills
  ~/.codex/skills

If the reduction is intended, re-run with EGE_SKILLS_ALLOW_SHRINK=1.
```

When the reduction is genuinely what you want:

```sh
EGE_SKILLS_ALLOW_SHRINK=1 npm run skills:ingest
```

## Running without a catalog

A catalog is optional. The app builds and runs with none — you simply get no
routed skills until you add some. Three ways to get one:

1. **`npm run skills:ingest`** — from your own home-folder packages, as above.
2. **In-app** — open **Skills** and create or import skill text directly. Edits
   are persisted as versioned overrides in the local database.
3. **`EGE_SKILLS_ROOT`** — point the runtime at any directory of `SKILL.md`
   packages at launch, without touching the build snapshot:

   ```sh
   EGE_SKILLS_ROOT=/path/to/skills npm run desktop:start
   ```

`EGE_SKILLS_SOURCE` is explicitly *not* honoured during builds: builds read the
fixed project snapshot and never silently overwrite it from home folders. Use
`skills:ingest` when you mean to refresh.

## What the build expects

`npm run desktop:build` verifies the snapshot against its manifest before
packaging. On a fresh clone with no snapshot you get an actionable error naming
the command to run, rather than a bare `ENOENT`:

```
No skill catalog snapshot found.

Expected: apps/desktop/resources/skills/.catalog-manifest.json

This directory is not tracked in git. It is built on your machine from skills
you already have, because the packages belong to their own authors and are not
redistributed here.

Build it with:

    npm run skills:ingest
```

## Validation rules

Every package is checked on ingest and again on verify:

- `SKILL.md` frontmatter must parse and carry a name and description.
- All files must stay contained within their package directory; path escapes
  are rejected.
- File counts, individual sizes, and total snapshot size are bounded
  (128 MiB / 10,000 files after exclusions).
- Package digests must match the manifest exactly.

Only the selected `SKILL.md` *instructions* enter model context. Supporting
scripts and reference files are retained as fixed package resources — ingestion
never executes them or installs their dependencies.

Skill content is instructions, not proof of completed work.
