# Frame MVP architecture specification

Status: the asynchronous gallery contract described below is implemented in `src/data/` and `src/features/gallery/`. This document is not evidence of visual quality, accessibility conformance, viewport behavior, or deployment; command results belong to the node execution receipt. [AC-8]

## 1. Evidence, decisions, and uncertainty

### Observed evidence

- `package.json`, `package-lock.json`, `src/`, and `public/artwork/` implement a Vite + React + strict TypeScript frontend with 120 bundled deterministic SVG artworks.
- `src/data/localGalleryAdapter.ts` performs asynchronous local 12-item pagination, canonical filtering/query identity, abort handling, validation, and fail-once retry behavior.
- `src/features/gallery/useGallery.ts` and `galleryReducer.ts` own query generations, request-controller identity, accepted cards, retry, and exhaustion; presentation components do not fetch or persist.
- `src/data/bookmarkStore.ts` validates and persists stable bookmark IDs through an injected storage boundary.
- Automated evidence comes from the current node's command receipt. Existing source or local dependencies alone do not prove installation, browser accessibility, viewport behavior, or complete interaction success.

### Decisions

Vite, React, TypeScript, Vitest, reducer/hooks, native browser APIs, and the local adapter are established implementation choices. Their exact versions are pinned in the portable manifests. No global state/query-cache dependency is needed because the dataset and request ownership are feature-local. [AC-3, AC-4]

### Remaining uncertainty

Complete keyboard interaction, accessibility/contrast, responsive 360/768/1440 layout, overflow, and normal/reduced-motion behavior remain pending operator browser checks. Any supplied live-trial note is prior operator evidence only, not a complete final interaction result. [AC-8]

## 2. High-level design

### 2.1 System and authority boundary [AC-1]

Frame is a frontend-only, single-browser application. Inside the boundary are React UI, local reducer/hooks, a local asynchronous adapter over bundled deterministic fixture data/artwork, and a validated localStorage adapter. Browser APIs (`localStorage`, `IntersectionObserver`, `AbortController`, timers) are untrusted/fallible platform boundaries and are wrapped behind adapters.

Explicitly outside scope: backend or server application, database, authentication/authorization, user accounts, paid service, API key, remote image/API dependency, analytics, service worker/offline synchronization, deployment, and deployment configuration. The UI cannot grant authority beyond the current browser profile; bookmarks are convenience state, not trusted records.

### 2.2 Primary user flows [AC-1, AC-5]

1. Browse: initial query loads page 0; near-bottom observation requests successive pages; `Load more` offers the same action; exhaustion displays an end state.
2. Search/filter: user searches title or creator and/or selects one category; the query generation changes, old work is cancelled/ignored, visible pages reset, and page 0 loads.
3. Save: bookmark button toggles a stable item ID, writes validated versioned storage, and immediately updates its pressed/name state.
4. Saved collection: saved navigation applies the saved-ID snapshot as part of the query and shows only saved items; no matches produces a specific saved-empty state.
5. Failure/retry: a configured page fails once per adapter lifetime; UI retains prior cards, announces an inline retryable error, and retry requests the same page. After consumption, retry succeeds.
6. Empty/end: zero filtered results shows search/filter empty; loaded count reaching filtered total shows end-of-results and disables observer/manual pagination.

Every visible control must dispatch a defined intent; decorative elements are not controls.

### 2.3 Components and directed data/control flow [AC-1, AC-4]

```text
User / browser events
  -> AppShell (layout + compact navigation rail)
  -> GalleryFeature (query + reducer + orchestration owner)
       -> GalleryControls / AppShell navigation (intent emitters)
       -> GalleryGrid -> GalleryCard / SkeletonCard (pure presentation)
       -> PageBoundary (observer adapter + always-available Load more)
       -> ResultState (error/retry, empty, exhausted announcements)
       -> GalleryDataAdapter -> deterministic fixtures + bundled artwork
       -> BookmarkStore -> validated localStorage
  <- reducer state <- generation-checked adapter results / storage outcomes
```

