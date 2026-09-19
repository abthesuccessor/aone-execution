# Frame generation trial — 2026-09-12

The Graph Engineering application generated **Frame**, a Vite + React + TypeScript inspiration gallery, from one idea node. The final execution completed with an accepted PASS receipt. The result is a useful frontend MVP; this trial did not demonstrate unattended generation because dependency setup and receipt recovery required operator intervention.

## Deliverable

- Source and production build: `generated/frame-infinite-gallery/`.
- Live local preview: <http://127.0.0.1:5190/> while the preview process is running.
- Application workspace: **Frame · Infinite Gallery**.
- Original execution folder: `/tmp/ege-qa-20260912/frame-infinite-gallery` (the workbench remains bound here).
- Preserved copy: 158 source/document/configuration files and 123 build files; all 281 files were byte-compared with the original. Dependencies are excluded from the copy. Run `npm ci` before local development.

The request specified 120 deterministic bundled SVG artworks, asynchronous 12-item pages, IntersectionObserver loading and a manual fallback, title/creator search, categories, Saved items with validated localStorage, skeletons, deterministic failure/retry, empty states, and exhaustion. It also required responsive layouts, strict TypeScript, small functional modules, documentation and meaningful tests. No backend, authentication, external image service, paid API or deployment was requested or added.

## Execution evidence

Graph: `79e2818d-6737-488b-8309-364291de0180`.

| Plan | Execution | Outcome |
| --- | --- | --- |
| v1 `426b4b51-3841-46a7-9abe-0e3c35c32650` | `aa4649f0-7832-465f-8ae9-f76d761048c1` | Architecture accepted. Presentation code, fixtures and build produced, but the receipt used `public/artwork/*.svg` instead of the 120 exact asset paths. Node failed manifest validation. |
| v2 `1e25b6a5-cc8a-4fc4-9695-de801db96764` | `6d9db598-32c2-45cd-a596-a8343ee0bf36` | Async behavior and 16 tests produced. Receipt included ignored `dist` paths and a corrected historical read failure among final verification gates. Validation failed; the requested pause did not become an accepted checkpoint. |
| v3 `9a6b6bb4-9960-44b6-a5f9-80afc6643ca1` | `d9b09908-3fdc-4d9c-97ef-c47f14e55185` | Targeted request-controller and error/end-state repairs, regression tests and accurate documentation. **COMPLETED**, matching source manifest and four passing verification gates. |

Final execution: 07:38:58–07:46:48 UTC. Trace: `ae629b5041f5a8ef79fdaca67d10fb92`. Approved plan SHA256: `17a4b1b52dd6a1ed1a2bc03f2042b7210ab119ca48f1f5c20b4a7ecd6e016159`.

All application code, tests, artwork and project documentation were written by the application's Codex execution adapter. The operator supplied the request, reviewed/approved plans, supplied review findings and recovery instructions, provisioned dependencies, ran independent checks, served the output and preserved the deliverable. No application behavior or UI was hand-edited outside the harness.

## Verification

The operator independently reran these commands against the final generated source on Node 24.18.0/npm 12.0.1, with exit code 0:

| Command | Observed result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm test` | 6 test files, 17 tests passed |
| `node scripts/verify-fixtures.mjs` | 120 records and 120 bundled SVGs validated |
| `npm run build` | Passed; Vite 8.2.2; JS 231.49 kB / 67.55 kB gzip, CSS 7.51 kB / 2.45 kB gzip |

Before the continuation, ordinary registry installation and a clean `npm ci --ignore-scripts` succeeded with 54 packages, replacing the first agent's links into this checkout's dependencies. The portable manifest and lockfile were preserved by subsequent nodes.

Real-browser checks covered automatic scrolling from 12 to 24 cards, the deterministic third-page failure, retry to 36 cards, combined search/category filtering and empty results, saving, reload persistence, removal, and the empty Saved view. Visual inspection covered 360px, 768px and 1440px layouts. These checks used the behavior build preceding the final two targeted repairs; the final repaired tree was checked with the automated gates above. A separate responsive iframe wrapper was used only for QA and is not part of the generated product.

The final request-controller regression exercises the registry actually used by the hook, including abort and replacement under the same key. The fatal-data regression checks that existing cards remain while successful exhaustion stays false. These tests do not constitute a mounted StrictMode integration suite. Full final-build browser regression, assistive-technology testing, contrast measurement and reduced-motion emulation remain unverified. The in-app browser connection dropped during the trial, and later native-browser contention prevented a complete final-build interaction repeat.

## Harness findings

1. Make the exact `changedFiles` contract explicit in both prompt and schema, including ignored build/dependency directories and deletions. The current schema accepts arbitrary strings while comparison requires exact paths.
2. Return bounded missing/unexpected path lists and support receipt-only correction against unchanged workspace hashes and preserved command evidence. A reporting error currently requires a new plan after partial code changes.
3. Provision a writable dependency cache, a portable lockfile and reproducible dependencies before implementation. Declare preview/network capability so agents do not repeatedly attempt blocked setup.
4. Improve stage-specific skill routing. All four original stages received the same four skills, approximately 41 KB per call, including guidance the agents had to reject as unrelated.
5. Keep source inspection, tests, browser checks and accepted execution receipts distinct. A successful build can coexist with a rejected receipt; source assertions do not establish browser behavior.

Relevant owners: `apps/local-server/src/execution_adapters.mjs` (prompt/schema, sandbox and manifest validation), `apps/local-server/src/server.mjs` (failure, pause/replan/resume lifecycle), and `apps/local-server/src/planners.mjs` (skill routing). This trial records the gaps; it does not change those harness mechanisms or weaken their verification gates.
