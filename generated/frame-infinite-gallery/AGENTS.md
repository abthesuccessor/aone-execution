# Frame project guidance

This file adds project-local guidance. It does not replace or weaken higher-level workspace, graph, approval, safety, or agent instructions; follow those first when they conflict.

## Current status

The workspace contains the frontend-only Vite/React/strict TypeScript implementation, deterministic fixtures, package manifests, automated tests, and documentation. Local dependencies are present, but documentation is not installation evidence. Accessibility, viewport, and complete browser interaction evaluation remain pending; never report a check as complete without an observed command or operator receipt from the responsible node. [AC-8]

## Architecture conventions

- Keep Frame frontend-only. Do not add a backend, authentication, paid services, API keys, deployment configuration, or network image dependency. [AC-1]
- Use strict TypeScript, functional React components, and functional composition. Prefer small cohesive modules and files under 300 lines where practical; explain a justified exception near the module or in the handoff. [AC-6]
- Keep reusable presentation in `src/components/`; keep stateful feature containers and hooks in `src/features/gallery/`; keep framework-neutral contracts and pure fixture/query logic in `src/domain/` or `src/data/`. Presentation components receive typed props and emit intent callbacks; they do not fetch, persist, or own query policy. [AC-4, AC-6]
- Start with React hooks plus a small local reducer and injected adapters. Add a state/query dependency only after implementation evidence shows a concrete need and record the tradeoff. [AC-4]
- Preserve stable gallery IDs across fixture generation, filtering, paging, rendering, and bookmarks. Keep fixture generation deterministic and bundled. [AC-2, AC-5]

## Accessibility and interaction expectations

- Use semantic buttons, links, navigation, search input/label, headings, and status regions. Every visible control must have a working keyboard path and an accessible name.
- Keep visible focus, readable contrast, useful loading/error/empty/end announcements, and no horizontal overflow at planned 360px, 768px, and 1440px checks.
- Keep an operable `Load more` button even when `IntersectionObserver` is available; the observer is enhancement and must be injectable for tests. [AC-5, AC-6]
- Motion is optional feedback, never the only state signal. Preserve `prefers-reduced-motion: reduce`; follow `skills/frame-ui-motion/SKILL.md`. [AC-7]

These are implementation requirements, not claims that an accessibility audit or viewport test has passed. [AC-8]

## Commands

Use Node 24 and the checked-in portable lockfile. The current manifest supports these exact commands: `npm ci`, `npm run dev`, `npm run typecheck`, `npm test`, and `npm run build`. Listing a command is not evidence it passed. `npm run dev` binds a local server and must only be run by a node that authorizes it; fixture generation is not normal setup. Record exact command receipts and do not infer install or browser success from existing `node_modules`. [AC-3, AC-6, AC-8]

## Change and verification discipline

- Make the smallest coherent change and preserve unrelated work.
- Unit-test pure query pagination, request/card deduplication, generation reset and stale suppression, failure retry/exhaustion, and bookmark parsing. Integration-test observer and manual fallback through injected seams. [AC-5]
- Request callbacks and cleanup must verify controller ownership. Reset/unmount must abort and clear the live registry so StrictMode setup-cleanup-setup can reuse a request key safely.
- A terminal data error may retain accepted cards, but it must not render or label successful exhaustion.
- Distinguish planned checks from observed results in docs and handoffs. Failed checks stay visible until corrected and rerun. [AC-8]
