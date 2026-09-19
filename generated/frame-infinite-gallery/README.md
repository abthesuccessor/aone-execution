# Frame

Frame is a frontend-only inspiration gallery with a runnable Vite + React + strict TypeScript interface and 120 deterministic bundled artworks. It pages locally in groups of 12, guards stale requests, supports search/category/Saved views, and persists validated bookmarks when browser storage is available.

## Artifact map

- `spec.md`: high-level and low-level architecture, flows, invariants, failure behavior, test seams, and implementation checkpoints.
- `contracts/frame.ts`: framework-neutral TypeScript contract design for fixtures, querying, pagination, request state, failure injection, and bookmark persistence.
- `AGENTS.md`: project-local working conventions and confirmed package-script commands.
- `skills/frame-ui-motion/SKILL.md`: narrowly scoped motion guidance and pending operator checks.
- `src/data/localGalleryAdapter.ts`: deterministic asynchronous filtering, paging, failure, abort, and validation boundary.
- `src/features/gallery/`: reducer/hook orchestration and the injected observer seam.

## Environment evidence

The checked-in package manifest and portable lockfile are authoritative. Runtime dependencies are React and React DOM; Vite, TypeScript, the React plugin, type declarations, and Vitest are development dependencies. Gallery request/query ownership remains local to `useGallery`, its reducer, and the asynchronous fixture adapter; no query/cache dependency is used. This repair uses the already-present local dependencies and does not claim a fresh installation.

## Setup and checks

Use Node 24 and npm. The manifest contains the confirmed scripts:

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
```

`npm run dev` starts Vite's local development server and is an operator command; it is documented but is not run by this repair node. `npm run generate:fixtures` reproducibly regenerates `src/data/fixtures.generated.ts` and all 120 files in `public/artwork/`; it is not part of normal setup or this repair node. Current command evidence belongs in the execution receipt, not this static guide.

Automated tests cover fixture/query pagination, request and card deduplication, query-generation reset and stale suppression, same-key controller replacement, bookmarks, deterministic failure/retry, observer/manual gating, terminal data errors, and successful exhaustion. Loading skeletons, retained-card errors, search/category/Saved empty states, retry, and end messaging are implemented. Semantic controls, status regions, visible focus styles, and reduced-motion rules are implementation expectations; complete keyboard interactions, accessibility/contrast, responsive 360/768/1440 layouts, overflow, and normal/reduced-motion behavior remain pending operator browser checks.

Any supplied live-trial note remains prior operator evidence only. It is not a complete final interaction or accessibility result, and this repair node does not claim real-browser success.

## Scope

The approved MVP is a client-side gallery backed by deterministic bundled fixtures and validated browser storage. Backend services, authentication, paid services, API keys, and deployment are explicitly outside scope. See `spec.md` for the complete architecture and behavior. [AC-1, AC-3, AC-8]