Data flows downward as typed props. User intent and observer callbacks flow upward. Only `GalleryFeature` initiates reads and reducer transitions. The data adapter never imports React; presentation never reads storage or pages. This directed ownership prevents a fetch/render feedback cycle. Bookmark changes in saved view are query changes by design and cause a new generation, avoiding hidden mutation of cached pages.

### 2.4 Trust and failure boundaries [AC-1, AC-5]

| Boundary | Trust stance | Failure behavior |
| --- | --- | --- |
| Bundled fixtures | Build-owned but runtime-validated in development/tests | Reject invalid IDs/count/category/artwork metadata as `DATA_INVALID`; do not render ambiguous duplicates. |
| Adapter timer/promise | May complete late or reject | Abort on reset/unmount; also reject stale generation on commit. |
| `localStorage` content | Fully untrusted, user/tool mutable | Parse as `unknown`; accept only v1 known IDs; dedupe/sort; malformed data becomes empty with non-fatal diagnostic. Writes catch quota/security exceptions and retain session state with a status message. |
| `IntersectionObserver` | Optional and timing-nondeterministic | Inject factory; manual button remains operable; absence/error does not block browsing. |
| Artwork decoding | Local but can fail | Stable aspect-ratio placeholder and alt text; paging remains usable. |
| UI boundary | No security authority | Escape-by-default React text rendering; do not accept raw HTML or remote URLs. |

Failure domains are local: a page failure does not remove accepted pages; storage failure does not stop browsing; observer failure does not stop manual loading; one artwork failure does not stop the grid.

## 3. Low-level design

The canonical contracts are defined in `contracts/frame.ts`. They include `GalleryItem`, closed `Category`, `GalleryQuery`, `PageRequest`, `PageResult`, discriminated `RequestState`, `FailedPageDemo`, `BookmarkStorageV1`/parse result, adapters, `AbortSignal`, generation tokens, `PAGE_SIZE = 12`, and `FIXTURE_ITEM_COUNT = 120`. [AC-2]

### 3.1 Implemented modules [AC-2, AC-4, AC-6]

| Module | Responsibility | Must not own |
| --- | --- | --- |
| `src/domain/gallery.ts` | Re-export framework-neutral types, constants, and bookmark parsing | React/browser APIs |
| `src/data/fixtures.generated.ts` | Exactly 120 deterministic records and bundled artwork references | Paging state |
| `src/data/localGalleryAdapter.ts` | Async filter/order/slice, fail-once injection, abort checks | React state |
| `src/data/bookmarkStore.ts` | Versioned parse/write around injected storage | Gallery query/paging |
| `src/features/gallery/galleryReducer.ts` | State machine and pure commit guards | Timers/storage calls |
| `src/features/gallery/useGallery.ts` | Effects, controllers, request map, generation orchestration | Visual markup |
| `src/features/gallery/GalleryFeature.tsx` | Compose controls/grid/status and intents | Reusable primitive styling internals |
| `src/components/*` | Reusable typed presentation | Fetch, storage, cache policy |

Keep modules under 300 lines where practical. Split fixture records/artwork generation from adapter logic. [AC-6]

### 3.2 Query and fixture invariants [AC-2, AC-5]

- Fixture IDs are unique `frame-1` through `frame-120`; array length is exactly 120; order is fixed; dimensions are positive; artwork is bundled; category belongs to the closed set.
- Normalize search with trim plus locale-stable lowercase. Match if normalized title or creator includes the term. Apply view saved-ID membership and category before search, then retain fixture order.
- Canonical query key is a collision-safe serialization of `{search, category, view, savedIds}` with saved IDs deduplicated and numerically sorted. Do not join ambiguous raw strings.
- Page is zero-based. For filtered list `F`, return `F.slice(page*12, min((page+1)*12, F.length))`; `hasMore = (page+1)*12 < F.length`; `total = F.length`. At most ten full pages exist for the unfiltered 120 items.
- A result's IDs are unique. The reducer additionally merges through a stable-ID `Set` in first-seen order, so duplicate adapter delivery cannot create duplicate cards.

