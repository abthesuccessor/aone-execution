/**
 * Framework-neutral contract design for Frame.
 * This file has not yet been compiled; a later implementation node must move or
 * import it into the scaffold and produce typecheck/build receipts.
 */

export const PAGE_SIZE = 12 as const;
export const FIXTURE_ITEM_COUNT = 120 as const;

export const CATEGORIES = [
  "Architecture",
  "Editorial",
  "Identity",
  "Illustration",
  "Objects",
  "Photography",
] as const;

export type Category = (typeof CATEGORIES)[number];
export type GalleryItemId = `frame-${number}`;

export interface GalleryItem {
  readonly id: GalleryItemId;
  readonly title: string;
  readonly creator: string;
  readonly category: Category;
  /** Bundled local SVG/module URL; never a remote image-service URL. */
  readonly artworkSrc: string;
  readonly artworkAlt: string;
  readonly width: number;
  readonly height: number;
  readonly accent: `#${string}`;
}

export type GalleryView = "browse" | "saved";

export interface GalleryQuery {
  /** Trimmed, case-folded by the adapter for title/creator matching. */
  readonly search: string;
  /** null means every category. */
  readonly category: Category | null;
  readonly view: GalleryView;
  /** Sorted/deduplicated snapshot used only when view is saved. */
  readonly savedIds: readonly GalleryItemId[];
}

export interface PageRequest {
  /** Zero-based; must be a non-negative integer. */
  readonly page: number;
  readonly pageSize: typeof PAGE_SIZE;
  readonly query: GalleryQuery;
}

export interface PageResult {
  readonly items: readonly GalleryItem[];
  readonly page: number;
  readonly pageSize: typeof PAGE_SIZE;
  readonly total: number;
  readonly hasMore: boolean;
  readonly queryKey: string;
}

export type RequestErrorCode = "DEMO_FAILURE" | "ABORTED" | "DATA_INVALID";

export interface RequestError {
  readonly code: RequestErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type RequestState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly page: number; readonly requestKey: string; readonly generation: number }
  | { readonly status: "ready"; readonly lastPage: number; readonly exhausted: boolean }
  | { readonly status: "error"; readonly page: number; readonly error: RequestError; readonly generation: number };

export interface RequestContext {
  /** Incremented synchronously whenever search/category/view/saved query changes. */
  readonly generation: number;
  /** Aborted on query reset/unmount; generation comparison remains authoritative. */
  readonly signal: AbortSignal;
}

export interface GalleryDataAdapter {
  getPage(request: PageRequest, context: RequestContext): Promise<PageResult>;
}

export interface FailedPageDemo {
  readonly enabled: boolean;
  readonly page: number;
  /** Stable query key to which the demo applies; default browse query is proposed. */
  readonly queryKey: string;
  /** One mutable adapter-instance flag: false before failure, true afterward. */
  consumed: boolean;
}

export const BOOKMARK_STORAGE_KEY = "frame.bookmarks.v1" as const;

export interface BookmarkStorageV1 {
  readonly version: 1;
  readonly ids: readonly GalleryItemId[];
}

export type BookmarkParseResult =
  | { readonly ok: true; readonly value: BookmarkStorageV1 }
  | { readonly ok: false; readonly value: BookmarkStorageV1; readonly reason: "missing" | "malformed" | "invalid-shape" };

export interface BookmarkStore {
  read(): BookmarkParseResult;
  write(value: BookmarkStorageV1): void;
}

const EMPTY_BOOKMARKS: BookmarkStorageV1 = { version: 1, ids: [] };
const ID_PATTERN = /^frame-(?:[1-9]|[1-9][0-9]|1[01][0-9]|120)$/;

/** Proposed runtime boundary validator: malformed/unknown data safely becomes empty. */
export function parseBookmarkStorage(raw: string | null): BookmarkParseResult {
  if (raw === null) return { ok: false, value: EMPTY_BOOKMARKS, reason: "missing" };

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return { ok: false, value: EMPTY_BOOKMARKS, reason: "malformed" };
  }

  if (!isRecord(candidate) || candidate.version !== 1 || !Array.isArray(candidate.ids)) {
    return { ok: false, value: EMPTY_BOOKMARKS, reason: "invalid-shape" };
  }

  if (!candidate.ids.every((id): id is GalleryItemId => typeof id === "string" && ID_PATTERN.test(id))) {
    return { ok: false, value: EMPTY_BOOKMARKS, reason: "invalid-shape" };
  }

  const ids = [...new Set(candidate.ids)].sort(compareIds);
  return { ok: true, value: { version: 1, ids } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareIds(left: GalleryItemId, right: GalleryItemId): number {
  return Number(left.slice(6)) - Number(right.slice(6));
}
