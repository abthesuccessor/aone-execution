# Fixed skill ingestion verification

Date: 2026-09-12. Checkout: `Documents/ChatGPT/execution-graph-engineering`.

## Snapshot

The user authorized fixed project copies of both home-folder skill catalogs. `npm run skills:ingest` imported 201 valid packages into `apps/desktop/resources/skills`: 107 from `~/.agents/skills` and 94 from `~/.codex/skills`. Existing Agents paths and IDs are retained; Codex packages use the `codex/` prefix. The version-2 `.catalog-manifest.json` records source-relative origins, every copied file's SHA-256 and size, and package fingerprints.

The snapshot contains 2,908 files totaling 28,120,170 bytes. Thirty-three installed links were materialized as ordinary files, preserving linked reference paths. Three entries were excluded: the `markitdown/.venv` environment and Python caches in `drawio-skill/scripts` and `markitdown/scripts`. All 2,908 copied files were compared with their source files after import; their hashes matched. Original home-folder files were not edited.

Builds validate this fixed snapshot instead of refreshing it from the home folders. Refresh is explicit. Invalid imports, source escapes, conflicting paths, and packages beyond discovery limits fail before replacing the prior snapshot. Private environment files, environments, and caches are excluded. Supporting scripts are copied without execution or dependency installation. Desktop tests are restricted to `test/*.test.mjs`, so bundled example tests are not automatically executed as application tests.

## Browser and runtime checks

The workbench at `http://127.0.0.1:5189/` used the fixed default catalog with the existing local QA database. It returned 201 imported packages plus one pre-existing custom skill. Searching `codex/react-expert` displayed the fixed path, verified Codex origin, complete instructions, package fingerprint, and seven supporting files.

A temporary agent named `Skill import verification` was created through the UI with these defaults:

| Skill | Source | Stable ID |
| --- | --- | --- |
| `react-expert` | Codex | `skill_8afda63ae495e4f8` |
| `design-taste-frontend` | Agents | `skill_0b18eaba52399440` |

The API read-back and a browser reload retained both exact assignments. The temporary agent was then archived. The fixed package reader loaded both complete instruction bodies: 5,260 and 87,253 bytes respectively. No live model request or skill script execution was needed for this verification.

Browser testing exposed a stale asynchronous response when switching between Agents and Skills immediately after saving. The catalog now guards responses by section and request generation. Chat's previous 32,000-byte per-skill limit also rejected the valid imported design skill; its bounded whole-instruction handling was updated and tested separately.

Local receipts: `/tmp/ege-skills-source-receipt.json` and `/tmp/ege-skills-browser-receipt.json`. These are verification artifacts, not required runtime inputs.

## Automated checks

`npm run check` passed all contract validators, desktop checks, and 279 tests. After the browser race and larger-skill fixes, the changed server and UI suites were rerun in full. The final source has 285 passing tests: 151 server, 122 workbench, 10 desktop Node, and two Rust tests. The fixed-snapshot tests include source independence, link materialization, stable IDs and provenance, drift detection, import rollback, and complete catalog discovery. Catalog regressions cover delayed save success, save failure, and post-save reload across section changes. Chat regressions prove complete 87,253-byte skill delivery and rejection of combined-skill or whole-context overflow before provider invocation.

The immediate save-and-switch browser journey was repeated after the fix. Skills retained the correct imported React details with no stale agent content and no browser console errors. The temporary agent remains archived.

Logs: `/tmp/ege-skills-check.log`, `/tmp/ege-skills-final-server-tests.log`, and `/tmp/ege-skills-final-ui-tests.log`.

## Desktop package

`npm run desktop:make:dmg` rebuilt the final TypeScript/Vite workbench, Node sidecar, and Rust host. The packaged `.app` snapshot verifier checked all 201 skill entries and 2,908 file hashes against the current project manifest. The packaged sidecar smoke check, `hdiutil verify`, and deep strict signature verification passed.

Artifact: `Execution Graph Engineering_0.1.0_aarch64.dmg`, 54,162,154 bytes, emitted to `apps/desktop/src-tauri/target/release/bundle/dmg/`. That path is a build output and is not tracked in this repository, so the artifact exists only on the machine that produced it. The product has since been renamed to `Aone Execution`, so a rebuild emits a differently named DMG.

SHA-256: `6872c4f5174d384a62f87ea537d421219b5cee577b587be77de4bf44202a336b`.

The app is ad hoc signed and has not been notarized. Package logs: `/tmp/ege-skills-package.log`, `/tmp/ege-skills-package-verification.log`, and `/tmp/ege-skills-dmg-verification.log`.

## Boundaries

Selected `SKILL.md` instructions enter the model context. Supporting files remain fixed package resources; they are not all injected into prompts and ingestion does not provide an automatic script executor. Provider-specific tools, credentials, and language environments referenced by a skill still depend on the configured execution environment. User edits use versioned database overrides; they do not rewrite the imported base or the original home folders.