### 3.3 State ownership [AC-4]

| State class | Examples | Owner/lifetime |
| --- | --- | --- |
| Ephemeral UI | controlled search value, category, view, observer gate, live-region message | component/hook; never persisted |
| Filter/search | committed search, category, browse/saved view | `GalleryFeature`; URL sync is out of MVP |
| Pagination/cache | generation, query key, accepted item array, next page, request state, controller registry | `useGallery` + reducer; cleared on query change |
| Persisted bookmarks | validated set of IDs plus write status | bookmark hook/store; localStorage v1 |

A small reducer gives atomic, auditable transitions; hooks handle side effects; injected adapters isolate platform timing. The bounded local dataset needs no global server-state library. Adding one would create dependency/invalidations cost without shared remote cache benefit. Reconsider only if implementation evidence adds multiple consumers, background synchronization, or materially more cache policy. [AC-4]

### 3.4 Request state machine and concurrency [AC-2, AC-5]

```text
idle --LOAD(p)--> loading(p)
loading(p) --RESOLVE[current generation/query]--> ready(lastPage, exhausted)
loading(p) --REJECT retryable--> error(p)
error(p) --RETRY--> loading(same p)
any --QUERY_CHANGED--> idle(new generation, empty pages)
ready(exhausted=false) --LOAD(next)--> loading(next)
ready(exhausted=true) --LOAD--> unchanged
```

Algorithm:

1. On committed query change, increment `generation` synchronously, abort and clear every registered controller, reset reducer state, derive the canonical query key, then request page 0.
2. Build the request ID as `generation + queryKey + page`. If a controller is already registered, ignore the duplicate trigger; observer and button therefore cannot duplicate work.
3. Adapter checks `signal.aborted` around asynchronous work. Every resolve/reject callback additionally requires the same live, non-aborted controller plus current generation/query identity. Final cleanup deletes only the controller it owns, so a late aborted request cannot delete a same-ID replacement.
4. Resolution dispatch includes generation, queryKey, and page. Reducer commits only when generation and queryKey equal current state and page is the expected next page (or exact failed retry). This token check remains authoritative even if abort races with promise completion.
5. Merge unique stable IDs, advance from the accepted page, and mark successful exhaustion from `!hasMore`. Errors never infer exhaustion; terminal `DATA_INVALID` retains accepted cards while suppressing end messaging.
6. Retry uses the failed page and current generation. It neither clears accepted cards nor skips ahead.

### 3.5 Deterministic failed-page demo [AC-2, AC-5]

`FailedPageDemo` is injected into each adapter instance. The GalleryFeature default enables page 2 of the canonical initial browse query. The adapter owns a single `consumed` flag. The first matching non-aborted request flips the flag and rejects with retryable `DEMO_FAILURE`; every later request, including retry, follows normal paging. Aborted work does not consume the demo. Tests inject configurations and a delay function, so no wall-clock race determines failure.

### 3.6 Bookmark persistence [AC-2, AC-4]

Storage key is `frame.bookmarks.v1`; value is `{version: 1, ids: GalleryItemId[]}`. Read JSON as `unknown`; require a plain object, exact version, array of IDs in the known 1..120 range, then dedupe and numeric-sort. Missing/malformed/invalid data returns typed empty fallback without throwing. Toggle state updates through the reducer, then serializes the normalized set. A caught write failure reports persistence unavailable but preserves the in-memory toggle for the session. The saved query uses a snapshot of this normalized set, so changing bookmarks while viewing saved causes a generation reset and removes unsaved cards deterministically.

