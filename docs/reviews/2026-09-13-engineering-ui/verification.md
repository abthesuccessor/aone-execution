# Engineering settings UI verification

> **Screenshot evidence unavailable.** The PNG files this record cites were
> truncated to 31-364 byte stubs when this working tree was copied, and the
> originals are not recoverable. They are excluded from version control rather
> than published as evidence they can no longer support. The written findings
> and `verification.json` below are unaffected; the image links will not
> resolve.

Date: 2026-09-13. Target: the locally built workbench served by a disposable native PostgreSQL instance. The fixture used a temporary workspace, temporary skill package, temporary PostgreSQL data directory, and temporary object store. The user's `.ege` data was not used.

## Automated checks

- `npm --workspace @graph-engineering/workbench run typecheck` passed.
- `npm --workspace @graph-engineering/workbench run build` passed. Vite reported its existing large-chunk warning.
- The broader UI regression run passed 42 tests in six files: `EngineeringSettingsDialog.test.tsx`, `NodeConfiguration.test.tsx`, `CatalogPanel.test.tsx`, `engineering-settings-api.test.ts`, `api.test.ts`, and `App.test.tsx`.
- After the final Caveman wording and PostgreSQL label updates, the focused run passed 20 tests in four files: `EngineeringSettingsDialog.test.tsx`, `NodeConfiguration.test.tsx`, `engineering-settings-api.test.ts`, and `api.test.ts`.

These tests exercise complete revision-aware settings requests; preservation of unknown disabled skill IDs; Caveman enable/disable controls; context bounds; unsaved edits; failed loads; conflict recovery; reviewer selection bounds; separate review-provider selection; execution locks; and graph-save/replan preservation of the review configuration.

## Observed live UI checks

The checks below were performed in a native Chrome window before the user directed subsequent browser work to the Codex desktop browser. The screenshots are Chrome evidence, not Codex browser evidence.

1. Opened the Skills catalog and launched the real Skills & engineering settings dialog. It loaded revision 0 and the fixture skill from the local server.
2. Used the Right Arrow key from the selected Skills tab to select Harness. The expected radio group and explanation appeared.
3. Set Caveman to Full, disabled memory, set the context bound to 64,000 characters, and disabled the fixture skill. Saved successfully as revision 1.
4. Read back the settings through the disposable server API. All four settings matched the changes visible in the UI.
5. Reloaded the page and reopened the dialog from the Settings page. The persisted Full selection and revision 1 remained visible.
6. Selected Ultra locally, then simulated another settings window by sending a revision-aware API update that changed the context limit to 72,000 and advanced the server to revision 2.
7. Saved the stale UI revision. The server returned HTTP 409. The dialog retained the unsaved Ultra selection, displayed the conflict explanation, disabled saving, and offered Discard changes and reload.
8. Chose Discard changes and reload. The dialog loaded revision 2 with Full restored.

Screenshots:

- [Saved skill and compression settings](skills-saved.png)
- [Stale-revision conflict with retained choices](settings-conflict.png)

## Verification limits

The UI-focused agent stopped Chrome interaction immediately after the user's correction. Its subsequent explicit `cua.createBrowserTab('iab', ...)` attempt returned `Browser is not available: iab`. Opening the disposable page through the Codex application tool queued it to the agent's hidden task; the parent task then completed the Codex browser checks recorded below.

Live node-review editing and save/reload were not completed by the UI-focused agent. The component behavior and API preservation are covered by automated tests. No live review model, execution agent, external provider call, credential setup, or performance/token-savings comparison was run for this UI verification.

## Parent verification in Codex browser

After the parent opened the preview in the visible task, the Codex in-app browser became available. The parent completed the remaining checks there; no further Chrome interaction occurred. All four settings tabs rendered. Caveman Lite, memory enabled, context 48,000, and the enabled fixture skill saved as revision 3. The parent configured required peer review on Implementation, selected Evidence reviewer and the separate Ollama provider, saved draft 3, reloaded the page, and confirmed all three review values remained selected. The preview was marked as a deliverable.

[Codex settings screenshot](codex-settings.png) records the successful save; its captured viewport clips the right edge, so the interaction proof additionally uses the browser accessibility state. [Machine-readable verification](verification.json) distinguishes this evidence from the earlier Chrome checks. No model invocation was performed.

The full workbench suite passed 131 tests in 28 files. Desktop verification passed 10 Node tests (including a relocated packaged-runtime PostgreSQL smoke test) and 2 Rust tests; cargo check also passed.

## Final regression and migration verification

The final local-server regression suite passed all 179 tests, with zero failures, skips, or cancellations. Architecture, JSON Schema, OpenAPI, AsyncAPI, protobuf, version-lock, and PostgreSQL DDL validation passed. The production npm dependency audit reported zero advisories; this does not assess the bundled database binary or its native libraries.

Separately from the disposable UI fixture, the closed development and desktop SQLite stores were imported into their adjacent PostgreSQL directories. Development contains 2 graphs and 163 rows across 15 tables, with one source object; desktop contains 1 graph and 188 rows across 15 tables. Both imported databases were reopened through the application repository, and every imported table count was verified. The source SQLite files were preserved, and no installed desktop binary was replaced.

These checks do not establish production readiness. Current PostgreSQL patch qualification, native-library distribution obligations, application API authentication, backup/restore drills, signed packaging, and live model quality evaluation remain release work.