### 3.7 IntersectionObserver and fallback seams [AC-5]

Inject `ObserverFactory` into `GalleryFeature`. Observe one sentinel with a prefetching root margin only when not loading, not errored, and not exhausted. Observer callback and `Load more` invoke the same gated `loadMore()` command. The semantic button remains present: enabled when another page can load, retry is a separate button in error, and it is disabled/labelled only for successful exhaustion. Without observer support, manual behavior is unchanged.

### 3.8 Error, empty, loading, and end rendering [AC-5, AC-6]

- Initial load: grid-sized skeletons and polite loading status.
- Next-page load: preserve cards and append skeletons.
- Retryable failure: preserve cards, inline error, focusable retry for the exact page.
- No browse matches: query-aware empty state with working clear-filters action.
- No saved items/matches: saved-specific empty state with working return-to-browse action.
- Successfully exhausted nonempty result: clear end-of-results status and label; no further requests. Fatal errors with retained cards show only the data-error state.
- Aborted/stale requests: silent non-user errors; never render their data or error.

## 4. Dependency and alternative analysis [AC-3, AC-4]

| Choice | Selected rationale | Rejected-for-now tradeoff |
| --- | --- | --- |
| Vite + React + TypeScript | Explicit requirement; focused client toolchain, functional UI composition, enforceable contracts | Handwritten bundler or another framework diverges from approved intent. |
| Reducer/hooks | Bounded feature state and explicit state machine with no extra runtime | Query library helps remote/shared caches, which do not exist here. |
| Local fixture adapter | Deterministic offline visual demo and controllable failures | Remote API/image service adds availability, privacy, key, and backend scope. |
| `Set`/`Map` by stable ID | Expected O(1) membership/deduplication and stable render identity | Repeated array scans are simpler but create avoidable duplicate/race ambiguity. |
| Abort plus generation token | Abort saves work; token prevents commits even when abort loses a race | Either mechanism alone leaves a failure mode. |

No dependency may be added solely for state, infinite scroll, persistence, fixtures, or motion without implementation evidence and approval. Use native observer/storage/abort APIs behind seams and dependency-free CSS motion. [AC-4, AC-7]

## 5. Test seams and checks [AC-5, AC-8]

Automated unit checks cover fixture count/unique IDs, query normalization/order, 12-item boundaries and totals, request/card dedupe, identity resets, stale-generation suppression, aborted same-key controller replacement, fail exactly once then retry, successful exhaustion, terminal invalid data with retained cards, and bookmark malformed/unknown-ID/dedupe/read/write-failure cases.

The injected observer/manual seam is integration-tested without installing a browser. The implementation exposes loading/empty/error/retry/end status semantics and keyboard-native buttons. Live viewport/browser checks at 360/768/1440, contrast inspection, and normal/reduced-motion observation remain for a browser-capable verification node and are not claimed here.

The manifest defines exact setup/run/check commands: `npm ci`, `npm run dev`, `npm run typecheck`, `npm test`, and `npm run build`. Command listings are not pass evidence; only observed receipts establish results. This repair node does not run `npm ci` or bind the dev server. [AC-3, AC-8]

## 6. Implementation and approval boundaries

The directed graph is acyclic: contracts/domain → data → gallery orchestration → UI composition. UI depends on domain interfaces; adapters implement them; domain never imports UI. [AC-1, AC-2, AC-4]

The implemented dependency flow remains acyclic: domain/contracts → data adapters and feature reducer/hook → presentation composition. This repair node validates typecheck, automated tests, fixture integrity, and production build. Browser/viewport/accessibility checks remain a separate operator responsibility. Deployment remains excluded and would require a new approved node. [AC-1, AC-3, AC-8]

Any backend, authentication, paid/remote service, key, telemetry, deployment, broader persistence, new dependency, or policy/approval change crosses the approved boundary and requires human authorization. Model output and this design are proposals, not approval or proof.
